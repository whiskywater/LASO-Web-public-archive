"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Cursor, parseFrame, ReconnectBackoff } = require("../static/session-model.js");

const first = parseFrame('id: 1\ndata: {"sequence":1,"type":"input.accepted"}\n\n');
assert.equal(first.id, "1");
assert.equal(first.event.type, "input.accepted");
const cursor = new Cursor();
assert.equal(cursor.header(), "");
assert.equal(cursor.accept(first).id, "1");
assert.equal(cursor.accept(first), null, "replayed delivery is deduplicated");
const unknown = cursor.accept('id: 9223372036854775807\ndata: {"sequence":9223372036854775807,"type":"future.event"}\n\n');
assert.equal(unknown.event.type, "future.event", "unknown events remain parseable and advance the cursor");
assert.equal(cursor.header(), "9223372036854775807", "int64 event IDs retain exact decimal precision");
assert.equal(cursor.accept('id: 9223372036854775807\ndata: {"type":"future.event"}\n\n'), null);
assert.equal(cursor.accept('id: 9223372036854775808\ndata: {}\n\n'), null, "out-of-range event IDs are rejected");
assert.equal(cursor.accept('id: 9223372036854775806\ndata: {}\n\n'), null, "out-of-order event is ignored");
assert.equal(cursor.accept('id: 9223372036854775807\ndata: not-json\n\n'), null, "a duplicate malformed event is not processed twice");
const malformed = new Cursor();
assert.equal(malformed.accept('id: 9\ndata: invalid-json\n\n').event, null, "malformed payload is skipped safely");
assert.equal(malformed.header(), "9", "malformed payload does not create a replay loop");
assert.equal(parseFrame(': keepalive\n\n'), null, "SSE heartbeats are ignored");
assert.equal(parseFrame('id: x\ndata: {}\n\n'), null, "malformed sequence IDs are ignored");
const backoff = new ReconnectBackoff();
assert.deepEqual([backoff.afterFailure(), backoff.afterFailure(), backoff.afterFailure()], [500, 1000, 2000],
  "repeated stream failures use exponential backoff");
assert.equal(backoff.afterEvent(null), false, "an empty or malformed event does not reset backoff");
assert.equal(backoff.afterFailure(), 4000, "a stream handshake alone does not reset backoff");
assert.equal(backoff.afterEvent({ type: "session.updated" }), true, "a valid event resets backoff");
assert.equal(backoff.afterFailure(), 500, "the next retry after a valid event starts at the initial delay");
assert.equal(backoff.afterFailure(10000), 10000, "Retry-After is still honored");
assert.equal(backoff.afterFailure(), 2000, "Retry-After does not suppress later exponential backoff");
const sessionClient = fs.readFileSync(path.join(__dirname, "../static/session.js"), "utf8");
assert.equal(/\b(?:localStorage|sessionStorage|indexedDB)\b/.test(sessionClient), false,
  "LASO remains the only durable transcript store");
console.log("session event cursor tests passed");
