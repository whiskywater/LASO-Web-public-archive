#!/usr/bin/env python3
"""Small standard-library web server and allowlisted LASO API adapter."""

from __future__ import annotations

import base64
import http.client
import hmac
import ipaddress
import json
import os
import re
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent
MAX_BODY = 1024 * 1024
MAX_RESPONSE = 4 * 1024 * 1024
REQUEST_TIMEOUT = 8
SSE_TIMEOUT = 45  # LASO emits an idle-stream heartbeat every 15 seconds.
MAX_CLIENTS = 32
ID = r"[A-Za-z0-9_.@-]{1,128}"
PAGINATION = re.compile(r"(?:limit=[1-9][0-9]{0,2}&offset=[0-9]{1,9}|offset=[0-9]{1,9}&limit=[1-9][0-9]{0,2})\Z")
ITEM_PATH = re.compile(
    rf"/api/v1/(pipelines|runs|approvals|schedules|workers|worker-jobs|worker-requests|sessions)/({ID})"
    rf"(?:/(runs|cancel|resume|events|attempts|messages|approve|reject|enable|disable|respond|answer|deny|turns|close|context|events/stream|context/generations))?\Z"
)
RUN_CONTEXT_PATH = re.compile(rf"/api/v1/runs/({ID})/context\Z")
SESSION_CONTEXT_PATH = re.compile(rf"/api/v1/sessions/({ID})/context(?:/generations)?\Z")
SESSION_TURNS_PAGE = re.compile(rf"/api/v1/sessions/({ID})/turns\Z")
SESSION_EVENTS_PAGE = re.compile(rf"/api/v1/sessions/({ID})/events\Z")
SESSION_STREAM = re.compile(rf"/api/v1/sessions/({ID})/events/stream\Z")
MAX_EVENT_FRAME = 4 * 1024 * 1024
MAX_SSE_CURSOR = (1 << 63) - 1


class WebError(Exception):
    def __init__(self, status: int, message: str, detail: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.detail = detail


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, _request, _fp, _code, _message, _headers, _new_url):
        return None


def load_env_file(path: Path = ROOT / ".env") -> None:
    """Load a deliberately small KEY=value format without shell evaluation."""
    if not path.exists():
        return
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError(f"Invalid .env line {line_number}")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            raise ValueError(f"Invalid .env key on line {line_number}")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def _is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class Config:
    laso_url: str
    bind: str
    port: int
    token: str = ""
    password: str = ""
    allowed_hosts: tuple[str, ...] = ()

    @classmethod
    def from_env(cls) -> "Config":
        raw_url = os.environ.get("LASO_URL", "http://127.0.0.1:8080").strip()
        if len(raw_url) > 2048 or any(ch.isspace() or ord(ch) < 32 or ch == "\\" for ch in raw_url):
            raise ValueError("LASO_URL contains invalid characters or exceeds 2048 characters")
        parts = urlsplit(raw_url)
        if (parts.scheme not in {"http", "https"} or not parts.hostname or parts.username
                or parts.password or parts.query or parts.fragment):
            raise ValueError("LASO_URL must be an http(s) URL without credentials, query, or fragment")
        try:
            if parts.port is not None and not 1 <= parts.port <= 65535:
                raise ValueError
        except ValueError as exc:
            raise ValueError("LASO_URL has an invalid port") from exc
        try:
            port = int(os.environ.get("LASO_WEB_PORT", "8081"))
            if not 1 <= port <= 65535:
                raise ValueError
        except ValueError as exc:
            raise ValueError("LASO_WEB_PORT must be between 1 and 65535") from exc
        bind = os.environ.get("LASO_WEB_BIND", "127.0.0.1").strip()
        if not bind or any(ch.isspace() for ch in bind):
            raise ValueError("LASO_WEB_BIND must be a host address")
        password = os.environ.get("LASO_WEB_PASSWORD", "")
        if not _is_loopback(bind) and not password:
            raise ValueError("LASO_WEB_PASSWORD is required for a non-loopback bind")
        if password and not 16 <= len(password) <= 1024:
            raise ValueError("LASO_WEB_PASSWORD must contain between 16 and 1024 characters")
        token = os.environ.get("LASO_TOKEN", "")
        if len(token) > 8192 or any(ord(ch) < 32 for ch in token):
            raise ValueError("LASO_TOKEN exceeds the credential size limit")
        allowed_hosts = tuple(host.strip().casefold() for host in os.environ.get("LASO_WEB_ALLOWED_HOSTS", "").split(",") if host.strip())
        if any(len(host) > 255 or not re.fullmatch(r"[a-z0-9.\-\[\]:]+", host) for host in allowed_hosts):
            raise ValueError("LASO_WEB_ALLOWED_HOSTS contains an invalid host entry")
        if not _is_loopback(bind) and not allowed_hosts:
            raise ValueError("LASO_WEB_ALLOWED_HOSTS is required for a non-loopback bind")
        base = urlunsplit((parts.scheme, parts.netloc, parts.path.rstrip("/"), "", ""))
        return cls(base, bind, port, token, password, allowed_hosts)


