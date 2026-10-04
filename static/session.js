"use strict";
const $ = (s, r = document) => r.querySelector(s);
const ID = /^[A-Za-z0-9_.@-]{1,128}$/;
const sessionID = (() => {
  if (location.pathname === "/sessions/new") return "";
  try { return decodeURIComponent(location.pathname.slice("/sessions/".length)); }
  catch { return ""; }
})();
let session = null, turns = [], pipelines = [], cursor = new window.LasoSessionModel.Cursor(), reconnectBackoff = new window.LasoSessionModel.ReconnectBackoff(), durableCursor = "0", closed = false;
let pendingTurn = null, submitting = false, closing = false, streamConnected = false, sidebarSessions = [], draftMessage = "";
let backendCapabilities = null;
let latestOffset = 0, oldestLoadedOffset = 0, moreOlder = false, sessionTitle = "";
const status = (message = "", state = "live") => {
  const node = $("#chat-status");
  node.textContent = message;
  node.dataset.state = state;
  node.classList.toggle("error", state === "error" || state === "unavailable");
};
const escText = value => String(value ?? "");

async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, { ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }, cache: "no-store" }); }
  catch { throw new Error("Cannot reach LASO-Web. It will retry the connection."); }
  const body = await response.text();
  let value;
  try { value = body ? JSON.parse(body) : {}; } catch { throw new Error(`LASO returned malformed data (${response.status}).`); }
  if (!response.ok) { const error = new Error(value.detail || value.error || `Request failed (${response.status}).`); error.status = response.status; error.retryAfter = Number(response.headers.get("Retry-After") || 0); throw error; }
  return value;
}
function values(data) { return Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : []; }
function inputText(input) {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  for (const key of ["prompt", "text", "task", "message", "instruction"]) if (typeof input[key] === "string") return input[key];
  return JSON.stringify(input, null, 2);
}
function outputText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  for (const key of ["text", "content", "answer", "summary", "output", "result", "message", "greeting"]) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return JSON.stringify(value, null, 2);
}
function titleOf(turnList, item) { return inputText(turnList[0]?.input).replace(/\s+/g, " ").slice(0, 58) || `${item.pipeline_id || "LASO session"} · ${new Date(item.created_at || Date.now()).toLocaleDateString()}`; }
function appendBubble(thread, cls, content, turn, runID = "") {
  const bubble = document.createElement("article"); bubble.className = `bubble ${cls}`;
  bubble.dataset.testid = cls === "user" ? "user-turn" : "assistant-turn";
  bubble.setAttribute("aria-label", cls === "user" ? "Your message" : "LASO response");
  const body = document.createElement("div");
  if (typeof content === "string") body.textContent = content;
  else { const pre = document.createElement("pre"); pre.textContent = JSON.stringify(content, null, 2); body.append(pre); }
  bubble.append(body);
  if (turn) {
    const meta = document.createElement("div"); meta.className = "bubble-meta";
    const time = new Date(turn.accepted_at || turn.created_at || Date.now());
    const stamp = document.createElement("span"); stamp.textContent = `${time.toLocaleString()} · ${turn.state || "accepted"}`; meta.append(stamp);
    const run = runID || turn.run_id;
    if (run) { const link = document.createElement("a"); link.href = `/#/run/${encodeURIComponent(run)}`; link.textContent = "Run details"; meta.append(link); }
    bubble.append(meta);
  }
  thread.append(bubble);
}
function renderThread() {
  const root = $("#chat-content"); root.replaceChildren();
  if (!session) return;
  const scroll = document.createElement("div"); scroll.className = "chat-scroll";
  const thread = document.createElement("div"); thread.className = "thread";
  if (moreOlder) {
    const older = document.createElement("button"); older.className = "load-older"; older.type = "button"; older.textContent = "Load earlier turns";
    older.addEventListener("click", async () => {
      older.disabled = true; const top = scroll.scrollTop, height = scroll.scrollHeight;
      try { await loadOlderTurns(); renderThread(); const nextScroll = $(".chat-scroll"); nextScroll.scrollTop = top + nextScroll.scrollHeight - height; }
      catch (error) { status(error.message, "error"); older.disabled = false; }
    });
    thread.append(older);
  }
  if (!turns.length) thread.append(Object.assign(document.createElement("p"), { className: "empty", textContent: "Send a message to start this LASO session." }));
  for (const turn of [...turns].sort((a,b) => Number(a.sequence || 0) - Number(b.sequence || 0))) {
    appendBubble(thread, "user", inputText(turn.input), turn);
    const result = turn.result;
    const output = outputText(result);
    if (output) appendBubble(thread, "assistant", output, null, turn.run_id);
    else if (["running", "queued", "claimed", "started"].includes(String(turn.state).toLowerCase())) {
      const pending = document.createElement("p"); pending.className = "turn-state"; pending.textContent = `LASO is ${turn.state}…`;
      if (turn.run_id) { const details = document.createElement("details"); details.className = "execution"; const summary = document.createElement("summary"); summary.textContent = "Execution details"; const code = document.createElement("code"); code.textContent = turn.run_id; details.append(summary, code); pending.append(details); }
      thread.append(pending);
    } else if (turn.error) appendBubble(thread, "assistant", `LASO could not complete this turn: ${turn.error}`, null, turn.run_id);
  }
  scroll.append(thread); root.append(scroll);
  if (session.state === "open") {
    const wrap = document.createElement("div"); wrap.className = "composer-wrap";
    const form = document.createElement("form");
    const input = document.createElement("textarea"); input.id = "message"; input.dataset.testid = "message-composer"; input.placeholder = "Message LASO…"; input.rows = 2; input.value = draftMessage; input.setAttribute("aria-label", "Message LASO"); input.setAttribute("aria-describedby", "composer-help");
    input.addEventListener("input", () => { draftMessage = input.value; });
    input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
    const send = document.createElement("button"); send.className = "send"; send.dataset.testid = "send-turn"; send.textContent = "Send"; send.type = "submit";
    const help = document.createElement("span"); help.id = "composer-help"; help.className = "visually-hidden"; help.textContent = "Press Enter to send. Press Shift and Enter for a new line.";
    form.append(input, send, help);
    form.addEventListener("submit", async e => {
      e.preventDefault(); const message = input.value.trim(); if (!message || submitting || session.state !== "open") return;
      draftMessage = input.value; submitting = true; send.disabled = true;
      const closeControl = $(`[data-testid="close-session"]`, wrap); if (closeControl) closeControl.disabled = true;
      status("Submitting turn to LASO…", "submitting");
      if (!pendingTurn || pendingTurn.message !== message) pendingTurn = { message, key: crypto.randomUUID() };
      try {
        const accepted = await api(`/api/laso/sessions/${encodeURIComponent(session.id)}/turns`, { method: "POST", body: JSON.stringify({ idempotency_key: pendingTurn.key, input: { prompt: message } }) });
        const known = turns.findIndex(turn => turn.id === accepted.id);
        if (known >= 0) turns[known] = accepted; else turns.push(accepted);
        pendingTurn = null; draftMessage = "";
        if (!sessionTitle || sessionTitle.startsWith(`${session.pipeline_id} ·`)) sessionTitle = inputText(accepted.input).replace(/\s+/g, " ").slice(0, 58);
        renderThread(); status("Turn accepted by LASO.", "live"); sidebarSessions = []; populateSidebar(); scheduleReload();
      } catch (error) { status(`${error.message} If you retry after an uncertain response, LASO may already have accepted it; check the history first.`, "error"); send.disabled = false; if (closeControl) closeControl.disabled = false; }
      finally { submitting = false; }
    });
    wrap.append(form); root.append(wrap); scroll.scrollTop = scroll.scrollHeight;
    const close = document.createElement("button"); close.type = "button"; close.className = "close-session"; close.dataset.testid = "close-session"; close.textContent = "Close session"; close.setAttribute("aria-label", "Close this LASO session"); close.disabled = submitting;
    close.addEventListener("click", async () => {
      if (submitting || session.state !== "open" || !window.confirm("Close this LASO session? Its history will remain available, but no more turns can be submitted.")) return;
      close.disabled = true; status("Closing LASO session…", "submitting");
      closing = true;
      try {
        await api(`/api/laso/sessions/${encodeURIComponent(session.id)}/close`, { method: "POST", body: "{}" });
        session = await api(`/api/laso/sessions/${encodeURIComponent(session.id)}`);
        closed = true; streamConnected = false; await loadTurns(); renderThread(); sidebarSessions = []; await populateSidebar(); status("Session closed. Its history remains available.", "closed");
      } catch (error) { status(`Could not close session: ${error.message}`, "error"); close.disabled = false; }
      finally { closing = false; }
    });
    wrap.append(close);
  } else {
    const closedNote = document.createElement("p"); closedNote.className = "empty"; closedNote.dataset.testid = "closed-session-note"; closedNote.setAttribute("role", "status"); closedNote.textContent = "This LASO session is closed. Its history is available, but LASO will not accept new turns."; root.append(closedNote);
  }
  document.title = `${sessionTitle || titleOf([], session)} · LASO`;
}
async function loadTurns() {
  const latest = await findLatestTurnPage();
  turns = latest.items;
  latestOffset = oldestLoadedOffset = latest.offset;
  moreOlder = oldestLoadedOffset > 0;
  const first = values(await api(`/api/laso/sessions/${encodeURIComponent(session.id)}/turns?limit=1&offset=0`));
  sessionTitle = titleOf(first, session);
}
async function fetchTurnPage(offset) {
  return values(await api(`/api/laso/sessions/${encodeURIComponent(session.id)}/turns?limit=100&offset=${offset}`));
}
async function findLatestTurnPage() {
  const first = await fetchTurnPage(0);
  if (first.length < 100) return { offset: 0, items: first };
  let low = 0, high = 1;
  while (true) {
    if (high > 1000000) throw new Error("LASO session exceeds the API history offset limit.");
    const page = await fetchTurnPage(high * 100);
    if (!page.length) break;
    low = high; high *= 2;
    if (high > 1000000) high = 1000001;
  }
  if (high > 1000000) high = 1000000;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if ((await fetchTurnPage(middle * 100)).length) low = middle;
    else high = middle;
  }
  const offset = low * 100;
  return { offset, items: await fetchTurnPage(offset) };
}
function mergeTurns(items) {
  const byID = new Map(turns.map(turn => [turn.id, turn]));
  for (const turn of items) byID.set(turn.id, turn);
  turns = [...byID.values()].sort((a,b) => Number(a.sequence || 0) - Number(b.sequence || 0));
}
async function loadOlderTurns() {
  if (!moreOlder || oldestLoadedOffset <= 0) return;
  const offset = Math.max(0, oldestLoadedOffset - 100);
  mergeTurns(await fetchTurnPage(offset));
  oldestLoadedOffset = offset;
  moreOlder = oldestLoadedOffset > 0;
}
let reloadTimer = 0;
async function loadLatestTurns() {
  const latest = await findLatestTurnPage();
  if (latest.offset > latestOffset) {
    for (let offset = latestOffset + 100; offset <= latest.offset; offset += 100) mergeTurns(await fetchTurnPage(offset));
  }
  mergeTurns(latest.items);
  latestOffset = latest.offset;
  moreOlder = oldestLoadedOffset > 0;
}
function scheduleReload() {
  if (reloadTimer) return;
  reloadTimer = setTimeout(async () => {
    reloadTimer = 0;
    const through = cursor.header() || "0";
    try {
      await loadLatestTurns(); renderThread(); sidebarSessions = []; await populateSidebar();
      if (BigInt(through) > BigInt(durableCursor)) durableCursor = through;
      if (BigInt(cursor.header() || "0") < BigInt(durableCursor)) cursor = new window.LasoSessionModel.Cursor(durableCursor);
      if (streamConnected && !submitting && !closing && session?.state === "open") status("Caught up · session history is current.", "caught-up");
    }
    catch (error) {
      const unavailable = [502, 503, 504].includes(error.status);
      status(unavailable ? "LASO is temporarily unavailable. Retrying durable history; saved history remains available." : `LASO is temporarily disconnected. Retrying durable history shortly. ${error.message}`, unavailable ? "unavailable" : "reconnecting");
      reloadTimer = setTimeout(() => { reloadTimer = 0; scheduleReload(); }, 1000);
    }
  }, 100);
}
async function streamLoop() {
  while (!closed && session?.state === "open") {
    try {
      const headers = { Accept: "text/event-stream", "Cache-Control": "no-cache" };
      if (cursor.header()) headers["Last-Event-ID"] = cursor.header();
      const response = await fetch(`/api/laso/sessions/${encodeURIComponent(session.id)}/events/stream`, { headers, cache: "no-store" });
      if (!response.ok || !response.body || !response.headers.get("Content-Type")?.startsWith("text/event-stream")) {
        const body = await response.text(); let detail = ""; try { detail = JSON.parse(body).error || ""; } catch {}
        if (response.status === 404 || response.status === 405) { compatibility("This LASO server does not support session event streaming. Upgrade LASO to a build with durable session SSE."); return; }
        const err = new Error(detail || `LASO event stream unavailable (${response.status}).`); err.status = response.status; err.retryAfter = Number(response.headers.get("Retry-After") || 0); throw err;
      }
      streamConnected = true; status("Live · connected to LASO session events.", "live"); scheduleReload();
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
      while (!closed) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          if (boundary > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("LASO event exceeded the 4 MiB frame limit."); }
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (!frame || frame.startsWith(":")) continue;
          const parsed = cursor.accept(frame); if (!parsed) continue;
          reconnectBackoff.afterEvent(parsed.event);
          scheduleReload();
          if (parsed.event?.type === "session.closed") {
            try { session = await api(`/api/laso/sessions/${encodeURIComponent(session.id)}`); await loadTurns(); }
            catch { session.state = "closed"; }
            closed = true; streamConnected = false; renderThread(); sidebarSessions = []; await populateSidebar(); status("Session closed. Its history remains available.", "closed"); break;
          }
        }
        if (buffer.length > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("LASO event exceeded the 4 MiB frame limit."); }
      }
      if (!closed) {
        try {
          const latest = await api(`/api/laso/sessions/${encodeURIComponent(session.id)}`);
          if (latest.state === "closed") { session = latest; await loadTurns(); renderThread(); closed = true; streamConnected = false; status("Session closed. Its history remains available.", "closed"); break; }
        } catch {}
        throw new Error("LASO event stream ended; reconnecting.");
      }
    } catch (error) {
      if (closed) break;
      streamConnected = false;
      if (durableCursor !== cursor.header()) cursor = new window.LasoSessionModel.Cursor(durableCursor);
      const wait = reconnectBackoff.afterFailure(error.retryAfter * 1000);
      const unavailable = [502, 503, 504].includes(error.status);
      status(unavailable ? "LASO is temporarily unavailable. Retrying the session connection; saved history remains available." : `Reconnecting to LASO in ${Math.ceil(wait / 1000)}s. Your durable history remains available.`, unavailable ? "unavailable" : "reconnecting"); await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
}
function compatibility(message) {
  const root = $("#chat-content"); root.replaceChildren();
  const box = document.createElement("article"); box.className = "compat";
  const title = document.createElement("h1"); title.textContent = "Session chat unavailable";
  const body = document.createElement("p"); body.textContent = message;
  const link = document.createElement("a"); link.href = "/"; link.textContent = "Return to the run workspace";
  box.append(title, body, link); root.append(box);
}
document.querySelector("#session-nav-toggle")?.addEventListener("click", () => {
  const layout = document.querySelector(".chat-layout");
  const toggle = document.querySelector("#session-nav-toggle");
  const open = layout?.classList.toggle("sidebar-open") || false;
  toggle?.setAttribute("aria-expanded", String(open));
  toggle?.setAttribute("aria-label", open ? "Hide session list" : "Show session list");
});
document.querySelector("#session-list")?.addEventListener("click", event => {
  if (event.target.closest("a")) {
    document.querySelector(".chat-layout")?.classList.remove("sidebar-open");
    const toggle = document.querySelector("#session-nav-toggle");
    toggle?.setAttribute("aria-expanded", "false");
    toggle?.setAttribute("aria-label", "Show session list");
  }
});
async function populateSidebar() {
  const nav = $("#session-list");
  try {
    if (!sidebarSessions.length) {
      const all = [];
      for (let offset = 0, page = 0; page < 100; page++) {
        const items = values(await api(`/api/laso/sessions?limit=100&offset=${offset}`));
        all.push(...items); if (items.length < 100) break; offset += items.length;
      }
      const items = all.sort((a,b) => Date.parse(b.updated_at || b.created_at || "") - Date.parse(a.updated_at || a.created_at || "")).slice(0,20);
      sidebarSessions = await Promise.all(items.map(async item => {
        let itemTurns = [];
        try { itemTurns = values(await api(`/api/laso/sessions/${encodeURIComponent(item.id)}/turns?limit=1&offset=0`)); } catch {}
        return { item, title: titleOf(itemTurns, item) };
      }));
    }
    renderSidebar();
  } catch {
    sidebarSessions = [];
    nav.replaceChildren(Object.assign(document.createElement("p"), { className: "muted", textContent: "LASO sessions are unavailable. Retry after the connection returns." }));
  }
}
function renderSidebar() {
  const nav = $("#session-list"); if (!nav) return;
  const query = $("#session-filter")?.value.trim().toLocaleLowerCase() || "";
  const matches = sidebarSessions.filter(({item,title}) => [title, item.id, item.pipeline_id, item.state].some(value => String(value || "").toLocaleLowerCase().includes(query)));
  nav.replaceChildren();
  for (const {item,title} of matches) {
    const link = document.createElement("a"); link.className = `session-item${item.id === sessionID ? " active" : ""}`; link.href = `/sessions/${encodeURIComponent(item.id)}`;
    link.dataset.testid = "session-item"; link.dataset.state = item.state || "open";
    if (item.id === sessionID) link.setAttribute("aria-current", "page");
    link.append(document.createTextNode(title));
    const meta = document.createElement("small"); meta.textContent = `${item.state || "open"} · ${new Date(item.updated_at || item.created_at || Date.now()).toLocaleDateString()}`; link.append(meta); nav.append(link);
  }
  if (!sidebarSessions.length) nav.append(Object.assign(document.createElement("p"), { className: "muted", textContent: "No sessions yet. Create a new chat to begin." }));
  else if (!matches.length) nav.append(Object.assign(document.createElement("p"), { className: "muted", textContent: "No recent sessions match this filter." }));
}
document.querySelector("#session-filter")?.addEventListener("input", renderSidebar);
async function newSessionPage() {
  const root = $("#chat-content");
  try {
    backendCapabilities = await window.LasoCapabilities.load();
    if (backendCapabilities.supports("sessions.durable") === false || backendCapabilities.supports("sessions.sse") === false) {
      compatibility("The connected LASO server does not advertise both sessions.durable and sessions.sse. Session chat requires durable sessions and replayable event streaming.");
      return;
    }
    await api("/api/laso/sessions?limit=1&offset=0");
    pipelines = values(await api("/api/laso/pipelines?limit=100&offset=0"));
  } catch (error) {
    compatibility(error.status === 404
      ? "This LASO server does not expose durable sessions. The run workspace remains available."
      : `LASO could not be reached (${error.message}). The run workspace remains available; retry when LASO reconnects.`);
    return;
  }
  const card = document.createElement("form"); card.className = "form-card";
  const heading = document.createElement("h1"); heading.textContent = "Start a session";
  const blurb = document.createElement("p"); blurb.textContent = "A LASO session is durable ordered execution state. Choose its pipeline; your first message will start the conversation.";
  const label = document.createElement("label"); label.textContent = "Pipeline"; label.htmlFor = "session-pipeline";
  const select = document.createElement("select"); select.id = "session-pipeline"; select.dataset.testid = "session-pipeline"; select.className = "pipeline-select"; select.required = true;
  select.add(new Option("Choose a pipeline", ""));
  pipelines.forEach(p => select.add(new Option(`${p.name || p.id} · v${p.version || 1}`, `${p.name || p.id}@${p.version || 1}`)));
  const send = document.createElement("button"); send.className = "primary"; send.textContent = "Create session";
  card.append(heading, blurb, label, select, send); root.replaceChildren(card);
  card.addEventListener("submit", async e => {
    e.preventDefault(); send.disabled = true; status("Creating LASO session…", "submitting");
    try {
      const created = await api("/api/laso/sessions", { method: "POST", body: JSON.stringify({ pipeline_id: select.value }) });
      if (!created.id || !ID.test(created.id)) throw new Error("LASO returned an invalid session ID.");
      location.assign(`/sessions/${encodeURIComponent(created.id)}`);
    } catch (error) { status(error.message, "error"); send.disabled = false; }
  });
}
async function openSession() {
  if (!ID.test(sessionID)) { compatibility("The session URL contains an invalid LASO session ID."); return; }
  try {
    backendCapabilities = await window.LasoCapabilities.load();
    if (backendCapabilities.supports("sessions.durable") === false || backendCapabilities.supports("sessions.sse") === false) {
      compatibility("The connected LASO server does not advertise both sessions.durable and sessions.sse. Session history and live updates require those capabilities.");
      return;
    }
    session = await api(`/api/laso/sessions/${encodeURIComponent(sessionID)}`);
    if (!session || session.id !== sessionID) throw new Error("LASO returned an invalid session record.");
    await loadTurns(); renderThread(); await populateSidebar();
    if (session.state === "open") streamLoop(); else status("This LASO session is closed.");
  } catch (error) {
    if (error.status === 404) compatibility("This session was not found. It may have been removed or the connected LASO server may not support durable sessions.");
    else compatibility(error.message);
  }
}
if (sessionID) openSession(); else newSessionPage().then(populateSidebar);
