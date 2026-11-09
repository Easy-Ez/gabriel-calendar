import { ApiError, calendarId, callbackPath, digest, eventId, record, retryAfter, text, webhookPath } from "./core.js";
import type { Settings } from "./core.js";

const scopes = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.owned",
];
export const watchTtl = 86400;
export const responses = ["accepted", "tentative", "declined"] as const;
export type Rsvp = typeof responses[number];
export type CreateEvent = { title: string; start: string; end: string; showAs: "busy" | "free";
  invitation?: { guests: string[]; notify: boolean } };
export type UpdateEvent = { title?: string; time?: { start: string; end: string } };
type ResponseStatus = Rsvp | "needsAction";
export type EventTime = { date: string; timeZone?: string } | { dateTime: string; timeZone?: string };
export interface EventRef { calendarId: string; eventId: string }
export interface CalendarEvent {
  ref: EventRef;
  status: "confirmed" | "tentative" | "cancelled";
  version?: string;
  title?: string;
  start?: EventTime;
  end?: EventTime;
  location?: string;
  myResponse?: ResponseStatus;
  recurringEventId?: string;
  originalStartTime?: EventTime;
}
export type GoogleWrite = { event: CalendarEvent; googleConfirmedAt?: number };
type EventCopy = { event: CalendarEvent; iCalUid?: string };
const copyFields = "id,iCalUID,status,summary,start,end";
export interface Observed {
  event: CalendarEvent;
  pending: boolean;
}
export const eventTypes = ["invitation.received", "event.created", "event.updated", "event.cancelled", "event.rsvp_changed"] as const;
type EventType = typeof eventTypes[number];
export type Payload = {
  type: EventType; ref: EventRef; event: CalendarEvent; changedFields: string[];
  reason?: "provider_cancelled_or_removed";
} | { type: "connection.gap"; reason: "provider_cursor_expired"; changedFields: [] };

export class GoogleError extends Error {
  constructor(readonly status: number, readonly reason?: string, readonly retry?: number) {
    super("Calendar provider request failed");
  }
}

export function providerError(error: GoogleError) {
  if (error.status === 404 || error.status === 410) return new ApiError("NOT_FOUND");
  if (error.status === 412) return new ApiError("VERSION_CONFLICT");
  if (error.status === 429 || ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"].includes(error.reason ?? "")) {
    return new ApiError("RATE_LIMITED", error.retry ?? 5);
  }
  if (error.status === 403) return new ApiError("FORBIDDEN");
  return new ApiError("PROVIDER_UNAVAILABLE", error.retry ?? 5);
}

const malformed = () => new GoogleError(502);
const encoded = (value: string) => encodeURIComponent(value);
const date = /^\d{4}-\d{2}-\d{2}$/;
const dateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const version = /^"[\x21\x23-\x7e]{1,256}"$/;
const validICalUid = (value: unknown): value is string => text(value, 1024) && !/[\x00-\x20\x7f]/.test(value);

function eventCopy(calendar: string, value: unknown): EventCopy {
  const copy = record(value);
  if (!copy || (copy.iCalUID !== undefined && !validICalUid(copy.iCalUID))) throw malformed();
  return { event: observe(calendar, copy).event, iCalUid: copy.iCalUID };
}

export function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.endsWith('"') && version.test(value);
}

function validDate(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value;
}

function writeTime(value: unknown) {
  if (!text(value, 29) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,3})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/.test(value) ||
      /[\r\n]/.test(value) || !validDate(value.slice(0, 10))) throw new ApiError("INVALID_ARGUMENT");
  const utc = new Date(value).toISOString();
  if (utc.length !== 24 || utc.startsWith("0000")) throw new ApiError("INVALID_ARGUMENT");
  return utc;
}

function writeTitle(title: unknown) {
  if (!text(title, 512) || !title.trim() || !title.isWellFormed() || /[\x00-\x1f\x7f]/.test(title)) {
    throw new ApiError("INVALID_ARGUMENT");
  }
  return title;
}

function writeRange(input: Record<string, unknown>) {
  const start = writeTime(input.start);
  const end = writeTime(input.end);
  if (end <= start) throw new ApiError("INVALID_ARGUMENT");
  return { start, end };
}

export function createInput(input: Record<string, unknown>): CreateEvent {
  const { showAs = "busy" } = input;
  if (showAs !== "busy" && showAs !== "free") throw new ApiError("INVALID_ARGUMENT");
  const notify = guestNotification(input.notifyGuests);
  const guests = guestEmails(input.guests);
  if (guests.length && notify === undefined) throw new ApiError("INVALID_ARGUMENT");
  // Preserve the fingerprint of previously created events without guests.
  return { title: writeTitle(input.title), ...writeRange(input), showAs,
    ...(guests.length && notify !== undefined ? { invitation: { guests, notify } } : {}) };
}

