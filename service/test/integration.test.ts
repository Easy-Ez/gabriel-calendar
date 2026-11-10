import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { callbackPath, digest, nonce, webhookPath } from "../src/core.js";
import type { Settings } from "../src/core.js";
import { Google } from "../src/google.js";
import { httpServer } from "../src/http.js";
import { migrate } from "../src/main.js";
import { CalendarService } from "../src/service.js";
import { observeVisibility } from "../src/visibility.js";

const calendar = "guest@example.invalid";
const invited = (id: string, title = "Synthetic meeting") => ({
  id, etag: '"v1"', summary: title, status: "confirmed",
  start: { date: "2030-01-01" }, end: { date: "2030-01-02" },
  organizer: { email: "organizer@example.invalid" },
  attendees: [
    { email: "organizer@example.invalid", organizer: true, responseStatus: "accepted" },
    { email: calendar, self: true, responseStatus: "needsAction" },
    { email: "other@example.invalid", responseStatus: "accepted" },
  ],
});

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return "http://127.0.0.1:" + address.port;
}

test("service CLI migrates and serves readiness", { skip: !process.env.GABRIEL_TEST_DATABASE_URL, timeout: 8000 }, async () => {
  const database = process.env.GABRIEL_TEST_DATABASE_URL!;
  const main = new URL("../src/main.js", import.meta.url);
  const testSession = nonce();
  const env = {
    ...process.env, DATABASE_URL: database, PUBLIC_BASE_URL: "https://calendar.example.invalid",
    GOOGLE_CLIENT_ID: "synthetic-web-client", GOOGLE_CLIENT_SECRET: nonce(), GABRIEL_DATA_KEY: nonce(),
    GABRIEL_PROJECT_SESSIONS: JSON.stringify({ guest: nonce() }),
    GABRIEL_PROJECT_SESSION_DIGESTS: JSON.stringify({ visitor: digest(testSession) }),
    HOST: "127.0.0.1",
  };
  const args = [decodeURIComponent(main.pathname)];
  const migration = spawn(process.execPath, [...args, "migrate"], { env, stdio: "ignore" });
  assert.equal((await once(migration, "exit"))[0], 0);

  // The smoke test must never start a worker against a database with existing connections.
  const db = new pg.Pool({ connectionString: database });
  try {
    assert.equal((await db.query("SELECT 1 FROM connections LIMIT 1")).rowCount, 0);
  } finally {
    await db.end();
  }
  const reservation = createServer();
  const base = await listen(reservation);
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const processEnv = { ...env, PORT: new URL(base).port };
  const child = spawn(process.execPath, args, { env: processEnv, stdio: "ignore" });
  const exited = once(child, "exit");
  try {
    let healthy: Response | undefined;
    for (let i = 0; i < 50 && child.exitCode === null; i++) {
      healthy = await fetch(base + "/healthz", { signal: AbortSignal.timeout(500) }).catch(() => undefined);
      if (healthy?.ok) break;
      await delay(50);
    }
    assert.equal(healthy?.status, 200);
    assert.deepEqual(await healthy?.json(), { status: "ok" });
    const session = await fetch(base + "/v1/connect-sessions", {
      method: "POST", headers: { Authorization: "Bearer " + testSession },
    });
    assert.equal(session.status, 201);
  } finally {
    child.kill("SIGTERM");
    assert.equal((await exited)[0], 0);
  }
});

