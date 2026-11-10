import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { CalendarClient, CalendarError, decodeNotification } from "gabriel-calendar";

const fixture = JSON.parse(await readFile(new URL("../../../spec/fixtures/mvp.json", import.meta.url), "utf8"));
const credential = () => randomBytes(32).toString("base64url");
const isError = code => error => error instanceof CalendarError && error.code === code;

test("shared wire fixture decodes and rejects invalid envelopes", () => {
  for (const notice of Object.values(fixture.notifications)) {
    assert.deepEqual(decodeNotification(notice, fixture.connectionId), notice);
  }
  for (const notice of fixture.invalidNotifications) assert.throws(() => decodeNotification(notice), isError("INVALID_RESPONSE"));
});

async function harness(t, steps) {
  const project = credential();
  const grant = credential();
  const remaining = [...steps];
  let failure;
  const server = createServer((req, res) => {
    void (async () => {
      const step = remaining.shift();
      assert(step, "unexpected HTTP request");
      assert.equal(req.url, step.path);
      assert.equal(req.method, step.method);
      assert(req.headers.authorization === "Bearer " + (step.project ? project : grant));
      assert.equal(req.headers["if-match"], step.ifMatch);
      assert.equal(req.headers["idempotency-key"], step.idempotencyKey);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.deepEqual(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined, step.body);
      if (step.status === 0) return req.socket.destroy();
      if (step.retryAfter) res.setHeader("Retry-After", step.retryAfter);
      res.setHeader("X-Request-Id", fixture.requestId);
      if (step.stream) {
        assert.equal(req.headers.accept, "text/event-stream");
        res.setHeader("Content-Type", "text/event-stream");
        const frame = (kind, payload) => `event: ${kind}\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
        const content = ": synthetic heartbeat\r\n\r\n" + frame("ready", {}) +
          step.stream.map(key => frame("notification", fixture.notifications[key])).join("") +
          (step.streamError ? frame("error", step.streamError) : "");
        res.writeHead(step.status);
        for (let offset = 0; offset < content.length; offset += 53) res.write(content.slice(offset, offset + 53));
        return res.end();
      }
      res.setHeader("Content-Type", "application/json");
      const payload = step.grant ? { ...step.payload, credential: grant } : step.payload;
      res.writeHead(step.status).end(JSON.stringify(payload));
    })().catch(error => {
      failure = error;
      res.writeHead(500).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
    assert.ifError(failure);
    assert.equal(remaining.length, 0);
  });
  return { baseUrl: "http://127.0.0.1:" + server.address().port, project, grant };
}

test("shared SSE lifecycle, failed handler, lost ack, reconnect, gaps and writes", { timeout: 8000 }, async t => {
  const { baseUrl, project, grant } = await harness(t, fixture.steps);
  const client = await CalendarClient.connect({
    baseUrl, getProjectCredential: () => project,
    openBrowser: url => assert.equal(url, "https://consent.example.invalid/authorize"),
    saveGrant: saved => assert(saved.credential === grant),
  });
  assert.equal(client.consumerId, fixture.consumerId);
  const { notifyGuests, ...createInput } = fixture.createInput;
  const createOptions = { idempotencyKey: fixture.createKey, notifyGuests };
  await assert.rejects(client.events.create("primary", createInput, { idempotencyKey: fixture.createKey }),
    isError("INVALID_ARGUMENT"));
  const created = await client.events.create("primary", createInput, createOptions);
  assert.equal(created.title, fixture.createInput.title);
  assert.equal(created.ref.eventId, "syntheticcreated");
  await assert.rejects(client.events.create("primary", { ...createInput, title: "Changed appointment" }, createOptions),
    isError("IDEMPOTENCY_CONFLICT"));
  await assert.rejects(client.events.update(created.ref, { start: fixture.updateInput.start }, { ifMatch: created.version }),
    isError("INVALID_ARGUMENT"));
  const updated = await client.events.update(created.ref, fixture.updateInput, { ifMatch: created.version, notifyGuests: false });
  assert.equal(updated.start.dateTime, fixture.updateInput.start);
  await assert.rejects(client.events.cancel(created.ref, { ifMatch: created.version, notifyGuests: true }), isError("VERSION_CONFLICT"));
  assert.equal((await client.events.cancel(updated.ref, { ifMatch: updated.version, notifyGuests: true })).status, "cancelled");
  const { events: [event] } = await client.events.listInvitations();
  assert.equal(event.myResponse, "needsAction");
  const reply = await client.events.rsvp(event.ref, "tentative", { ifMatch: event.version });
  assert.equal(reply.myResponse, "tentative");
  await assert.rejects(client.events.rsvp(event.ref, "tentative", { ifMatch: '"stale"' }), error => {
    assert(isError("VERSION_CONFLICT")(error));
    assert.equal(error.requestId, fixture.requestId);
    return true;
  });
  const retries = [];
  const processed = [];
  let first = true;
  client.on("connection.reconnecting", event => { retries.push([event.code, event.delayMs]); });
  client.on("invitation.received", event => {
    if (first) { first = false; throw new Error("Synthetic handler failure"); }
    processed.push(event.notificationId);
  });
  client.on("event.rsvp_changed", event => { processed.push(event.notificationId); });
  let resolveGap;
  const gap = new Promise(resolve => { resolveGap = resolve; });
  client.on("connection.gap", event => {
    if (event.reason === "provider_cursor_expired") processed.push(event.notificationId);
    else resolveGap(event);
  });
  await client.start();
  assert.equal((await gap).error.code, "CURSOR_EXPIRED");
  await client.stop();
  assert.deepEqual(retries, fixture.expectedRetries);
  assert.deepEqual(processed, Object.values(fixture.notifications).filter(event => event.type !== "event.cancelled")
    .map(event => event.notificationId));
});

test("initial auth failure surfaces a typed error", { timeout: 3000 }, async t => {
  const { connectionId, consumerId } = fixture;
  const path = `/v1/connections/${connectionId}/consumers/${consumerId}/stream`;
  const { baseUrl, grant } = await harness(t, [{ method: "GET", path, status: 401, payload: fixture.authError }]);
  const client = new CalendarClient({ baseUrl, connectionId, consumerId, getCredential: () => grant });
  let auth;
  client.on("auth.required", ({ error }) => { auth = error.code; });
  await assert.rejects(client.start(), isError("AUTH_REQUIRED"));
  assert.equal(auth, "AUTH_REQUIRED");
});

test("stop drains the current handler and leaves the remaining frames unacknowledged", { timeout: 3000 }, async t => {
  const { connectionId, consumerId } = fixture;
  const { baseUrl, grant } = await harness(t, fixture.drainSteps);
  const client = new CalendarClient({ baseUrl, connectionId, consumerId, getCredential: () => grant });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let signalEntered;
  const entered = new Promise(resolve => { signalEntered = resolve; });
  client.on("invitation.received", async () => { signalEntered(); await blocked; });
  let second = false;
  client.on("event.rsvp_changed", () => { second = true; });
  await client.start();
  await entered;
  const drained = client.stop();
  release();
  await drained;
  assert.equal(second, false);
});
