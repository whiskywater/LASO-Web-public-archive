# Durable LASO sessions in LASO-Web

## Production architecture

The production web process is the Python standard-library server in `server.py`.
`run.sh` and `deploy/systemd/laso-web.service` invoke Python. The browser uses a
same-origin adapter to reach LASO:

```text
Browser -> Python LASO-Web -> LASO HTTP API -> LASO-owned storage
```

LASO-Web does not connect to PostgreSQL or read LASO's database tables. LASO
owns session identity, pipeline association, ordered accepted turns, execution,
turn-to-run linkage, event journal, and context state. LASO-Web renders the
canonical API history as a chat thread. It adds no transcript database,
localStorage history, local context assembly, or process-local event bus.

LASO sessions are generic runtime sessions, not LASO-Web accounts, memberships,
or access-control identities. The configured web Basic password is a gateway
credential, not per-user authorization. The current LASO development identity
does not provide per-principal session access control; use deployment-owned
network controls and TLS, and do not expose an unauthenticated LASO API.

The browser acceptance flow against a real LASO server:

![LASO-Web durable session chat](images/durable-session-chat.png)

## API contract

The Python adapter uses a strict route/method allowlist and the actual LASO API:

* `GET /api/v1/version` for version and optional capability advertisement;
* `GET /api/v1/sessions?limit=&offset=` and `POST /api/v1/sessions`;
* `GET /api/v1/sessions/{id}`;
* `GET /api/v1/sessions/{id}/turns?limit=&offset=`;
* `POST /api/v1/sessions/{id}/turns` with an idempotency key and pipeline input;
* `GET /api/v1/sessions/{id}/events/stream`;
* `GET /api/v1/sessions/{id}/context` and `GET /api/v1/runs/{id}/context`
  for read-only generation/snapshot metadata;
* `POST /api/v1/sessions/{id}/close`.

The browser route `/sessions/<id>` reopens the same LASO resource after refresh.
The list derives a label from the first durable user input or falls back to the
pipeline/date; labels are presentation only because LASO has no rename API.
Turns use `{ "prompt": "..." }`; pipelines that require other input shapes
should use the existing workspace until a schema-aware session composer exists.
Older LASO versions without a capability list are handled as “unknown”; the
client probes the durable session API and leaves ordinary run/operator pages
available when those routes are missing.

## SSE and replay

Each browser opens its own authenticated same-origin SSE connection through
Python LASO-Web. The adapter forwards a validated numeric `Last-Event-ID`,
streams bounded event frames without storing them, and closes the upstream
request when the browser disconnects. It does not create a frontend pub/sub
layer. LASO event sequence IDs are durable, monotonically increasing per
session, and replay may duplicate an event across reconnect boundaries.

The browser cursor ignores duplicate/out-of-order IDs and unknown event types.
After an event it reloads ordered turns from LASO instead of treating event
payloads as transcript records. A full page reload starts replay from the
durable journal; it does not depend on browser memory or localStorage. Temporary
errors reconnect with backoff and honor LASO `Retry-After` admission responses.
LASO currently streams lifecycle events, not model token chunks; the UI does
not fabricate streaming output.

The composer retains the unsent draft in page memory across event-driven
rerenders and request failures. It does not make that draft or any displayed
transcript authoritative. Submission uses one idempotency key for retries of
the same uncertain request. Closed sessions retain readable history and do not
show a composer; the LASO API does not currently expose reopening.

## Context provenance

When LASO advertises context-generation/reduction features, the UI continues to
render full durable turns and tolerates richer run and event data. The adapter
allows read-only context metadata to support diagnostics, without exposing
context payloads. LASO owns full history, derived generations, run-context
snapshots, and reduction. LASO-Web neither summarizes nor trims context and
does not persist provenance separately.

## Run and browser tests

Python unit/API-security tests use the standard library:

```sh
python3 -m py_compile server.py tests/*.py
python3 -m unittest discover -s tests -v
```

The model tests and browser acceptance use Node.js 22, Playwright 1.56.1, and
Chromium; these are test-only tools, not production runtime dependencies:

```sh
npm ci
npx playwright install --with-deps chromium
npm test
npm run test:e2e
```

The browser suite launches actual `python3 server.py` processes with isolated
ports and Basic-auth browser contexts. It covers shared sessions through two
frontend processes, replay after a frontend-process interruption, deep links, closure, core
run/operator pages, mobile navigation, and outage recovery. CI has one
compatibility lane pinned to an audited LASO `main` commit and one
PostgreSQL-backed lane pinned to current LASO `main`. Details and the historical
queued-run finding are in [PostgreSQL integration](postgres-integration.md).