test("Google HTTP simulation with PostgreSQL", { skip: !process.env.GABRIEL_TEST_DATABASE_URL }, async t => {
  const ajv = new Ajv2020.Ajv2020();
  addFormats.default(ajv);
  const schema = JSON.parse(await readFile(new URL("../../../spec/schema/notification.schema.json", import.meta.url), "utf8"));
  const validate = ajv.compile(schema);

  const pool = new pg.Pool({ connectionString: process.env.GABRIEL_TEST_DATABASE_URL });
  let stopDelivery = () => {};
  t.after(() => {
    stopDelivery();
    return pool.end();
  });
  await migrate(pool);
  await migrate(pool);

  const owner = nonce();
  const outsider = nonce();
  const visitor = nonce();
  const visitorCalendar = "visitor@example.invalid";
  const access = nonce();
  const refresh = nonce();
  const code = nonce();
  const config: Settings = {
    baseUrl: "https://calendar.example.invalid", googleClientId: "synthetic-web-client", googleClientSecret: nonce(),
    dataKey: randomBytes(32), projectSessions: new Map([[digest(owner), "guest"], [digest(outsider), "other"],
      [digest(visitor), "visitor"]]),
    tickMs: 5, catchupMs: 10_000, retentionMs: 60_000, renewLeadMs: 60_000,
  };
  const live = new Map([["baseline", invited("baseline")]]);
  const createdEvents = new Map<string, ReturnType<typeof invited>>();
  const changes: unknown[] = [];
  const visitorChanges: unknown[] = [];
  let hideVisitorLookup = false;
  let visitorListCalls = 0;
  const guestWrites: string[] = [];
  const watchRecords: { id: string; token: string; resource: string }[] = [];
  let base = "";
  let exchanges = 0;
  let refreshes = 0;
  let oauthChallenge = "";
  let grantRefresh = true;
  let grantFullScope = true;
  let primaryOwner = true;
  let duringExchange: (() => Promise<void>) | undefined;
  let duringBaseline: (() => Promise<void>) | undefined;
  let duringWatch: (() => Promise<void>) | undefined;
  let failBaseline = false;
  let skipVisitorSyncPush = false;
  let authorizedCalendar = calendar;
  let pageFailure = false;
  let duringPage: (() => Promise<void>) | undefined;
  let invalidateCursor = false;
  let revoke = false;
  let stopped = 0;
  let patchStatus = 200;
  let createCalls = 0;
  let failAfterCreate = false;
  let failCreatedLookup = false;
  let manageCalls = 0;
  let manageStatus = 200;
  let fakeError: unknown;
  const fake = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, "http://localhost");
      const path = url.pathname;
      const send = (data: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
      const data = async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        return Buffer.concat(chunks).toString();
      };
      if (path === "/token") {
        const params = new URLSearchParams(await data());
        assert(params.get("client_secret") === config.googleClientSecret);
        if (params.get("grant_type") === "authorization_code") {
          exchanges++;
          assert(params.get("code") === code);
          assert.equal(digest(params.get("code_verifier")!), oauthChallenge);
          assert.equal(params.get("redirect_uri"), config.baseUrl + callbackPath);
          await duringExchange?.();
          return send({
            access_token: access, expires_in: 20,
            ...(grantRefresh ? { refresh_token: refresh } : {}),
            ...(grantFullScope ? {} : { scope: "https://www.googleapis.com/auth/calendar.calendarlist.readonly" }),
          });
        }
        refreshes++;
        assert(params.get("refresh_token") === refresh);
        if (revoke) return send({ error: "invalid_grant" }, 400);
        return send({ access_token: access, expires_in: 20 });
      }
      assert(req.headers.authorization === "Bearer " + access);
      if (path === "/users/me/calendarList/primary") {
        return send({ id: authorizedCalendar, accessRole: primaryOwner ? "owner" : "reader", primary: true });
      }
      if (path === "/channels/stop") {
        const channel = JSON.parse(await data());
        assert(watchRecords.some(record => record.id === channel.id && record.resource === channel.resourceId));
        stopped++;
        return res.writeHead(204).end();
      }
      const eventsPath = "/calendars/" + encodeURIComponent(calendar) + "/events";
      const visitorPath = "/calendars/" + encodeURIComponent(visitorCalendar) + "/events";
      if (path === eventsPath + "/watch" || path === visitorPath + "/watch") {
        const watch = JSON.parse(await data());
        assert.equal(watch.address, config.baseUrl + webhookPath);
        assert.equal(watch.type, "web_hook");
        const record = { id: watch.id, token: watch.token, resource: "synthetic-resource" };
        watchRecords.push(record);
        if (path !== visitorPath + "/watch" || !skipVisitorSyncPush) {
          assert.equal((await push(record, 1, "sync")).status, 204);
        }
        await duringWatch?.();
        return send({ id: record.id, resourceId: record.resource, expiration: Date.now() + 86400_000 });
      }
      if (path === visitorPath) {
        if (url.searchParams.has("iCalUID")) {
          const uid = url.searchParams.get("iCalUID");
          const copy = visitorChanges.findLast(value => (value as { iCalUID?: string }).iCalUID === uid);
          return send({ items: copy && !hideVisitorLookup ? [copy] : [] });
        }
        visitorListCalls++;
        const cursor = Number(url.searchParams.get("syncToken"));
        return send({ items: visitorChanges.slice(cursor), nextSyncToken: String(visitorChanges.length) });
      }
      if (path.startsWith(visitorPath + "/")) {
        const id = path.split("/").at(-1);
        const copy = visitorChanges.findLast(value => (value as { id: string }).id === id);
        return copy ? send(copy) : send({}, 404);
      }
      if (path === eventsPath) {
        if (req.method === "POST") {
          createCalls++;
          const { id, summary, start, end, transparency, reminders, extendedProperties, attendees, ...other } = JSON.parse(await data());
          assert.match(id, /^[a-f0-9]{32}$/);
          assert.equal(transparency, "transparent");
          assert.deepEqual(reminders, { useDefault: false });
          assert.deepEqual(other, {});
          if (createdEvents.has(id)) return send({}, 409);
          const entry = { id, summary, start, end, status: "confirmed", etag: '"created"', iCalUID: id + "@provider.example.invalid",
            organizer: { email: calendar, self: true }, attendees: attendees ?? [], extendedProperties };
          if (attendees) {
            assert.deepEqual(attendees, [{ email: visitorCalendar }]);
            const mode = url.searchParams.get("sendUpdates");
            guestWrites.push("create:" + mode);
            if (mode === "all") visitorChanges.push({ ...entry, id: "copy" + id, organizer: { email: calendar },
              attendees: [{ email: visitorCalendar, self: true, responseStatus: "needsAction" }] });
          }
          createdEvents.set(id, entry);
          live.set(id, entry);
          changes.push(entry);
          return failAfterCreate ? send({}, 503) : send(entry);
        }
        assert.equal(url.searchParams.get("singleEvents"), "true");
        assert.equal(url.searchParams.get("showDeleted"), "true");
        const sync = url.searchParams.get("syncToken");
        if (sync && invalidateCursor) { invalidateCursor = false; return send({}, 410); }
        if (!sync) {
          await duringBaseline?.();
          if (failBaseline) return send({}, 503);
          return send({ items: [...live.values()], nextSyncToken: String(changes.length) });
        }
        const index = Number(sync);
        const page = url.searchParams.get("pageToken");
        if (page) {
          if (pageFailure) return send({}, 503);
          return send({ items: changes.slice(index + 1), nextSyncToken: String(changes.length) });
        }
        if (duringPage) {
          const fn = duringPage;
          duringPage = undefined;
          await fn();
        }
        if (changes.length - index > 1) return send({ items: changes.slice(index, index + 1), nextPageToken: "next" });
        return send({ items: changes.slice(index), nextSyncToken: String(changes.length) });
      }
      if (path.startsWith(eventsPath + "/")) {
        const id = path.split("/").at(-1)!;
        const entry = live.get(id);
        if (!entry) return send({}, 404);
        if (req.method === "GET" && failCreatedLookup && createdEvents.has(id)) return send({}, 503);
        if (req.method === "GET") return send(entry);
        if (createdEvents.has(id)) {
          manageCalls++;
          assert.equal(req.headers["if-match"], entry.etag);
          const mode = url.searchParams.get("sendUpdates");
          const withGuests = entry.attendees.length > 0;
          if (withGuests) guestWrites.push(req.method + ":" + mode);
          else assert.equal(mode, "none");
          if (manageStatus !== 200) return send({}, manageStatus);
          if (req.method === "DELETE") {
            assert.equal(await data(), "");
            live.set(id, { ...entry, status: "cancelled" });
            changes.push({ id, status: "cancelled" });
            if (withGuests && mode === "all") visitorChanges.push({ id: "copy" + id, status: "cancelled" });
            return res.writeHead(204).end();
          }
          assert.equal(req.method, "PATCH");
          const update = JSON.parse(await data());
          assert.deepEqual(Object.keys(update).sort(), ["end", "start"]);
          const changed = { ...entry, ...update, etag: '"updated"' };
          live.set(id, changed);
          changes.push(changed);
          if (withGuests && mode === "all") visitorChanges.push({ ...changed, id: "copy" + id,
            organizer: { email: calendar }, attendees: [{ email: visitorCalendar, self: true, responseStatus: "needsAction" }] });
          return send(changed);
        }
        assert.equal(req.method, "PATCH");
        assert.equal(url.searchParams.get("sendUpdates"), "none");
        assert.equal(req.headers["if-match"], entry.etag);
        const patch = JSON.parse(await data());
        assert.equal(patch.attendeesOmitted, true);
        assert.equal(patch.attendees.length, 1);
        assert.equal(patch.attendees[0].email, calendar);
        if (patchStatus !== 200) return send({}, patchStatus);
        const updated = { ...entry, etag: '"v2"', attendees: entry.attendees.map(attendee =>
          attendee.self ? { ...attendee, responseStatus: patch.attendees[0].responseStatus } : attendee) };
        live.set(id, updated);
        changes.push(updated);
        return send(updated);
      }
      assert.fail("Unexpected provider route");
    })().catch(error => {
      fakeError = error;
      res.writeHead(500).end();
    });
  });
  const provider = await listen(fake);
  t.after(() => { fake.close(); fake.closeAllConnections(); });
  const google = new Google(config, { auth: provider + "/authorize", token: provider + "/token", calendar: provider });
  let service = new CalendarService(pool, config, google);
  const serving = service;
  await serving.startDelivery();
  stopDelivery = () => serving.stopDelivery();
  const server = httpServer(serving);
  base = await listen(server);
  t.after(() => { server.close(); server.closeAllConnections(); });

  function push(watch: typeof watchRecords[number], message: number, state = "exists") {
    return fetch(base + webhookPath, { method: "POST", headers: {
      "X-Goog-Channel-Id": watch.id, "X-Goog-Channel-Token": watch.token, "X-Goog-Resource-Id": watch.resource,
      "X-Goog-Resource-State": state, "X-Goog-Message-Number": String(message),
    } });
  }

  function request(path: string, credential: string, method = "GET", body?: object, headers?: Record<string, string>) {
    return fetch(base + path, {
      method, headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json", ...headers },
      body: body && JSON.stringify(body),
    });
  }

  async function json(response: Response, status = 200): Promise<any> {
    assert.equal(response.status, status);
    assert(response.headers.has("x-request-id"));
    return response.json();
  }

  async function directWrite(result: Promise<Response>, status = 200) {
    const started = Date.now();
    const response = await result;
    const confirmation = response.headers.get("x-gabriel-google-confirmed-at");
    assert(confirmation && /^\d{13}$/.test(confirmation));
    assert(Number(confirmation) >= started && Number(confirmation) <= Date.now());
    return json(response, status);
  }

  async function begin(credential: string) {
    const { sessionId, authorizationUrl } = await json(await request("/v1/connect-sessions", credential, "POST"), 201);
    const auth = new URL(authorizationUrl);
    assert.equal(auth.searchParams.get("access_type"), "offline");
    assert.equal(auth.searchParams.get("prompt"), "select_account consent");
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
    oauthChallenge = auth.searchParams.get("code_challenge")!;
    return { path: "/v1/connect-sessions/" + sessionId, callback: base + callbackPath + "?" +
      new URLSearchParams({ code, state: auth.searchParams.get("state")! }) };
  }

  const denied = await begin(owner);
  const deniedUrl = new URL(denied.callback);
  deniedUrl.searchParams.delete("code");
  deniedUrl.searchParams.set("error", "access_denied");
  assert.equal((await json(await fetch(deniedUrl), 403)).error.code, "OAUTH_CONSENT_DENIED");
  assert.equal((await fetch(denied.callback)).status, 400);
  assert.equal((await json(await request(denied.path, owner))).oauth.phase, "failed");
  grantRefresh = false;
  assert.equal((await json(await fetch((await begin(owner)).callback), 403)).error.code, "OAUTH_OFFLINE_GRANT_MISSING");
  grantRefresh = true;
  grantFullScope = false;
  assert.equal((await json(await fetch((await begin(owner)).callback), 403)).error.code, "OAUTH_SCOPE_MISSING");
  grantFullScope = true;
  primaryOwner = false;
  assert.equal((await json(await fetch((await begin(owner)).callback), 403)).error.code, "OAUTH_PRIMARY_UNAVAILABLE");
  primaryOwner = true;
  const session = await begin(owner);
  assert.equal((await request(session.path, outsider)).status, 404);
  assert.deepEqual((await json(await request(session.path, owner))).oauth,
    { phase: "waiting_for_callback", durationMs: null });
  duringExchange = async () => {
    const processing = await json(await request(session.path, owner));
    assert.equal(processing.status, "pending");
    assert.deepEqual(processing.oauth, { phase: "processing", durationMs: null });
    await delay(10);
  };
  const callbacks = await Promise.all([fetch(session.callback), fetch(session.callback)]);
  duringExchange = undefined;
  assert.deepEqual(callbacks.map(res => res.status).sort(), [200, 400]);
  assert.equal(exchanges, 4);
  const { connectionId } = await json(await request(session.path, owner));

  const duplicate = await begin(outsider);
  assert.equal((await json(await fetch(duplicate.callback), 403)).error.code, "OAUTH_PRIMARY_IN_USE");
  assert.equal((await json(await request(duplicate.path, outsider))).status, "failed");
  authorizedCalendar = "other@example.invalid";
  const switched = await begin(owner);
  assert.equal((await json(await fetch(switched.callback), 403)).error.code, "OAUTH_PRIMARY_MISMATCH");
  assert.equal((await json(await request(switched.path, owner))).status, "failed");
  authorizedCalendar = calendar;
  const path = "/v1/connections/" + connectionId;
  assert.equal((await request(path, outsider)).status, 404);
  const reader = await json(await request(path + "/consumers", owner, "POST", {}), 201);
  const secondReader = await json(await request(path + "/consumers", owner, "POST", {}), 201);
  const capabilities = ["events.read", "events.rsvp", "events.create", "events.update", "events.cancel"];
  assert.deepEqual((await json(await request(path, reader.credential))).capabilities, capabilities);
  assert.deepEqual((await json(await request(path, secondReader.credential))).capabilities, capabilities);
  const readerPath = path + "/consumers/" + reader.consumerId;
  const secondReaderPath = path + "/consumers/" + secondReader.consumerId;
  const streamReader = await json(await request(path + "/consumers", owner, "POST", {}), 201);
  const streamPath = path + "/consumers/" + streamReader.consumerId;
  async function openStream(readerEndpoint = streamPath, credential = streamReader.credential) {
    const stop = new AbortController();
    t.after(() => stop.abort());
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await fetch(base + readerEndpoint + "/stream", {
        headers: { Authorization: "Bearer " + credential, Accept: "text/event-stream" },
        signal: stop.signal,
      });
      if (response.status !== 409 || attempt >= 20) break;
      await response.body?.cancel();
      await delay(20);
    }
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /^text\/event-stream/);
    const body = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    return {
      stop: () => stop.abort(),
      async next() {
        const deadline = setTimeout(() => stop.abort(), 2500);
        try {
          while (!buffer.includes("\n\n")) {
            const { done, value } = await body.read();
            assert(!done);
            buffer += decoder.decode(value, { stream: true });
          }
          const boundary = buffer.indexOf("\n\n");
          const frame = buffer.slice(0, boundary).split("\n");
          buffer = buffer.slice(boundary + 2);
          return { event: frame[0]!.slice(7), data: JSON.parse(frame[1]!.slice(6)) };
        } finally {
          clearTimeout(deadline);
        }
      },
    };
  }
  const poll = async () => {
    const { notifications } = await json(await request(readerPath + "/notifications", reader.credential));
    for (const notification of notifications) assert(validate(notification), JSON.stringify(validate.errors));
    return notifications;
  };
  async function timing(notice: { notificationId: string; connectionId: string }) {
    const seq = notice.notificationId.split(":")[1];
    const { rows: [record] } = await pool.query(
      `SELECT source_webhook_at, observed_at, webhooks_before_sync, webhooks_during_sync, sync_notice_count
       FROM notifications WHERE connection_id=$1 AND seq=$2`, [notice.connectionId, seq]);
    assert(record);
    return record;
  }
  const ack = (cursor: string) => request(readerPath + "/ack", reader.credential, "POST", { cursor });
  const invitations = path + "/calendars/primary/events?rsvp=needsAction";
  const rsvp = path + "/calendars/" + encodeURIComponent(calendar) + "/events/newinvite/rsvp";
  assert.equal((await request(invitations, reader.credential)).status, 409);
  const setupState = async () => (await json(await request(path, owner))).onboarding;
  const bound = await setupState();
  assert.equal(bound.stage, "waiting_for_initial_sync");
  assert(bound.oauthCallbackMs >= 8);
  assert.equal(bound.oauthCallbackMs, (await json(await request(session.path, owner))).oauth.durationMs);
  assert.equal(bound.initialSyncMs, null);
  duringBaseline = async () => {
    const initial = await setupState();
    assert.equal(initial.stage, "initial_sync");
    assert.equal(initial.initialSyncMs, null);
    assert(initial.syncQueueMs >= 0);
    await delay(10);
  };
  failBaseline = true;
  await service.tick();
  assert.equal(watchRecords.length, 0);
  assert.equal((await setupState()).stage, "initial_sync");
  failBaseline = false;
  await pool.query("UPDATE connections SET sync_retry_at=now() WHERE id=$1", [connectionId]);
  duringWatch = async () => {
    const pendingWatch = await setupState();
    assert.equal(pendingWatch.stage, "watch_registration");
    assert(pendingWatch.initialSyncMs >= 18);
    assert.equal(pendingWatch.watchRegistrationMs, null);
    assert(pendingWatch.firstWebhookMs >= 0);
    assert.equal(pendingWatch.totalMs, null);
    await delay(10);
  };
  await service.tick();
  duringBaseline = duringWatch = undefined;
  const initialTiming = await setupState();
  assert.equal(initialTiming.stage, "ready");
  assert(initialTiming.watchRegistrationMs > initialTiming.firstWebhookMs);
  assert(initialTiming.totalMs >= initialTiming.oauthCallbackMs + initialTiming.initialSyncMs);
  assert.equal(watchRecords.length, 1);
  assert.equal((await json(await request(invitations, reader.credential))).events.length, 1);
  assert.deepEqual(await poll(), []);
  await service.tick();
  const stream = await openStream();
  assert.equal((await stream.next()).event, "ready");
  assert.equal((await json(await request(streamPath + "/notifications", streamReader.credential), 409)).error.code, "READER_BUSY");
  const watch = watchRecords[0]!;
  const newInvite = invited("newinvite");
  live.set(newInvite.id, newInvite);
  changes.push(newInvite);
  await push({ ...watch, resource: "invalid-resource" }, 2);
  await push({ ...watch, token: nonce() }, 2);
  await service.tick();
  assert.deepEqual(await poll(), []);
  await push(watch, 3);
  await push(watch, 3);
  await push(watch, 2);
  await service.tick();
  const [notice] = await poll();
  assert.equal(notice.type, "invitation.received");
  const firstFrame = await stream.next();
  assert.equal(firstFrame.event, "notification");
  assert.equal(firstFrame.data.notificationId, notice.notificationId);
  const inviteTiming = await timing(notice);
  assert.equal(inviteTiming.webhooks_before_sync, "1");
  assert.equal(inviteTiming.webhooks_during_sync, "0");
  assert.equal(inviteTiming.sync_notice_count, 1);
  assert(inviteTiming.source_webhook_at instanceof Date && inviteTiming.observed_at >= inviteTiming.source_webhook_at);
  const firstCursor = firstFrame.data.cursor;
  assert(validate(firstFrame.data), JSON.stringify(validate.errors));
  stream.stop();
  const resumed = await openStream();
  assert.equal((await resumed.next()).event, "ready");
  assert.deepEqual((await resumed.next()).data, firstFrame.data);
  assert.equal((await request(streamPath + "/ack", streamReader.credential, "POST", { cursor: firstCursor })).status, 204);
  assert.equal((await poll())[0].notificationId, notice.notificationId);
  const page = await json(await request(invitations + "&limit=1", reader.credential));
  assert.equal(page.events[0].ref.eventId, "baseline");
  assert.equal((await json(await request(invitations + "&pageCursor=" + page.nextPageCursor, reader.credential)))
    .events[0].ref.eventId, "newinvite");
  assert.equal((await request(secondReaderPath + "/ack", secondReader.credential, "POST", { cursor: notice.cursor })).status, 400);
  assert.equal((await ack(notice.cursor)).status, 204);
  assert.equal((await ack(notice.cursor)).status, 204);
  assert.deepEqual(await poll(), []);
  assert.equal((await request(rsvp, owner, "PUT", { status: "tentative" })).status, 401);
  assert.equal((await request(rsvp, reader.credential, "PUT", { status: "tentative", attendee: "other@example.invalid" })).status, 400);
  assert.equal((await request(rsvp, reader.credential, "PUT", { status: "tentative" }, { "If-Match": '"stale"' })).status, 409);
  patchStatus = 503;
  assert.equal((await json(await request(rsvp, reader.credential, "PUT", { status: "tentative" }), 502)).error.code,
    "OUTCOME_UNKNOWN");
  patchStatus = 200;
  const confirmed = await json(await request(rsvp, reader.credential, "PUT", { status: "tentative" }));
  assert.equal(confirmed.myResponse, "tentative");
  assert.equal(live.get(newInvite.id)?.attendees.find(attendee => attendee.email === "other@example.invalid")?.responseStatus, "accepted");
  await service.tick();
  const [reply] = await poll();
  assert.equal(reply.type, "event.rsvp_changed");
  const noWebhook = await timing(reply);
  assert.equal(noWebhook.webhooks_before_sync, "0");
  assert.equal(noWebhook.webhooks_during_sync, "0");
  assert.equal(noWebhook.source_webhook_at, null);
  const nextFrame = await resumed.next();
  assert.equal(nextFrame.event, "notification");
  assert.equal(nextFrame.data.notificationId, reply.notificationId);
  assert.equal((await request(streamPath + "/ack", streamReader.credential, "POST", { cursor: nextFrame.data.cursor })).status, 204);
  resumed.stop();
  assert.equal((await ack(reply.cursor)).status, 204);

  // Recreate the worker to prove the next request starts from the durable Google cursor.
  service = new CalendarService(pool, config, google);
  const moved = { ...live.get(newInvite.id)!, etag: '"v3"', start: { date: "2030-01-03" }, end: { date: "2030-01-04" } };
  live.set(moved.id, moved);
  changes.push(moved, invited("anotherinvite"));
  live.set("anotherinvite", invited("anotherinvite"));
  duringPage = async () => { await push(watch, 5); };
  await push(watch, 4);
  pageFailure = true;
  await service.tick();
  assert.deepEqual(await poll(), []);
  const { rows: [partial] } = await pool.query("SELECT sync_token FROM connections WHERE id=$1", [connectionId]);
  assert.equal(partial?.sync_token, "2");
  pageFailure = false;
  duringPage = async () => { await push(watch, 6); };
  await pool.query("UPDATE connections SET sync_retry_at=now(),sync_due_at=now() WHERE id=$1", [connectionId]);
  await service.tick();
  const movedBatch = await poll();
  assert.deepEqual(movedBatch.map((item: { type: string }) => item.type), ["event.updated", "invitation.received"]);
  const ambiguous = await timing(movedBatch[0]);
  assert.equal(ambiguous.webhooks_before_sync, "2");
  assert.equal(ambiguous.webhooks_during_sync, "1");
  assert.equal(ambiguous.sync_notice_count, 2);
  assert.equal(ambiguous.source_webhook_at, null);
  assert.equal((await ack(movedBatch.at(-1).cursor)).status, 204);

  // Force renewal while the old channel is valid, then catch up without a push.
  await pool.query("UPDATE channels SET expires_at=now()+interval '30 seconds' WHERE id=$1", [watch.id]);
  await pool.query("UPDATE connections SET watch_retry_at=now(),sync_due_at=now() WHERE id=$1", [connectionId]);
  changes.push({ id: moved.id, status: "cancelled" });
  live.delete(moved.id);
  await service.tick();
  assert.equal(watchRecords.length, 2);
  await push(watch, 7);
  await push(watchRecords[1]!, 2);
  await service.tick();
  assert.deepEqual(await setupState(), initialTiming);
  const cancelled = await poll();
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].type, "event.cancelled");
  assert.equal((await ack(cancelled[0].cursor)).status, 204);

  invalidateCursor = true;
  live.delete("baseline");
  await push(watchRecords[1]!, 3);
  await service.tick();
  const gap = await poll();
  assert.equal(gap.length, 1);
  assert.equal(gap[0].type, "connection.gap");
  assert.equal((await ack(gap[0].cursor)).status, 204);
  assert.deepEqual((await json(await request(invitations, reader.credential))).events.map(
    (item: { ref: { eventId: string } }) => item.ref.eventId), ["anotherinvite"]);

  const createPath = path + "/calendars/primary/events";
  const canonicalPath = path + "/calendars/" + encodeURIComponent(calendar) + "/events";
  const input = { title: "Synthetic SDK creation", start: "2030-01-03T12:00:00+08:00",
    end: "2030-01-03T12:15:00+08:00", showAs: "free" };
  const createHeaders = { "Idempotency-Key": "synthetic-key" };
  assert.equal((await request(createPath, owner, "POST", input, createHeaders)).status, 401);
  assert.equal((await request(createPath.replace("/primary/", "/other/"), reader.credential, "POST", input, createHeaders)).status, 404);
  assert.equal((await request(createPath, reader.credential, "POST", input)).status, 400);
  for (const invalid of [{ attendees: [] }, { recurrence: [] }, { start: "2030-02-30T12:00:00Z" },
    { end: input.start }, { start: "2030-01-03T24:00:00Z" }]) {
    assert.equal((await request(createPath, reader.credential, "POST", { ...input, ...invalid }, createHeaders)).status, 400);
  }
  assert.equal(createCalls, 0);
  const createStream = await openStream(readerPath, reader.credential);
  assert.equal((await createStream.next()).event, "ready");
  const [created, retried] = await Promise.all([createPath, canonicalPath].map(async endpoint =>
    json(await request(endpoint, reader.credential, "POST", input, createHeaders), 201)));
  assert.deepEqual(created, retried);
  assert.equal(created.title, input.title);
  assert.equal(created.start.dateTime, "2030-01-03T04:00:00.000Z");
  assert.equal(createCalls, 1);
  assert.equal((await json(await request(createPath, reader.credential, "POST",
    { ...input, title: "Other request" }, createHeaders), 409)).error.code, "IDEMPOTENCY_CONFLICT");
  failAfterCreate = failCreatedLookup = true;
  const uncertainHeaders = { "Idempotency-Key": "synthetic-uncertain" };
  assert.equal((await json(await request(createPath, reader.credential, "POST", input, uncertainHeaders), 502)).error.code,
    "OUTCOME_UNKNOWN");
  failAfterCreate = failCreatedLookup = false;
  const recoveredResponse = await request(createPath, reader.credential, "POST", input, uncertainHeaders);
  assert.equal(recoveredResponse.headers.get("x-gabriel-google-confirmed-at"), null);
  const recovered = await json(recoveredResponse, 201);
  assert.notEqual(recovered.ref.eventId, created.ref.eventId);
  assert.equal(createCalls, 2);
  await push(watchRecords[1]!, 4);
  await service.tick();
  const createNotice = await createStream.next();
  const recoveredNotice = await createStream.next();
  assert.equal(createNotice.data.type, "event.created");
  assert.deepEqual(createNotice.data.ref, created.ref);
  assert.deepEqual(recoveredNotice.data.ref, recovered.ref);
  const recoveredCursor = recoveredNotice.data.cursor;
  assert(validate(recoveredNotice.data), JSON.stringify(validate.errors));
  assert.equal((await ack(recoveredCursor)).status, 204);

  const managed = canonicalPath + "/" + created.ref.eventId;
  const update = { start: "2030-01-03T12:15:00+08:00", end: "2030-01-03T12:30:00+08:00" };
  const previous = { "If-Match": created.version };
  assert.equal((await request(managed.replace(encodeURIComponent(calendar), "primary"), reader.credential,
    "PATCH", update, previous)).status, 404);
  assert.equal((await request(managed, reader.credential, "PATCH", update)).status, 400);
  for (const invalid of [{}, { start: update.start }, { ...update, attendees: [] }, { title: "" }]) {
    assert.equal((await request(managed, reader.credential, "PATCH", invalid, previous)).status, 400);
  }
  assert.equal((await request(canonicalPath + "/anotherinvite/cancel", reader.credential, "POST", {}, previous)).status, 403);
  const original = live.get(created.ref.eventId)!;
  for (const blocked of [{ recurringEventId: "series" }, { eventType: "focusTime" }, { attendeesOmitted: true }]) {
    live.set(original.id, { ...original, ...blocked });
    assert.equal((await request(managed, reader.credential, "PATCH", update, previous)).status, 403);
    assert.equal((await request(managed + "/cancel", reader.credential, "POST", {}, previous)).status, 403);
  }
  live.set(original.id, original);
  assert.equal((await json(await request(managed, reader.credential, "PATCH", update,
    { "If-Match": '"stale"' }), 409)).error.code, "VERSION_CONFLICT");
  assert.equal(manageCalls, 0);
  manageStatus = 412;
  assert.equal((await json(await request(managed, reader.credential, "PATCH", update, previous), 409)).error.code,
    "VERSION_CONFLICT");
  manageStatus = 503;
  assert.equal((await json(await request(managed + "/cancel", reader.credential, "POST", {}, previous), 502)).error.code,
    "OUTCOME_UNKNOWN");
  manageStatus = 200;
  const rescheduled = await json(await request(managed, reader.credential, "PATCH", update, previous));
  assert.equal(rescheduled.start.dateTime, "2030-01-03T04:15:00.000Z");
  assert.equal(rescheduled.end.dateTime, "2030-01-03T04:30:00.000Z");
  assert.notEqual(rescheduled.version, created.version);
  await push(watchRecords[1]!, 5);
  await service.tick();
  const movedNotice = (await createStream.next()).data;
  assert.equal(movedNotice.type, "event.updated");
  assert.deepEqual(movedNotice.ref, created.ref);
  assert.deepEqual(movedNotice.changedFields, ["start", "end"]);
  assert.equal((await ack(movedNotice.cursor)).status, 204);
  assert.equal((await request(managed + "/cancel", reader.credential, "POST", {}, previous)).status, 409);
  const currentVersion = { "If-Match": rescheduled.version };
  assert.deepEqual(await json(await request(managed + "/cancel", reader.credential, "POST", {}, currentVersion)),
    { ref: created.ref, status: "cancelled" });
  assert.equal((await request(managed + "/cancel", reader.credential, "POST", {}, currentVersion)).status, 404);
  await push(watchRecords[1]!, 6);
  await service.tick();
  const removedNotice = (await createStream.next()).data;
  assert.equal(removedNotice.type, "event.cancelled");
  assert.deepEqual(removedNotice.ref, created.ref);
  assert.equal((await ack(removedNotice.cursor)).status, 204);
  assert(validate(removedNotice), JSON.stringify(validate.errors));
  createStream.stop();

  authorizedCalendar = visitorCalendar;
  const visitorSession = await begin(visitor);
  assert.equal((await fetch(visitorSession.callback)).status, 200);
  authorizedCalendar = calendar;
  const visitorId = (await json(await request(visitorSession.path, visitor))).connectionId;
  const visitorConnection = "/v1/connections/" + visitorId;
  const visitorReader = await json(await request(visitorConnection + "/consumers", visitor, "POST", {}), 201);
  const visitorReaderPath = visitorConnection + "/consumers/" + visitorReader.consumerId;
  skipVisitorSyncPush = true;
  await service.tick();
  const visitorWatch = watchRecords.at(-1)!;
  assert.equal(watchRecords.length, 3);
  const waiting = (await json(await request(visitorConnection, visitor))).onboarding;
  assert.equal(waiting.stage, "waiting_for_webhook");
  assert.equal(waiting.firstWebhookMs, null);
  assert(waiting.watchRegistrationMs >= 0);
  assert.equal((await push(visitorWatch, 1, "sync")).status, 204);
  const visitorTiming = (await json(await request(visitorConnection, visitor))).onboarding;
  assert.equal(visitorTiming.stage, "ready");
  assert(visitorTiming.firstWebhookMs >= visitorTiming.watchRegistrationMs);
  await service.tick();
  const visitorStream = await openStream(visitorReaderPath, visitorReader.credential);
  assert.equal((await visitorStream.next()).event, "ready");
  const guests = [visitorCalendar];
  const invite = { ...input, guests, notifyGuests: true };
  const inviteKey = { "Idempotency-Key": "synthetic-guest-invite" };
  assert.equal((await request(createPath, visitorReader.credential, "POST", invite, inviteKey)).status, 401);
  for (const invalid of [{ guests }, { ...invite, guests: ["invalid@example.invalid\n"] },
    { ...invite, guests: [visitorCalendar, visitorCalendar.toUpperCase()] }, { ...invite, guests: [calendar] },
    { ...invite, notifyGuests: "yes" }]) {
    assert.equal((await request(createPath, reader.credential, "POST", { ...input, ...invalid }, inviteKey)).status, 400);
  }
  const readsBeforeInvite = visitorListCalls;
  const guestEvent = await directWrite(request(createPath, reader.credential, "POST", invite, inviteKey), 201);
  const organizerCopy = await google.readCopy(access, calendar, guestEvent.ref.eventId, AbortSignal.timeout(1000));
  assert(organizerCopy?.iCalUid);
  hideVisitorLookup = true;
  const visibility = await observeVisibility(async signal => {
    const copy = await google.findCopy(access, visitorCalendar, organizerCopy.iCalUid!, signal);
    hideVisitorLookup = false;
    return copy;
  }, value => value?.event.title === guestEvent.title, { timeoutMs: 1000, intervalMs: 5 });
  assert.equal(visibility.samples, 2);
  assert(visibility.lastAbsentAtMs !== null && visibility.firstVisibleAtMs !== null &&
    visibility.firstVisibleAtMs >= visibility.lastAbsentAtMs);
  const guestCopyId = visibility.value?.event.ref.eventId;
  assert.equal(guestCopyId, "copy" + guestEvent.ref.eventId);
  const repeated = await request(createPath, reader.credential, "POST", invite, inviteKey);
  assert.equal(repeated.headers.get("x-gabriel-google-confirmed-at"), null);
  assert.deepEqual(await json(repeated, 201), guestEvent);
  assert.equal((await json(await request(createPath, reader.credential, "POST", { ...invite, notifyGuests: false },
    inviteKey), 409)).error.code, "IDEMPOTENCY_CONFLICT");
  const guestPath = canonicalPath + "/" + guestEvent.ref.eventId;
  const guestVersion = { "If-Match": guestEvent.version };
  assert.equal((await request(guestPath, visitorReader.credential, "PATCH", { ...update, notifyGuests: true }, guestVersion)).status, 401);
  assert.equal((await request(guestPath, reader.credential, "PATCH", update, guestVersion)).status, 400);
  assert.equal((await request(guestPath + "/cancel", reader.credential, "POST", {}, guestVersion)).status, 400);
  const guestNotice = async (message: number, type: string) => {
    await push(visitorWatch, message);
    await service.tick();
    const frame = await visitorStream.next();
    assert.equal(frame.event, "notification");
    assert.equal(frame.data.type, type);
    assert.equal(frame.data.ref.eventId, "copy" + guestEvent.ref.eventId);
    const record = await timing(frame.data);
    assert.equal(record.webhooks_before_sync, "1");
    assert.equal(record.webhooks_during_sync, "0");
    assert.equal(record.sync_notice_count, 1);
    assert(record.source_webhook_at instanceof Date);
    const cursor = frame.data.cursor;
    assert(validate(frame.data), JSON.stringify(validate.errors));
    assert.equal((await request(visitorReaderPath + "/ack", visitorReader.credential, "POST", { cursor })).status, 204);
  };
  await service.tick();
  assert.equal(visitorListCalls, readsBeforeInvite);
  await guestNotice(2, "invitation.received");
  const quietMove = await json(await request(guestPath, reader.credential, "PATCH",
    { ...update, notifyGuests: false }, guestVersion));
  const guestMove = await directWrite(request(guestPath, reader.credential, "PATCH", {
    start: "2030-01-03T12:30:00+08:00", end: "2030-01-03T12:45:00+08:00", notifyGuests: true,
  }, { "If-Match": quietMove.version }));
  assert.deepEqual((await google.readCopy(access, visitorCalendar, guestCopyId!, AbortSignal.timeout(1000)))?.event.start,
    guestMove.start);
  await guestNotice(3, "event.updated");
  assert.equal((await directWrite(request(guestPath + "/cancel", reader.credential, "POST",
    { notifyGuests: true }, { "If-Match": guestMove.version }))).status, "cancelled");
  assert.equal((await google.readCopy(access, visitorCalendar, guestCopyId!, AbortSignal.timeout(1000)))?.event.status,
    "cancelled");
  assert.equal(await google.readCopy(access, visitorCalendar, "absent", AbortSignal.timeout(1000)), undefined);
  await guestNotice(4, "event.cancelled");
  visitorStream.stop();
  const quietEvent = await json(await request(createPath, reader.credential, "POST", { ...invite, notifyGuests: false },
    { "Idempotency-Key": "synthetic-quiet-invite" }), 201);
  assert.equal((await json(await request(canonicalPath + "/" + quietEvent.ref.eventId + "/cancel", reader.credential,
    "POST", { notifyGuests: false }, { "If-Match": quietEvent.version }))).status, "cancelled");
  assert.deepEqual(guestWrites, ["create:all", "PATCH:none", "PATCH:all", "DELETE:all", "create:none", "DELETE:none"]);

  await pool.query("UPDATE notifications SET observed_at=now()-interval '2 minutes' WHERE connection_id=$1", [connectionId]);
  await service.tick();
  assert.equal((await json(await request(secondReaderPath + "/notifications", secondReader.credential), 410)).error.code, "CURSOR_EXPIRED");
  assert.deepEqual(await poll(), []);
  assert(refreshes > 0);
  revoke = true;
  await push(watchRecords[1]!, 7);
  await service.tick();
  assert.equal((await request(readerPath + "/notifications", reader.credential)).status, 401);
  assert.equal((await request(createPath, reader.credential, "POST", input, createHeaders)).status, 401);
  assert.equal((await json(await request(path, owner))).status, "auth_required");

  revoke = false;
  const reconnect = await begin(owner);
  assert.equal((await fetch(reconnect.callback)).status, 200);
  assert.equal((await json(await request(reconnect.path, owner))).connectionId, connectionId);
  assert.deepEqual(await setupState(), initialTiming);
  const remainingRsvp = path + "/calendars/" + encodeURIComponent(calendar) + "/events/anotherinvite/rsvp";
  for (const status of ["accepted", "declined"]) {
    assert.equal((await json(await request(remainingRsvp, reader.credential, "PUT", { status }))).myResponse, status);
  }
  assert.equal((await request(path + "/disconnect", owner, "POST")).status, 204);
  assert(stopped > 0);
  assert.equal((await request(readerPath + "/notifications", reader.credential)).status, 401);
  assert.equal((await json(await request(path, owner))).status, "disconnected");
  assert.ifError(fakeError);
});