def validate_upstream_path(method: str, raw_path: str) -> str:
    """Return a valid fixed LASO route or reject; never accepts an arbitrary URL."""
    if len(raw_path) > 512 or not raw_path.startswith("/api/v1/") or "#" in raw_path:
        raise WebError(400, "Invalid LASO API route")
    path, separator, query = raw_path.partition("?")
    if re.search(r"/(?:\.{1,2})(?:/|\Z)", path):
        raise WebError(400, "Invalid LASO API route")
    paged = path in {"/api/v1/pipelines", "/api/v1/runs", "/api/v1/approvals",
                                    "/api/v1/schedules", "/api/v1/workers", "/api/v1/worker-jobs",
                                    "/api/v1/worker-requests", "/api/v1/sessions"}
    turns_page = SESSION_TURNS_PAGE.fullmatch(path) and PAGINATION.fullmatch(query)
    events_page = SESSION_EVENTS_PAGE.fullmatch(path) and re.fullmatch(r"after=(?:0|[1-9][0-9]{0,18})&limit=[1-9][0-9]{0,2}\Z", query)
    if separator and not ((paged and PAGINATION.fullmatch(query)) or turns_page or events_page):
        raise WebError(400, "Invalid LASO API query")
    if method == "GET" and path in {
        "/api/v1/health", "/api/v1/version", "/api/v1/pipelines", "/api/v1/runs",
        "/api/v1/approvals", "/api/v1/schedules", "/api/v1/workers", "/api/v1/worker-jobs",
        "/api/v1/worker-requests",
        "/api/v1/sessions",
    }:
        return raw_path
    match = ITEM_PATH.fullmatch(path)
    if match:
        collection, _item_id, action = match.groups()
        if method == "GET" and (action is None or (collection == "runs" and action in {"events", "attempts", "messages", "context"})
                                 or (collection == "sessions" and action in {"turns", "events", "context", "events/stream"})):
            return raw_path
        allowed = {
            "pipelines": {"runs"}, "runs": {"cancel", "resume"},
            "approvals": {"approve", "reject"}, "schedules": {"enable", "disable"},
            "worker-jobs": {"cancel"},
            "worker-requests": {"respond", "answer", "approve", "deny", "cancel"},
            "sessions": {"turns", "close"},
        }
        if method == "POST" and action in allowed.get(collection, set()):
            return raw_path
    if method == "POST" and path == "/api/v1/pipelines":
        return path
    if method == "POST" and path == "/api/v1/sessions":
        return path
    if method == "GET" and (RUN_CONTEXT_PATH.fullmatch(path) or (SESSION_CONTEXT_PATH.fullmatch(path) and not path.endswith("/generations"))):
        return raw_path
    raise WebError(404, "LASO API operation is not available in this adapter")


