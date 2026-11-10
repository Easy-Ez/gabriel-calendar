import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  CalendarError, calendarPattern, credentialPattern, decodeEvent, decodeNotification, eventPattern,
  matches, object, requireValid, uuid, validatedUrl, validateManagement, validateRsvp,
} from "./wire.js";
import type { CalendarEvent, CalendarNotification, CalendarType, EventRef, Notification, ProviderGap, Rsvp } from "./wire.js";

export { CalendarError, decodeNotification } from "./wire.js";
export type { CalendarEvent, CalendarNotification, EventRef, EventTime, Notification, ProviderGap, Rsvp } from "./wire.js";

type Credential = () => string | Promise<string>;
export interface ClientOptions {
  baseUrl: string;
  connectionId: string;
  consumerId: string;
  getCredential: Credential;
}
export interface Grant { connectionId: string; consumerId: string; credential: string }
export interface ConnectOptions {
  baseUrl: string;
  getProjectCredential: Credential;
  openBrowser?: (url: string) => void | Promise<void>;
  saveGrant?: (grant: Grant) => void | Promise<void>;
  signal?: AbortSignal;
}
export interface InvitationQuery { calendarId?: string; pageCursor?: string; limit?: number }
export interface InvitationPage { events: CalendarEvent[]; nextPageCursor?: string }
export interface CreateEventInput { title: string; start: string; end: string; showAs?: "busy" | "free"; guests?: string[] }
export interface CreateEventOptions { idempotencyKey: string; notifyGuests?: boolean }
export interface UpdateEventPatch { title?: string; start?: string; end?: string }
export interface ManageEventOptions { ifMatch: string; notifyGuests?: boolean }
type CalendarEvents = { [Type in CalendarType]: CalendarNotification<Type> } & {
  "connection.ready": { type: "connection.ready" };
  "connection.reconnecting": { type: "connection.reconnecting"; attempt: number; delayMs: number; code: string };
  "connection.gap": ProviderGap | { type: "connection.gap"; reason: "cursor_expired"; error: CalendarError };
  "auth.required": { type: "auth.required"; error: CalendarError };
  "connection.error": { type: "connection.error"; error: CalendarError };
};
type Handler<T> = (event: T) => void | Promise<void>;
type AnyEvent = CalendarEvents[keyof CalendarEvents];

async function authorization(getCredential: Credential) {
  let credential: string;
  try {
    credential = await getCredential();
  } catch {
    throw new CalendarError("AUTH_REQUIRED");
  }
  requireValid(matches(credential, credentialPattern), "AUTH_REQUIRED");
  return "Bearer " + credential;
}

function responseError(payload: unknown, status: number, id: unknown, retry: unknown) {
  const error = (payload as { error?: { code?: unknown } } | null)?.error;
  const code = matches(error?.code, /^[A-Z_]{1,64}$/) ? error.code : "HTTP_ERROR";
  const seconds = typeof retry === "number" && Number.isInteger(retry) && retry > 0
    ? Math.min(3600, retry) : undefined;
  return new CalendarError(code, status, matches(id, uuid) ? id : undefined, seconds);
}

async function checkedResponse(response: Response) {
  if (response.ok) return response;
  const payload: unknown = await response.json().catch(() => undefined);
  const retry = response.headers.get("retry-after");
  throw responseError(payload, response.status, response.headers.get("x-request-id"),
    matches(retry, /^\d{1,4}$/) ? Number(retry) : undefined);
}

