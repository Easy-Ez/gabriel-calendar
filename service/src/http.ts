import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, calendarId, callbackPath, eventId, log, opaque, record, text, uuid, webhookPath } from "./core.js";
import { createInput, guestNotification, responses, updateInput, validVersion } from "./google.js";
import type { GoogleWrite, Rsvp } from "./google.js";
import type { CalendarService } from "./service.js";

const bodyLimit = 6144;
type Reply = { status: number; body?: object | string; googleConfirmedAt?: number };
const ok = (body: object, status = 200): Reply => ({ status, body });
const writeReply = ({ event, googleConfirmedAt }: GoogleWrite, status = 200): Reply =>
  ({ status, body: event, googleConfirmedAt });
const noContent = { status: 204 };

function header(req: IncomingMessage, name: string) {
  const values = req.headersDistinct[name];
  if (values && values.length > 1) throw new ApiError("INVALID_ARGUMENT");
  return values?.[0];
}

function bearer(req: IncomingMessage) {
  const value = header(req, "authorization");
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(value ?? "");
  if (!match) throw new ApiError("AUTH_REQUIRED");
  return match[1]!;
}

function segment(value: string | undefined, pattern: RegExp) {
  try {
    const decoded = decodeURIComponent(value ?? "");
    if (!/[\x00-\x20\x7f]/.test(decoded) && pattern.test(decoded)) return decoded;
  } catch { /* Bad URL encoding is an invalid argument. */ }
  throw new ApiError("INVALID_ARGUMENT");
}

function query(url: URL, allowed: readonly string[]) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new ApiError("INVALID_ARGUMENT");
  }
  return url.searchParams;
}

function integer(value: string | null, fallback: number, min: number, max: number) {
  if (value === null) return fallback;
  if (!/^\d{1,3}$/.test(value) || Number(value) < min || Number(value) > max) throw new ApiError("INVALID_ARGUMENT");
  return Number(value);
}

async function body(req: IncomingMessage, fields: readonly string[]) {
  const type = header(req, "content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new ApiError("INVALID_ARGUMENT");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > bodyLimit) {
      req.resume();
      throw new ApiError("INVALID_ARGUMENT");
    }
    chunks.push(bytes);
  }
  let input: Record<string, unknown> | undefined;
  try {
    input = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
  } catch {
    throw new ApiError("INVALID_ARGUMENT");
  }
  if (!input || Object.keys(input).some(key => !fields.includes(key))) throw new ApiError("INVALID_ARGUMENT");
  return input;
}