def parse_capabilities(value: object) -> dict:
    """Normalize only capabilities actually advertised by LASO; old servers stay unknown."""
    if not isinstance(value, dict) or not isinstance(value.get("capabilities"), list):
        return {"advertised": False, "capabilities": []}
    names = []
    for name in value["capabilities"]:
        if isinstance(name, str) and re.fullmatch(r"[a-z][a-z0-9]*(?:[._][a-z0-9]+)*", name) and name not in names:
            names.append(name)
    return {"advertised": True, "capabilities": names}


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Build a JSON object while rejecting ambiguous duplicate member names."""
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object member")
        result[key] = value
    return result


def _reject_json_constant(_value: str) -> None:
    """Reject Python's optional NaN/Infinity extensions to JSON."""
    raise ValueError("non-standard JSON constant")


def strict_json_loads(raw: str) -> object:
    """Decode standard JSON only, rejecting duplicate keys and non-finite numbers."""
    return json.loads(raw, object_pairs_hook=_unique_json_object, parse_constant=_reject_json_constant)


def validate_sse_cursor(cursor: str) -> str:
    if cursor and (not cursor.isdecimal() or len(cursor) > 19 or int(cursor) > MAX_SSE_CURSOR):
        raise WebError(400, "Invalid session event cursor")
    return cursor


def call_laso_stream(config: Config, path: str, last_event_id: str = ""):
    """Open a bounded-route LASO SSE stream. Caller must close both returned objects."""
    path = validate_upstream_path("GET", path)
    if not SESSION_STREAM.fullmatch(path):
        raise WebError(404, "LASO event stream is not available in this adapter")
    parts = urlsplit(config.laso_url)
    connection_type = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    connection = connection_type(parts.hostname, parts.port, timeout=SSE_TIMEOUT)
    target = parts.path.rstrip("/") + path
    headers = {"Accept": "text/event-stream", "Cache-Control": "no-cache", "User-Agent": "LASO-Web/0.1"}
    if config.token:
        headers["Authorization"] = "Bearer " + config.token
    if last_event_id:
        headers["Last-Event-ID"] = last_event_id
    try:
        connection.request("GET", target, headers=headers)
        response = connection.getresponse()
        return connection, response
    except (OSError, TimeoutError, http.client.HTTPException):
        connection.close()
        raise WebError(502, "Cannot contact LASO", "LASO event stream is unreachable") from None