async function request(base: string, path: string, getCredential: Credential, options: {
  method?: string; body?: object; signal?: AbortSignal; ifMatch?: string; idempotencyKey?: string;
} = {}) {
  const headers: Record<string, string> = { Authorization: await authorization(getCredential) };
  const timeout = AbortSignal.timeout(35_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  if (options.body) headers["Content-Type"] = "application/json";
  if (options.ifMatch) headers["If-Match"] = options.ifMatch;
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  let response: Response;
  try {
    response = await fetch(base + path, {
      method: options.method, headers, body: options.body && JSON.stringify(options.body), signal, redirect: "manual",
    });
  } catch {
    throw new CalendarError("NETWORK_ERROR");
  }
  await checkedResponse(response);
  if (response.status === 204) return undefined;
  return object(await response.json().catch(() => undefined));
}

async function* stream(base: string, path: string, getCredential: Credential, signal: AbortSignal) {
  const headers = { Authorization: await authorization(getCredential), Accept: "text/event-stream" };
  const connection = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => { timer = setTimeout(() => connection.abort(), 35_000); };
  try {
    arm();
    const response = await checkedResponse(await fetch(base + path, {
      headers, signal: AbortSignal.any([signal, connection.signal]), redirect: "manual",
    }));
    clearTimeout(timer);
    requireValid(response.status === 200 &&
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/event-stream" &&
      response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let event = "";
    let data = "";
    let size = 0;
    let comment = false;
    try {
      while (!signal.aborted) {
        arm();
        const { done, value } = await reader.read();
        clearTimeout(timer);
        if (done) throw new CalendarError("NETWORK_ERROR");
        try { buffer += decoder.decode(value, { stream: true }); } catch { throw new CalendarError("INVALID_RESPONSE"); }
        for (;;) {
          const newline = /\r\n|[\r\n]/.exec(buffer);
          if (!newline || (newline[0] === "\r" && newline.index === buffer.length - 1)) break;
          const line = buffer.slice(0, newline.index);
          buffer = buffer.slice(newline.index + newline[0].length);
          size += line.length + 1;
          requireValid(size <= 256 * 1024);
          if (!line) {
            const frame = data ? { type: event || "message", data: data.slice(0, -1) } :
              comment ? { type: "heartbeat", data: "" } : undefined;
            event = data = "";
            size = 0;
            comment = false;
            if (frame) yield frame;
          } else if (line.startsWith(":")) {
            comment = true;
          } else {
            const split = line.indexOf(":");
            const field = split < 0 ? line : line.slice(0, split);
            const raw = split < 0 ? "" : line.slice(split + 1).replace(/^ /, "");
            if (field === "event") event = raw;
            if (field === "data") data += raw + "\n";
          }
        }
        requireValid(buffer.length + size <= 256 * 1024);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof CalendarError) throw error;
    throw new CalendarError("NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
    connection.abort();
  }
}

function frameData(value: string): unknown {
  try { return JSON.parse(value); } catch { throw new CalendarError("INVALID_RESPONSE"); }
}

function openDefault(url: string) {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : undefined;
  if (!command) throw new CalendarError("BROWSER_UNAVAILABLE");
  return new Promise<void>((resolve, reject) => {
    execFile(command, [url], { timeout: 10_000 }, error =>
      error ? reject(new CalendarError("BROWSER_UNAVAILABLE")) : resolve());
  });
}

function retryable(error: CalendarError) {
  return error.code === "NETWORK_ERROR" || error.code === "HANDLER_FAILED" || error.code === "READER_BUSY" ||
    error.code === "RATE_LIMITED" || (error.status !== undefined && error.status >= 500);
}

function terminal(error: CalendarError): AnyEvent {
  if (error.code === "CURSOR_EXPIRED") return { type: "connection.gap", reason: "cursor_expired", error };
  if (error.code === "AUTH_REQUIRED") return { type: "auth.required", error };
  return { type: "connection.error", error };
}

interface Run {
  intake: AbortController;
  ack: AbortController;
  abandoned: boolean;
  accept: () => void;
  reject: (error: CalendarError) => void;
  done?: Promise<void>;
}

export class CalendarClient {
  readonly connectionId: string;
  readonly consumerId: string;
  private readonly base: string;
  private readonly credential: Credential;
  private readonly path: string;
  private readonly reader: string;
  private readonly handlers = new Map<keyof CalendarEvents, Set<Handler<AnyEvent>>>();
  private readonly processed = new Set<string>();
  private readonly handlerScope = new AsyncLocalStorage<Run>();
  private run?: Run;

  readonly events = {
    create: (calendarId: string, input: CreateEventInput, options: CreateEventOptions) =>
      this.createEvent(calendarId, input, options),
    update: (ref: EventRef, patch: UpdateEventPatch, options: ManageEventOptions) => this.updateEvent(ref, patch, options),
    cancel: (ref: EventRef, options: ManageEventOptions) => this.manageEvent(ref, options),
    listInvitations: (query?: InvitationQuery) => this.listInvitations(query),
    rsvp: (ref: EventRef, status: Rsvp, options?: { ifMatch?: string }) => this.rsvp(ref, status, options?.ifMatch),
  };

  constructor(options: ClientOptions) {
    this.base = validatedUrl(options.baseUrl, true).origin;
    requireValid(matches(options.connectionId, uuid) && matches(options.consumerId, uuid) &&
      typeof options.getCredential === "function", "INVALID_ARGUMENT");
    this.connectionId = options.connectionId;
    this.consumerId = options.consumerId;
    this.credential = options.getCredential;
    this.path = `/v1/connections/${this.connectionId}`;
    this.reader = `${this.path}/consumers/${this.consumerId}`;
  }

  static async connect(options: ConnectOptions): Promise<CalendarClient> {
    const base = validatedUrl(options.baseUrl, true).origin;
    requireValid(typeof options.getProjectCredential === "function", "INVALID_ARGUMENT");
    const timeout = AbortSignal.timeout(15 * 60_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const project = options.getProjectCredential;
    const session = object(await request(base, "/v1/connect-sessions", project, { method: "POST", signal }));
    requireValid(matches(session.sessionId, uuid) && typeof session.authorizationUrl === "string");
    await (options.openBrowser ?? openDefault)(validatedUrl(session.authorizationUrl).href);
    while (!signal.aborted) {
      const result = object(await request(base, `/v1/connect-sessions/${session.sessionId}`, project, { signal }));
      if (result.status === "failed") throw new CalendarError("CONSENT_FAILED");
      if (result.status === "connected") {
        requireValid(matches(result.connectionId, uuid));
        const id = result.connectionId;
        const grant = object(await request(base, `/v1/connections/${id}/consumers`, project, {
          method: "POST", body: {}, signal,
        }));
        requireValid(grant.connectionId === id && matches(grant.consumerId, uuid) && matches(grant.credential, credentialPattern));
        const credential = grant.credential;
        await options.saveGrant?.({ connectionId: id, consumerId: grant.consumerId, credential });
        return new CalendarClient({ baseUrl: base, connectionId: id, consumerId: grant.consumerId,
          getCredential: () => credential });
      }
      requireValid(result.status === "pending");
      await delay(1000, undefined, { signal }).catch(() => {});
    }
    throw new CalendarError("CONSENT_EXPIRED");
  }

  on<T extends keyof CalendarEvents>(type: T, handler: Handler<CalendarEvents[T]>): () => void {
    let handlers = this.handlers.get(type);
    if (!handlers) this.handlers.set(type, handlers = new Set());
    const entry = handler as Handler<AnyEvent>;
    handlers.add(entry);
    return () => { handlers.delete(entry); };
  }

  async listInvitations({ calendarId = "primary", pageCursor, limit }: InvitationQuery = {}): Promise<InvitationPage> {
    requireValid(matches(calendarId, calendarPattern) && (pageCursor === undefined || matches(pageCursor, eventPattern)) &&
      (limit === undefined || (Number.isInteger(limit) && limit >= 1 && limit <= 100)), "INVALID_ARGUMENT");
    const query = new URLSearchParams({ rsvp: "needsAction" });
    if (pageCursor !== undefined) query.set("pageCursor", pageCursor);
    if (limit !== undefined) query.set("limit", String(limit));
    const result = object(await request(this.base, `${this.path}/calendars/${encodeURIComponent(calendarId)}/events?${query}`, this.credential));
    requireValid(Array.isArray(result.events) && result.events.length <= 100 &&
      (result.nextPageCursor === undefined || matches(result.nextPageCursor, eventPattern)));
    return { events: result.events.map(decodeEvent), nextPageCursor: result.nextPageCursor };
  }

  private async rsvp(ref: EventRef, status: Rsvp, ifMatch?: string) {
    validateRsvp(ref, status, ifMatch);
    const path = `${this.path}/calendars/${encodeURIComponent(ref.calendarId)}/events/${encodeURIComponent(ref.eventId)}/rsvp`;
    const event = decodeEvent(await request(this.base, path, this.credential, { method: "PUT", body: { status }, ifMatch }));
    requireValid(event.ref.calendarId === ref.calendarId && event.ref.eventId === ref.eventId);
    return event;
  }

  private async createEvent(calendarId: string, input: CreateEventInput, options: CreateEventOptions) {
    requireValid(matches(calendarId, calendarPattern) && matches(options?.idempotencyKey, /^[A-Za-z0-9_-]{1,128}$/) &&
      input && typeof input.title === "string" && typeof input.start === "string" && typeof input.end === "string" &&
      (input.showAs === undefined || input.showAs === "busy" || input.showAs === "free") &&
      (input.guests === undefined || (Array.isArray(input.guests) && input.guests.length <= 12 &&
        input.guests.every(email => typeof email === "string"))) &&
      (options.notifyGuests === undefined || typeof options.notifyGuests === "boolean") &&
      (!input.guests?.length || options.notifyGuests !== undefined), "INVALID_ARGUMENT");
    const path = `${this.path}/calendars/${encodeURIComponent(calendarId)}/events`;
    const event = decodeEvent(await request(this.base, path, this.credential, {
      method: "POST", body: { ...input, notifyGuests: options.notifyGuests }, idempotencyKey: options.idempotencyKey,
    }));
    requireValid(calendarId === "primary" || event.ref.calendarId === calendarId);
    return event;
  }

  private async updateEvent(ref: EventRef, patch: UpdateEventPatch, options: ManageEventOptions) {
    requireValid(patch && (patch.title !== undefined || patch.start !== undefined || patch.end !== undefined) &&
      (patch.title === undefined || typeof patch.title === "string") &&
      ((patch.start === undefined && patch.end === undefined) ||
        (typeof patch.start === "string" && typeof patch.end === "string")), "INVALID_ARGUMENT");
    return this.manageEvent(ref, options, patch);
  }

  private async manageEvent(ref: EventRef, options: ManageEventOptions, patch?: UpdateEventPatch) {
    const ifMatch = options?.ifMatch;
    validateManagement(ref, ifMatch);
    const notifyGuests = options?.notifyGuests;
    requireValid(notifyGuests === undefined || typeof notifyGuests === "boolean", "INVALID_ARGUMENT");
    const path = `${this.path}/calendars/${encodeURIComponent(ref.calendarId)}/events/${encodeURIComponent(ref.eventId)}`;
    const event = decodeEvent(await request(this.base, patch ? path : path + "/cancel", this.credential, {
      method: patch ? "PATCH" : "POST", body: { ...patch, notifyGuests }, ifMatch,
    }));
    requireValid(event.ref.calendarId === ref.calendarId && event.ref.eventId === ref.eventId &&
      (patch ? event.status !== "cancelled" && event.version !== undefined : event.status === "cancelled"));
    return event;
  }

  async start() {
    if (this.run) throw new CalendarError("INVALID_STATE");
    let accept!: () => void;
    let reject!: (error: CalendarError) => void;
    const ready = new Promise<void>((resolve, fail) => { accept = resolve; reject = fail; });
    const run: Run = { intake: new AbortController(), ack: new AbortController(), abandoned: false, accept, reject };
    this.run = run;
    run.done = this.listen(run).finally(() => { this.run = undefined; });
    const timer = new AbortController();
    try {
      await Promise.race([ready, delay(35_000, undefined, { signal: timer.signal }).then(() => {
        throw new CalendarError("NETWORK_TIMEOUT");
      })]);
    } catch (error) {
      await this.stop({ drainMs: 0 });
      throw error;
    } finally {
      timer.abort();
    }
  }

  async stop({ drainMs = 10_000 }: { drainMs?: number } = {}) {
    requireValid(Number.isInteger(drainMs) && drainMs >= 0 && drainMs <= 60_000, "INVALID_ARGUMENT");
    const run = this.run;
    if (!run) return;
    run.intake.abort();
    if (this.handlerScope.getStore() === run) return;
    const timer = new AbortController();
    try {
      await Promise.race([run.done, delay(drainMs, undefined, { signal: timer.signal }).then(() => {
        run.abandoned = true;
        run.ack.abort();
      })]);
    } finally {
      timer.abort();
    }
  }

  private async emit(event: AnyEvent, run: Run, strict: boolean) {
    for (const handler of [...(this.handlers.get(event.type) ?? [])]) {
      if (run.abandoned || (!strict && run.intake.signal.aborted)) return;
      try {
        await this.handlerScope.run(run, () => handler(event));
      } catch {
        if (strict) throw new CalendarError("HANDLER_FAILED");
      }
    }
  }

  private async process(notification: Notification, run: Run) {
    if (!this.processed.has(notification.notificationId)) {
      await this.emit(notification, run, true);
      if (run.abandoned) return;
      this.processed.add(notification.notificationId);
      if (this.processed.size > 1024) this.processed.delete(this.processed.values().next().value!);
    }
    if (run.abandoned) return;
    const result = await request(this.base, this.reader + "/ack", this.credential, {
      method: "POST", body: { cursor: notification.cursor }, signal: run.ack.signal,
    });
    requireValid(result === undefined);
  }

  private async listen(run: Run) {
    const signal = run.intake.signal;
    let ready = false;
    let attempt = 0;
    try {
      while (!signal.aborted) {
        try {
          let opened = false;
          for await (const frame of stream(this.base, this.reader + "/stream", this.credential, signal)) {
            if (signal.aborted) break;
            if (frame.type === "heartbeat") {
              if (opened) attempt = 0;
              continue;
            }
            if (frame.type === "ready") {
              requireValid(!opened);
              object(frameData(frame.data));
              opened = ready = true;
              run.accept();
              await this.emit({ type: "connection.ready" }, run, false);
              continue;
            }
            if (frame.type === "error") {
              const data = object(frameData(frame.data));
              requireValid(typeof data.status === "number" && Number.isInteger(data.status) && data.status >= 400 && data.status <= 599);
              throw responseError(data, data.status, data.requestId, data.retryAfter);
            }
            requireValid(opened && frame.type === "notification");
            await this.process(decodeNotification(frameData(frame.data), this.connectionId), run);
            attempt = 0;
          }
        } catch (cause) {
          if (signal.aborted) break;
          const error = cause instanceof CalendarError ? cause : new CalendarError("INVALID_RESPONSE");
          if (!retryable(error)) {
            if (!ready) run.reject(error);
            await this.emit(terminal(error), run, false);
            return;
          }
          attempt++;
          const wait = error.retryAfter ? error.retryAfter * 1000 : Math.min(250 * 2 ** Math.min(attempt - 1, 7), 30_000);
          await this.emit({ type: "connection.reconnecting", attempt, delayMs: wait, code: error.code }, run, false);
          await delay(wait, undefined, { signal }).catch(() => {});
        }
      }
    } finally {
      if (!ready) run.reject(new CalendarError("INVALID_STATE"));
    }
  }
}