async function route(service: CalendarService, req: IncomingMessage, url: URL, signal: AbortSignal): Promise<Reply> {
  const method = req.method;
  const pathname = url.pathname;
  if (method === "GET" && pathname === "/healthz") {
    query(url, []);
    await service.pool.query("SELECT 1 FROM connections LIMIT 1");
    return ok({ status: "ok" });
  }
  if (method === "GET" && pathname === callbackPath) {
    // Google can append scope, authuser, prompt and other response metadata.
    const unique = (name: string) => {
      const values = url.searchParams.getAll(name);
      if (values.length > 1) throw new ApiError("INVALID_ARGUMENT");
      return values[0] ?? null;
    };
    const state = unique("state");
    const code = unique("code");
    const error = unique("error");
    if (!state || state.length !== 43 || !opaque.test(state) ||
        (code ? error !== null || !text(code, 2048) || !/^[\x21-\x7e]+$/.test(code) : !text(error, 128))) {
      throw new ApiError("INVALID_ARGUMENT");
    }
    await service.callback(state, code);
    return { status: 200, body: "Google Calendar is connected. You can close this tab." };
  }
  if (method === "POST" && pathname === webhookPath) {
    query(url, []);
    req.resume();
    const id = header(req, "x-goog-channel-id");
    const token = header(req, "x-goog-channel-token");
    const resource = header(req, "x-goog-resource-id");
    const state = header(req, "x-goog-resource-state");
    const message = header(req, "x-goog-message-number");
    if (!id || !uuid.test(id) || !token || !opaque.test(token) || !text(resource, 1024) ||
        (state !== "sync" && state !== "exists" && state !== "not_exists") ||
        !message || !/^[1-9]\d{0,19}$/.test(message)) throw new ApiError("INVALID_ARGUMENT");
    // A uniform response prevents probing channel existence.
    await service.webhook(id, token, resource, state, message);
    return noContent;
  }
  if (method === "POST" && pathname === "/v1/connect-sessions") {
    query(url, []);
    return ok(await service.connect(service.project(bearer(req))), 201);
  }
  const parts = pathname.split("/");
  if (parts[1] === "v1" && parts[2] === "connect-sessions" && parts.length === 4 && method === "GET") {
    query(url, []);
    return ok(await service.consent(service.project(bearer(req)), segment(parts[3], uuid)));
  }
  if (parts[1] !== "v1" || parts[2] !== "connections") throw new ApiError("NOT_FOUND");

  const id = segment(parts[3], uuid);
  const credential = bearer(req);
  if (parts.length === 4 && method === "GET") {
    query(url, []);
    return ok(await service.status(credential, id));
  }
  if (parts.length === 5 && parts[4] === "disconnect" && method === "POST") {
    query(url, []);
    await service.disconnect(service.project(credential), id);
    return noContent;
  }
  if (parts[4] === "consumers") {
    if (parts.length === 5 && method === "POST") {
      query(url, []);
      const owner = service.project(credential);
      const input = await body(req, ["canRsvp", "canCreate", "canManage", "canInvite"]);
      if (Object.values(input).some(value => typeof value !== "boolean")) throw new ApiError("INVALID_ARGUMENT");
      return ok(await service.pair(owner, id, {
        canRsvp: input.canRsvp === true, canCreate: input.canCreate === true, canManage: input.canManage === true,
        canInvite: input.canInvite === true,
      }), 201);
    }
    if (parts.length === 7) {
      const consumer = segment(parts[5], uuid);
      if (parts[6] === "notifications" && method === "GET") {
        const params = query(url, ["wait"]);
        return ok(await service.poll(credential, id, consumer, integer(params.get("wait"), 0, 0, 25), signal));
      }
      if (parts[6] === "ack" && method === "POST") {
        query(url, []);
        const input = await body(req, ["cursor"]);
        await service.ack(credential, id, consumer, input.cursor);
        return noContent;
      }
    }
  }
  if (parts[4] === "calendars" && parts[6] === "events") {
    const calendar = segment(parts[5], calendarId);
    if (parts.length === 7 && method === "POST") {
      query(url, []);
      const key = header(req, "idempotency-key");
      if (!key || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new ApiError("INVALID_ARGUMENT");
      const input = createInput(await body(req, ["title", "start", "end", "showAs", "guests", "notifyGuests"]));
      return writeReply(await service.create(credential, id, calendar, key, input), 201);
    }
    if (parts.length === 7 && method === "GET") {
      const params = query(url, ["rsvp", "pageCursor", "limit"]);
      const cursor = params.get("pageCursor");
      if (params.get("rsvp") !== "needsAction" || (cursor !== null && !eventId.test(cursor))) {
        throw new ApiError("INVALID_ARGUMENT");
      }
      return ok(await service.invitations(credential, id, calendar, cursor ?? "", integer(params.get("limit"), 50, 1, 100)));
    }
    const update = parts.length === 8 && method === "PATCH";
    const cancel = parts.length === 9 && parts[8] === "cancel" && method === "POST";
    if (update || cancel) {
      query(url, []);
      const event = segment(parts[7], eventId);
      const version = header(req, "if-match");
      if (!validVersion(version)) throw new ApiError("INVALID_ARGUMENT");
      const input = await body(req, update ? ["title", "start", "end", "notifyGuests"] : ["notifyGuests"]);
      return writeReply(await service.manage(credential, id, calendar, event, version, guestNotification(input.notifyGuests),
        update ? updateInput(input) : undefined));
    }
    if (parts.length === 9 && parts[8] === "rsvp" && method === "PUT") {
      query(url, []);
      const event = segment(parts[7], eventId);
      const input = await body(req, ["status"]);
      const version = header(req, "if-match");
      if (!responses.includes(input.status as Rsvp) || (version !== undefined && !validVersion(version))) {
        throw new ApiError("INVALID_ARGUMENT");
      }
      return ok(await service.rsvp(credential, id, calendar, event, input.status as Rsvp, version));
    }
  }
  throw new ApiError("NOT_FOUND");
}

export function httpServer(service: CalendarService, shutdown?: AbortSignal) {
  return createServer({ maxHeaderSize: 16_384, requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
    void handle(service, req, res, shutdown);
  });
}

async function handle(service: CalendarService, req: IncomingMessage, res: ServerResponse, shutdown?: AbortSignal) {
  const id = randomUUID();
  const signal = new AbortController();
  res.on("close", () => signal.abort());
  res.setHeader("X-Request-Id", id);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.url.length > 8192 ||
        /[\\\x00-\x20]/.test(req.url) || /(?:^|\/)(?:\.|%2e){1,2}(?=\/|\?|$)/i.test(req.url.split("?")[0]!)) {
      throw new ApiError("INVALID_ARGUMENT");
    }
    const url = new URL(req.url, "https://service.invalid");
    const stream = /^\/v1\/connections\/([^/]+)\/consumers\/([^/]+)\/stream$/.exec(url.pathname);
    if (stream && req.method === "GET") {
      query(url, []);
      const abort = shutdown ? AbortSignal.any([shutdown, signal.signal]) : signal.signal;
      await service.stream(bearer(req), segment(stream[1], uuid), segment(stream[2], uuid), abort, {
        ready: async () => {
          res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
          res.setHeader("Cache-Control", "no-store, no-transform");
          res.setHeader("X-Accel-Buffering", "no");
          res.flushHeaders();
          await writeFrame(res, "event: ready\ndata: {}\n\n", abort);
        },
        send: notice => writeFrame(res, `event: notification\ndata: ${JSON.stringify(notice)}\n\n`, abort),
        heartbeat: () => writeFrame(res, ": heartbeat\n\n", abort),
      });
      return void res.end();
    }
    const reply = await route(service, req, url, signal.signal);
    if (res.destroyed) return;
    res.statusCode = reply.status;
    if (reply.googleConfirmedAt !== undefined) res.setHeader("X-Gabriel-Google-Confirmed-At", reply.googleConfirmedAt);
    if (reply.body === undefined) return void res.end();
    if (typeof reply.body === "string") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(reply.body);
    } else {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(reply.body));
    }
  } catch (error) {
    if (res.destroyed) return;
    const failure = error instanceof ApiError ? error : new ApiError("INTERNAL");
    const callback = req.url?.split("?", 1)[0] === callbackPath;
    if (callback || failure.status >= 500) {
      log({ operation: callback ? "oauth_callback" : "http", requestId: id, code: failure.code });
    }
    if (res.headersSent) {
      if (shutdown?.aborted) return void res.end();
      const data = { error: { code: failure.code, message: failure.message }, requestId: id,
        status: failure.status, retryAfter: failure.retryAfter };
      return void res.end(`event: error\ndata: ${JSON.stringify(data)}\n\n`);
    }
    if (failure.retryAfter) res.setHeader("Retry-After", failure.retryAfter);
    res.writeHead(failure.status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { code: failure.code, message: failure.message }, requestId: id }));
  }
}


async function writeFrame(res: ServerResponse, frame: string, signal: AbortSignal) {
  if (signal.aborted || res.destroyed) return;
  if (res.write(frame)) return;
  try {
    await once(res, "drain", { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  } catch (error) {
    res.destroy();
    throw error;
  }
}