function guestEmails(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) throw new ApiError("INVALID_ARGUMENT");
  const seen = new Set<string>();
  return value.map(address => {
    if (!text(address, 254) || /\s/.test(address)) throw new ApiError("INVALID_ARGUMENT");
    const [local, domain, extra] = address.split("@");
    if (!local || local.length > 64 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(local) ||
        !domain || extra !== undefined || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(domain)) {
      throw new ApiError("INVALID_ARGUMENT");
    }
    const normalized = local + "@" + domain.toLowerCase();
    const key = normalized.toLowerCase();
    if (seen.has(key)) throw new ApiError("INVALID_ARGUMENT");
    seen.add(key);
    return normalized;
  }).sort();
}

export function guestNotification(value: unknown) {
  if (value !== undefined && typeof value !== "boolean") throw new ApiError("INVALID_ARGUMENT");
  return value;
}

export function updateInput(input: Record<string, unknown>): UpdateEvent {
  if (input.title === undefined && input.start === undefined && input.end === undefined) {
    throw new ApiError("INVALID_ARGUMENT");
  }
  return {
    ...(input.title === undefined ? {} : { title: writeTitle(input.title) }),
    ...(input.start === undefined && input.end === undefined ? {} : { time: writeRange(input) }),
  };
}

function eventTime(value: unknown): EventTime | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  if (!input) throw malformed();
  const timeZone = text(input.timeZone, 128) ? { timeZone: input.timeZone } : {};
  if (text(input.date, 10) && date.test(input.date) && validDate(input.date)) {
    return { date: input.date, ...timeZone };
  }
  if (text(input.dateTime, 64) && dateTime.test(input.dateTime) && validDate(input.dateTime.slice(0, 10)) &&
      Number.isFinite(Date.parse(input.dateTime))) {
    return { dateTime: input.dateTime, ...timeZone };
  }
  throw malformed();
}

const cleanText = (value: string) => value.slice(0, 8192).toWellFormed().replaceAll("\0", "\ufffd");

function selfAttendee(input: Record<string, unknown>) {
  if (input.attendees === undefined) return undefined;
  if (!Array.isArray(input.attendees)) throw malformed();
  const matches = input.attendees.map(record).filter(item => item?.self === true);
  return matches.length === 1 ? matches[0] : undefined;
}

export function observe(calendar: string, value: unknown): Observed {
  const input = record(value);
  if (!input || !text(input.id, 1024) || !eventId.test(input.id)) throw malformed();
  const status = input.status ?? "confirmed";
  if (status !== "confirmed" && status !== "tentative" && status !== "cancelled") throw malformed();
  const event: CalendarEvent = { ref: { calendarId: calendar, eventId: input.id }, status };
  if (text(input.recurringEventId, 1024) && eventId.test(input.recurringEventId)) event.recurringEventId = input.recurringEventId;
  const original = eventTime(input.originalStartTime);
  if (original) event.originalStartTime = original;
  if (status === "cancelled") return { event, pending: false };

  if (validVersion(input.etag)) event.version = input.etag;
  if (typeof input.summary === "string") event.title = cleanText(input.summary);
  if (typeof input.location === "string") event.location = cleanText(input.location);
  const start = eventTime(input.start);
  const end = eventTime(input.end);
  if (start) event.start = start;
  if (end) event.end = end;
  const self = selfAttendee(input);
  const reply = self?.responseStatus;
  if (reply === "accepted" || reply === "tentative" || reply === "declined" || reply === "needsAction") {
    event.myResponse = reply;
  }
  return {
    event,
    pending: event.myResponse === "needsAction" && self?.organizer !== true && record(input.organizer)?.self !== true,
  };
}

const tracked = ["status", "title", "start", "end", "location", "myResponse", "recurringEventId", "originalStartTime"] as const;

export function classify(before: CalendarEvent | undefined, after: Observed): Payload | undefined {
  const { event, pending } = after;
  const common = { ref: event.ref, event };
  if (event.status === "cancelled") {
    if (!before || before.status === "cancelled") return;
    return { ...common, type: "event.cancelled", changedFields: ["status"], reason: "provider_cancelled_or_removed" };
  }
  const changedFields = tracked.filter(field =>
    JSON.stringify(before?.[field]) !== JSON.stringify(event[field]));
  if (!before) return { ...common, type: pending ? "invitation.received" : "event.created", changedFields };
  if (!changedFields.length) return;
  return { ...common, type: changedFields.length === 1 && changedFields[0] === "myResponse"
    ? "event.rsvp_changed" : "event.updated", changedFields };
}