def call_laso(config: Config, method: str, path: str, body: dict | None = None) -> tuple[int, object]:
    path = validate_upstream_path(method, path)
    try:
        payload = None if body is None else json.dumps(body, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError):
        raise WebError(400, "Request body is not valid JSON") from None
    headers = {"Accept": "application/json", "User-Agent": "LASO-Web/0.1"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if config.token:
        headers["Authorization"] = "Bearer " + config.token
    request = Request(config.laso_url + path, data=payload, headers=headers, method=method)
    try:
        with build_opener(NoRedirect).open(request, timeout=REQUEST_TIMEOUT) as response:
            status = response.status
            content = response.read(MAX_RESPONSE + 1)
    except HTTPError as exc:
        status = exc.code
        content = exc.read(MAX_RESPONSE + 1)
    except (URLError, TimeoutError, OSError) as exc:
        reason = "timed out" if isinstance(exc, TimeoutError) or "timed out" in str(exc).lower() else "unreachable"
        raise WebError(502, "Cannot contact LASO", f"LASO API is {reason}") from None
    if len(content) > MAX_RESPONSE:
        raise WebError(502, "LASO response exceeded the 4 MiB limit")
    try:
        value = strict_json_loads(content.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise WebError(502, "LASO returned a malformed JSON response") from None
    if not isinstance(value, (dict, list)):
        raise WebError(502, "LASO returned an unexpected response shape")
    return status, value


class Handler(BaseHTTPRequestHandler):
    server_version = "LASO-Web"
    sys_version = ""
    timeout = 15

    def _auth_ok(self) -> bool:
        password = self.server.config.password
        if not password:
            return True
        header = self.headers.get("Authorization", "")
        try:
            scheme, encoded = header.split(" ", 1)
            if scheme.lower() != "basic":
                return False
            decoded = base64.b64decode(encoded, validate=True).decode("utf-8")
            username, supplied = decoded.split(":", 1)
        except (ValueError, UnicodeDecodeError):
            return False
        return hmac.compare_digest(username, "operator") and hmac.compare_digest(supplied, password)

    def _host_ok(self) -> bool:
        host = self.headers.get("Host", "").casefold()
        return bool(host) and host in self.server.allowed_hosts

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # Clients can disappear during a timeout or upstream restart.
            pass

    def _json(self, status: int, value: object, headers: dict[str, str] | None = None) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'")
        for name, header_value in (headers or {}).items():
            if name.casefold() == "retry-after" and header_value.isdecimal() and len(header_value) <= 8:
                self.send_header("Retry-After", header_value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _authorized(self) -> bool:
        if self._auth_ok():
            return True
        body = json.dumps({"error": "Authentication required"}).encode("utf-8")
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="LASO-Web", charset="UTF-8"')
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass
        return False

    def do_GET(self) -> None:  # noqa: N802
        if not self._host_ok():
            self._json(421, {"error": "Host is not allowed"})
            return
        if not self._authorized():
            return
        if self.path == "/":
            content = (ROOT / "static" / "index.html").read_bytes()
            self._send(200, content, "text/html; charset=utf-8")
            return
        if self.path == "/sessions/new" or re.fullmatch(rf"/sessions/{ID}", self.path):
            self._send(200, (ROOT / "static" / "session.html").read_bytes(), "text/html; charset=utf-8")
            return
        static_types = {
            "/app.js": "text/javascript; charset=utf-8", "/model.js": "text/javascript; charset=utf-8",
            "/sessions.js": "text/javascript; charset=utf-8", "/session.js": "text/javascript; charset=utf-8",
            "/session-model.js": "text/javascript; charset=utf-8", "/capabilities.js": "text/javascript; charset=utf-8",
            "/style.css": "text/css; charset=utf-8", "/session.css": "text/css; charset=utf-8",
            "/session-mobile.css": "text/css; charset=utf-8",
        }
        if self.path in static_types:
            name = self.path[1:]
            self._send(200, (ROOT / "static" / name).read_bytes(), static_types[self.path])
            return
        if self.path == "/api/laso/capabilities":
            try:
                status, version = call_laso(self.server.config, "GET", "/api/v1/version")
                if status == 404:
                    self._json(200, {"advertised": False, "capabilities": []})
                elif status >= 400:
                    self._json(502, {"error": "LASO capability discovery failed",
                                     "detail": f"LASO returned HTTP {status}"})
                else:
                    self._json(200, parse_capabilities(version))
            except WebError as exc:
                if exc.status == 404:
                    self._json(200, {"advertised": False, "capabilities": []})
                else:
                    self._json(exc.status, {"error": exc.message, "detail": exc.detail})
            return
        if self.path.startswith("/api/laso/") and self.path.endswith("/events/stream"):
            self._stream_events()
            return
        if self.path.startswith("/api/laso/"):
            try:
                path = "/api/v1/" + self.path[len("/api/laso/"):]
                status, result = call_laso(self.server.config, "GET", path)
                self._json(status, result)
            except WebError as exc:
                self._json(exc.status, {"error": exc.message, "detail": exc.detail})
            return
        self._json(404, {"error": "Not found"})

    def _stream_events(self) -> None:
        route = "/api/v1/" + self.path[len("/api/laso/"):]
        try:
            cursor = validate_sse_cursor(self.headers.get("Last-Event-ID", ""))
            validate_upstream_path("GET", route)
        except WebError as exc:
            self._json(exc.status, {"error": exc.message})
            return
        connection = response = None
        headers_sent = False
        try:
            connection, response = call_laso_stream(self.server.config, route, cursor)
            if response.status != 200:
                response.read(MAX_RESPONSE + 1)
                retry_after = response.getheader("Retry-After", "")
                self._json(response.status, {"error": "LASO event stream request failed",
                                             "detail": f"LASO returned HTTP {response.status}"},
                           {"Retry-After": retry_after})
                return
            content_type = response.getheader("Content-Type", "").split(";", 1)[0].strip().casefold()
            if content_type != "text/event-stream":
                self._json(502, {"error": "LASO returned an invalid event stream"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-store")
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Content-Security-Policy", "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            headers_sent = True
            pending = bytearray()
            while True:
                chunk = response.read1(16 * 1024)
                if not chunk:
                    break
                pending.extend(chunk)
                while b"\n\n" in pending or b"\r\n\r\n" in pending:
                    split = pending.find(b"\n\n")
                    crlf = pending.find(b"\r\n\r\n")
                    if crlf >= 0 and (split < 0 or crlf < split):
                        boundary, width = crlf, 4
                    else:
                        boundary, width = split, 2
                    frame = bytes(pending[:boundary + width])
                    del pending[:boundary + width]
                    if len(frame) > MAX_EVENT_FRAME:
                        raise WebError(502, "LASO event exceeded the 4 MiB frame limit")
                    self.wfile.write(frame)
                    self.wfile.flush()
                if len(pending) > MAX_EVENT_FRAME:
                    raise WebError(502, "LASO event exceeded the 4 MiB frame limit")
        except WebError as exc:
            if not headers_sent:
                self._json(exc.status, {"error": exc.message, "detail": exc.detail})
        except (BrokenPipeError, ConnectionResetError, OSError, http.client.HTTPException):
            pass
        finally:
            if response is not None:
                response.close()
            if connection is not None:
                connection.close()

    def do_POST(self) -> None:  # noqa: N802
        if not self._host_ok():
            self._json(421, {"error": "Host is not allowed"})
            return
        if not self._authorized():
            return
        origin = self.headers.get("Origin")
        if origin:
            parsed = urlsplit(origin)
            if not parsed.netloc or parsed.netloc.casefold() != self.headers.get("Host", "").casefold():
                self._json(403, {"error": "Cross-origin state changes are not allowed"})
                return
        if self.headers.get_content_type() != "application/json":
            self._json(415, {"error": "Content-Type must be application/json"})
            return
        try:
            lengths = self.headers.get_all("Content-Length", [])
            if self.headers.get("Transfer-Encoding") or len(lengths) != 1:
                raise WebError(400, "A single Content-Length header is required")
            length_text = lengths[0]
            if not length_text.isdecimal() or int(length_text) > MAX_BODY:
                raise WebError(413, "Request body is missing or exceeds 1 MiB")
            raw = self.rfile.read(int(length_text))
            if len(raw) != int(length_text):
                raise WebError(400, "Incomplete request body")
            body = strict_json_loads(raw.decode("utf-8"))
            if not isinstance(body, dict):
                raise WebError(400, "Request body must be a JSON object")
            path = "/api/v1/" + self.path[len("/api/laso/"):] if self.path.startswith("/api/laso/") else ""
            status, result = call_laso(self.server.config, "POST", path, body)
            self._json(status, result)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._json(400, {"error": "Malformed JSON request"})
        except WebError as exc:
            self._json(exc.status, {"error": exc.message, "detail": exc.detail})

    def log_message(self, fmt: str, *args: object) -> None:
        # Keep client addresses, paths, headers, bodies, and credentials out of logs.
        del fmt, args


class WebServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, config: Config):
        self._client_slots = threading.BoundedSemaphore(MAX_CLIENTS)
        super().__init__((config.bind, config.port), Handler)
        self.config = config
        hosts = config.allowed_hosts
        if not hosts:
            if not _is_loopback(config.bind):
                self.server_close()
                raise ValueError("Allowed hosts are required for a non-loopback bind")
            port_suffix = "" if self.server_port == 80 else f":{self.server_port}"
            hosts = tuple(f"{name}{port_suffix}" for name in ("localhost", "127.0.0.1", "[::1]"))
        self.allowed_hosts = frozenset(host.casefold() for host in hosts)

    def process_request(self, request, client_address):
        if not self._client_slots.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._client_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._client_slots.release()


def main() -> None:
    try:
        load_env_file()
        config = Config.from_env()
        server = WebServer(config)
    except (ValueError, OSError) as exc:
        raise SystemExit(f"LASO-Web configuration error: {exc}") from None
    print("LASO-Web ready", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
