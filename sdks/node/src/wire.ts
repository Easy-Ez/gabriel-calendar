export const calendarTypes = ["invitation.received", "event.created", "event.updated", "event.cancelled", "event.rsvp_changed"] as const;
const rsvpStatuses = ["accepted", "tentative", "declined"] as const;
export type CalendarType = typeof calendarTypes[number];
export type Rsvp = typeof rsvpStatuses[number];
export interface EventRef { calendarId: string; eventId: string }
export type EventTime = ({ date: string } | { dateTime: string }) & { timeZone?: string };
export interface CalendarEvent {
  ref: EventRef;
  status: "confirmed" | "tentative" | "cancelled";
  version?: string;
  title?: string;
  start?: EventTime;
  end?: EventTime;
  location?: string;
  myResponse?: Rsvp | "needsAction";
  recurringEventId?: string;
  originalStartTime?: EventTime;
}
interface Delivery {
  schemaVersion: 1;
  notificationId: string;
  cursor: string;
  connectionId: string;
  observedAt: string;
  changedFields: string[];
}
export type CalendarNotification<T extends CalendarType = CalendarType> = Delivery & {
  type: T; ref: EventRef; event: CalendarEvent; reason?: "provider_cancelled_or_removed";
};
export type ProviderGap = Delivery & { type: "connection.gap"; reason: "provider_cursor_expired" };
export type Notification = CalendarNotification | ProviderGap;

export class CalendarError extends Error {
  constructor(readonly code: string, readonly status?: number, readonly requestId?: string, readonly retryAfter?: number) {
    super(code);
    this.name = "CalendarError";
  }
}

export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const credentialPattern = /^[A-Za-z0-9_-]{43}$/;
export const calendarPattern = /^(?!\.{1,2}$)[A-Za-z0-9_@.+#-]{1,512}$/;
export const eventPattern = /^[A-Za-z0-9_-]{1,1024}$/;
const version = /^"[\x21\x23-\x7e]{1,256}"$/;
const cursor = /^[1-9]\d{0,18}\.[A-Za-z0-9_-]{43}$/;
const date = /^\d{4}-\d{2}-\d{2}$/;
const dateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const fields = ["status", "title", "start", "end", "location", "myResponse", "recurringEventId", "originalStartTime"];

export function requireValid(condition: unknown, code = "INVALID_RESPONSE"): asserts condition {
  if (!condition) throw new CalendarError(code);
}

export function object(value: unknown): Record<string, unknown> {
  requireValid(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

export const matches = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value) && !value.endsWith("\n") && !value.endsWith("\r");

function validDate(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value;
}

function validDateTime(value: unknown): value is string {
  return matches(value, dateTime) && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

function checkTime(value: unknown) {
  const item = object(value);
  requireValid((matches(item.date, date) && validDate(item.date) && item.dateTime === undefined) ||
    (validDateTime(item.dateTime) && item.date === undefined));
  requireValid(item.timeZone === undefined ||
    (typeof item.timeZone === "string" && item.timeZone.length >= 1 && item.timeZone.length <= 128));
}

function checkRef(value: unknown): asserts value is EventRef {
  const ref = object(value);
  requireValid(matches(ref.calendarId, calendarPattern) && matches(ref.eventId, eventPattern));
}

export function decodeEvent(value: unknown): CalendarEvent {
  const item = object(value);
  checkRef(item.ref);
  requireValid(item.status === "confirmed" || item.status === "tentative" || item.status === "cancelled");
  requireValid(item.version === undefined || matches(item.version, version));
  for (const field of ["title", "location"]) {
    requireValid(item[field] === undefined || (typeof item[field] === "string" && item[field].length <= 8192));
  }
  for (const field of ["start", "end", "originalStartTime"]) {
    if (item[field] !== undefined) checkTime(item[field]);
  }
  requireValid(item.myResponse === undefined || item.myResponse === "needsAction" ||
    rsvpStatuses.includes(item.myResponse as Rsvp));
  requireValid(item.recurringEventId === undefined || matches(item.recurringEventId, eventPattern));
  return item as unknown as CalendarEvent;
}

export function decodeNotification(value: unknown, connectionId?: string): Notification {
  const item = object(value);
  requireValid(item.schemaVersion === 1 && matches(item.connectionId, uuid) &&
    (connectionId === undefined || connectionId === item.connectionId));
  requireValid(matches(item.cursor, cursor) && item.notificationId === item.connectionId + ":" + item.cursor.split(".")[0] &&
    validDateTime(item.observedAt));
  requireValid(Array.isArray(item.changedFields) && item.changedFields.every(field => fields.includes(field)) &&
    new Set(item.changedFields).size === item.changedFields.length);
  if (item.type === "connection.gap") {
    requireValid(item.reason === "provider_cursor_expired" && item.ref === undefined && item.event === undefined &&
      item.changedFields.length === 0);
  } else {
    requireValid(calendarTypes.includes(item.type as CalendarType) && item.changedFields.length > 0);
    checkRef(item.ref);
    const event = decodeEvent(item.event);
    requireValid(event.ref.calendarId === item.ref.calendarId && event.ref.eventId === item.ref.eventId);
    requireValid(item.type === "event.cancelled" ? item.reason === "provider_cancelled_or_removed" &&
      event.status === "cancelled" : item.reason === undefined && event.status !== "cancelled");
  }
  return item as unknown as Notification;
}

export function validateRsvp(ref: EventRef, status: Rsvp, ifMatch?: string) {
  requireValid(ref && matches(ref.calendarId, calendarPattern) && matches(ref.eventId, eventPattern) &&
    rsvpStatuses.includes(status) && (ifMatch === undefined || matches(ifMatch, version)), "INVALID_ARGUMENT");
}

export function validateManagement(ref: EventRef, ifMatch: unknown) {
  requireValid(ref && matches(ref.calendarId, calendarPattern) && matches(ref.eventId, eventPattern) &&
    matches(ifMatch, version), "INVALID_ARGUMENT");
}

export function validatedUrl(value: string, originOnly = false) {
  try {
    requireValid(typeof value === "string" && value.length <= 8192 && /^https?:\/\//.test(value) && !/[\s\\\x00-\x1f\x7f]/.test(value));
    const url = new URL(value);
    requireValid(!url.username && !url.password && !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))));
    requireValid(!originOnly || (url.pathname === "/" && !url.search));
    return url;
  } catch {
    throw new CalendarError(originOnly ? "INVALID_ARGUMENT" : "INVALID_RESPONSE");
  }
}