export class Google {
  constructor(private readonly config: Settings, private readonly endpoints = {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    calendar: "https://www.googleapis.com/calendar/v3",
  }) {}

  private get redirectUri() { return this.config.baseUrl + callbackPath; }

  authorization(state: string, verifier: string) {
    const url = new URL(this.endpoints.auth);
    url.search = new URLSearchParams({
      client_id: this.config.googleClientId, redirect_uri: this.redirectUri, response_type: "code",
      scope: scopes.join(" "), access_type: "offline", prompt: "select_account consent", state,
      code_challenge: digest(verifier), code_challenge_method: "S256",
    }).toString();
    return url.href;
  }

  private async request(url: string, init: RequestInit, deadline?: AbortSignal): Promise<unknown> {
    let result: Response;
    try {
      const timeout = AbortSignal.timeout(12_000);
      const signal = deadline ? AbortSignal.any([timeout, deadline]) : timeout;
      result = await fetch(url, { ...init, redirect: "error", signal });
    } catch {
      throw new GoogleError(503);
    }
    if (result.ok && result.status === 204) return undefined;
    const body: unknown = await result.json().catch(() => undefined);
    if (!result.ok) {
      const info = record(body)?.error;
      const details = record(info)?.errors;
      const reason = typeof info === "string" ? info : Array.isArray(details) ? record(details[0])?.reason : undefined;
      throw new GoogleError(result.status, typeof reason === "string" ? reason : undefined,
        retryAfter(result.headers.get("retry-after")));
    }
    return body;
  }

  private async token(params: Record<string, string>) {
    const result = record(await this.request(this.endpoints.token, {
      method: "POST",
      body: new URLSearchParams({
        ...params, client_id: this.config.googleClientId, client_secret: this.config.googleClientSecret,
      }),
    }));
    if (!result || !text(result.access_token, 8192) || !/^[\x21-\x7e]+$/.test(result.access_token) ||
        typeof result.expires_in !== "number" || !Number.isFinite(result.expires_in) || result.expires_in <= 0) {
      throw malformed();
    }
    const granted = typeof result.scope === "string" ? result.scope.split(" ") : undefined;
    if (granted && !scopes.every(scope => granted.includes(scope))) {
      throw new GoogleError(403, "insufficient_scope");
    }
    return {
      access: result.access_token,
      refresh: text(result.refresh_token, 8192) ? result.refresh_token : undefined,
      expiresAt: Date.now() + result.expires_in * 1000,
    };
  }

  exchange(code: string, verifier: string) {
    return this.token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: this.redirectUri });
  }

  refresh(value: string) {
    return this.token({ grant_type: "refresh_token", refresh_token: value });
  }

  private calendar(access: string, path: string, method = "GET", body?: object, etag?: string, deadline?: AbortSignal) {
    const headers: Record<string, string> = { authorization: `Bearer ${access}` };
    if (body) headers["content-type"] = "application/json";
    if (etag) headers["if-match"] = etag;
    return this.request(this.endpoints.calendar + path, { method, headers, body: body && JSON.stringify(body) }, deadline);
  }

  async primary(access: string) {
    const result = record(await this.calendar(access, "/users/me/calendarList/primary"));
    if (!result || !text(result.id, 512) || !calendarId.test(result.id) || result.id === "primary" ||
        /\s/.test(result.id)) throw malformed();
    if (result.primary !== true || result.accessRole !== "owner") throw new GoogleError(403, "primary_role_mismatch");
    return result.id;
  }

  async readCopy(access: string, calendar: string, id: string, deadline: AbortSignal) {
    if (!text(id, 1024) || /\s/.test(id) || !eventId.test(id)) throw new ApiError("INVALID_ARGUMENT");
    const params = new URLSearchParams({ fields: copyFields });
    const path = `/calendars/${encoded(calendar)}/events/${encoded(id)}?${params}`;
    try {
      const copy = eventCopy(calendar, await this.calendar(access, path, "GET", undefined, undefined, deadline));
      if (copy.event.ref.eventId !== id) throw malformed();
      return copy;
    } catch (error) {
      if (error instanceof GoogleError && (error.status === 404 || error.status === 410)) return undefined;
      throw error;
    }
  }

  async findCopy(access: string, calendar: string, uid: string, deadline: AbortSignal) {
    if (!validICalUid(uid)) throw new ApiError("INVALID_ARGUMENT");
    const params = new URLSearchParams({ iCalUID: uid, maxResults: "2", fields: `nextPageToken,items(${copyFields})` });
    const path = `/calendars/${encoded(calendar)}/events`;
    let match: EventCopy | undefined;
    const pages = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const response = record(await this.calendar(access, `${path}?${params}`, "GET", undefined, undefined, deadline));
      if (!response || (response.items !== undefined && !Array.isArray(response.items))) throw malformed();
      for (const value of response.items ?? []) {
        const copy = eventCopy(calendar, value);
        if (copy.iCalUid !== uid || match) throw malformed();
        match = copy;
      }
      if (response.nextPageToken === undefined) return match;
      if (!text(response.nextPageToken, 8192) || pages.has(response.nextPageToken)) throw malformed();
      pages.add(response.nextPageToken);
      params.set("pageToken", response.nextPageToken);
    }
    throw malformed();
  }

  async list(access: string, calendar: string, syncToken: string | null) {
    const path = `/calendars/${encoded(calendar)}/events`;
    const params = new URLSearchParams({ singleEvents: "true", showDeleted: "true", maxResults: "2500" });
    if (syncToken) params.set("syncToken", syncToken);
    const observed = new Map<string, Observed>();
    const pages = new Set<string>();
    const deadline = AbortSignal.timeout(60_000);
    for (let page = 0; page < 1000; page++) {
      const result = record(await this.calendar(access, `${path}?${params}`, "GET", undefined, undefined, deadline));
      if (!result || (result.items !== undefined && !Array.isArray(result.items))) throw malformed();
      for (const item of result.items ?? []) {
        const entry = observe(calendar, item);
        observed.set(entry.event.ref.eventId, entry);
        if (observed.size > 100_000) throw malformed();
      }
      if (result.nextPageToken === undefined && text(result.nextSyncToken, 8192)) {
        return { observed, syncToken: result.nextSyncToken };
      }
      if (!text(result.nextPageToken, 8192) || pages.has(result.nextPageToken)) throw malformed();
      pages.add(result.nextPageToken);
      params.set("pageToken", result.nextPageToken);
    }
    throw malformed();
  }

  async watch(access: string, calendar: string, id: string, token: string) {
    const result = record(await this.calendar(access, `/calendars/${encoded(calendar)}/events/watch`, "POST", {
      id, type: "web_hook", address: this.config.baseUrl + webhookPath, token,
      params: { ttl: String(watchTtl) },
    }));
    const expires = Number(result?.expiration);
    if (result?.id !== id || !text(result.resourceId, 1024) || !Number.isSafeInteger(expires) ||
        expires <= Date.now() || expires > Date.now() + 31 * 86400_000) throw malformed();
    return { resourceId: result.resourceId, expiresAt: new Date(expires) };
  }

  async stop(access: string, id: string, resourceId: string) {
    await this.calendar(access, "/channels/stop", "POST", { id, resourceId });
  }

  async create(access: string, calendar: string, id: string, marker: string, input: CreateEvent,
    retry: boolean, confirmed: boolean): Promise<GoogleWrite> {
    const path = `/calendars/${encoded(calendar)}/events`;
    const find = async () => {
      try {
        return await this.calendar(access, `${path}/${encoded(id)}`);
      } catch (error) {
        if (error instanceof GoogleError && (error.status === 404 || error.status === 410)) return undefined;
        throw error;
      }
    };
    const checked = (value: unknown) => {
      const result = record(value);
      if (result?.id === id && result.status === "cancelled") throw new ApiError("NOT_FOUND");
      const properties = record(record(result?.extendedProperties)?.private);
      if (result?.id !== id || properties?.gabrielCreate !== marker) throw new ApiError("OUTCOME_UNKNOWN");
      return observe(calendar, result).event;
    };
    if (retry) {
      const existing = await find();
      if (existing !== undefined) return { event: checked(existing) };
      if (confirmed) throw new ApiError("NOT_FOUND");
    }
    try {
      const invite = input.invitation;
      const created = await this.calendar(access, path + (invite ? `?sendUpdates=${invite.notify ? "all" : "none"}` : ""), "POST", {
        id, summary: input.title, start: { dateTime: input.start }, end: { dateTime: input.end },
        transparency: input.showAs === "free" ? "transparent" : "opaque",
        reminders: { useDefault: false },
        extendedProperties: { private: { gabrielCreate: marker } },
        ...(invite && { attendees: invite.guests.map(email => ({ email })) }),
      });
      const googleConfirmedAt = Date.now();
      return { event: checked(created), googleConfirmedAt };
    } catch (error) {
      if (!(error instanceof GoogleError) || (error.status !== 409 && error.status < 500)) throw error;
      try {
        return { event: checked(await find()) };
      } catch {
        throw new ApiError("OUTCOME_UNKNOWN");
      }
    }
  }

  async rsvp(access: string, calendar: string, id: string, status: Rsvp, ifMatch?: string) {
    const path = `/calendars/${encoded(calendar)}/events/${encoded(id)}`;
    const current = record(await this.calendar(access, path));
    const self = current && selfAttendee(current);
    if (!current || current.id !== id || current.status === "cancelled") throw new ApiError("NOT_FOUND");
    if (!self || !text(self.email, 512) || self.resource === true || self.organizer === true ||
        record(current.organizer)?.self === true || current.recurrence !== undefined) throw new ApiError("FORBIDDEN");
    if (!validVersion(current.etag)) throw malformed();
    if (ifMatch && ifMatch !== current.etag) throw new ApiError("VERSION_CONFLICT");

    let confirmed: unknown;
    try {
      confirmed = await this.calendar(access, path + "?sendUpdates=none", "PATCH", {
        attendeesOmitted: true, attendees: [{ email: self.email, responseStatus: status }],
      }, current.etag);
    } catch (error) {
      if (error instanceof GoogleError && error.status >= 500) throw new ApiError("OUTCOME_UNKNOWN");
      throw error;
    }
    try {
      let result = observe(calendar, confirmed).event;
      if (!result.myResponse) result = observe(calendar, await this.calendar(access, path)).event;
      if (result.ref.eventId === id && result.myResponse && result.status !== "cancelled") return result;
    } catch {
      throw new ApiError("OUTCOME_UNKNOWN");
    }
    throw new ApiError("OUTCOME_UNKNOWN");
  }

  async manage(access: string, calendar: string, id: string, version: string,
    options: { allowGuests: boolean; notify?: boolean; patch?: UpdateEvent }): Promise<GoogleWrite> {
    const path = `/calendars/${encoded(calendar)}/events/${encoded(id)}`;
    const current = record(await this.calendar(access, path));
    if (!current || current.id !== id || current.status === "cancelled") throw new ApiError("NOT_FOUND");
    const attendees = current.attendees;
    if (record(current.organizer)?.self !== true || current.attendeesOmitted === true ||
        (attendees !== undefined && (!Array.isArray(attendees) || attendees.some(value => {
          const attendee = record(value);
          return !attendee || attendee.resource === true;
        }))) || current.recurrence !== undefined || current.recurringEventId !== undefined ||
        current.originalStartTime !== undefined || current.locked === true ||
        (current.eventType !== undefined && current.eventType !== "default")) throw new ApiError("FORBIDDEN");
    const event = observe(calendar, current).event;
    if (!event.start || !("dateTime" in event.start) || !event.end || !("dateTime" in event.end)) {
      throw new ApiError("FORBIDDEN");
    }
    if (!event.version) throw malformed();
    if (event.version !== version) throw new ApiError("VERSION_CONFLICT");
    const hasGuests = Array.isArray(attendees) && attendees.some(value => {
      const attendee = record(value)!;
      return attendee.self !== true || attendee.organizer !== true;
    });
    const { allowGuests, notify, patch } = options;
    if (hasGuests && !allowGuests) throw new ApiError("FORBIDDEN");
    if (hasGuests && notify === undefined) throw new ApiError("INVALID_ARGUMENT");
    const writePath = path + (hasGuests && notify ? "?sendUpdates=all" : "?sendUpdates=none");
    try {
      if (!patch) {
        await this.calendar(access, writePath, "DELETE", undefined, version);
        return { event: { ref: event.ref, status: "cancelled" }, googleConfirmedAt: Date.now() };
      }
      const changed = await this.calendar(access, writePath, "PATCH", {
        ...(patch.title === undefined ? {} : { summary: patch.title }),
        ...(patch.time && { start: { dateTime: patch.time.start }, end: { dateTime: patch.time.end } }),
      }, version);
      const googleConfirmedAt = Date.now();
      const result = observe(calendar, changed).event;
      if (result.ref.eventId !== id || result.status === "cancelled" || !result.version) throw malformed();
      return { event: result, googleConfirmedAt };
    } catch (error) {
      if (error instanceof GoogleError && error.status >= 500) throw new ApiError("OUTCOME_UNKNOWN");
      throw error;
    }
  }
}
