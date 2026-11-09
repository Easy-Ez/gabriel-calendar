from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal
from urllib.parse import urlsplit

Rsvp = Literal["accepted", "tentative", "declined"]
RSVP_STATUSES = ("accepted", "tentative", "declined")
CALENDAR_TYPES = (
    "invitation.received", "event.created", "event.updated", "event.cancelled", "event.rsvp_changed",
)
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
CREDENTIAL = re.compile(r"[A-Za-z0-9_-]{43}")
CALENDAR_ID = re.compile(r"(?!\.{1,2}$)[A-Za-z0-9_@.+#-]{1,512}")
EVENT_ID = re.compile(r"[A-Za-z0-9_-]{1,1024}")
VERSION = re.compile(r'"[\x21\x23-\x7e]{1,256}"')
_CURSOR = re.compile(r"[1-9]\d{0,18}\.[A-Za-z0-9_-]{43}", re.ASCII)
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}", re.ASCII)
_DATE_TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", re.ASCII)
_FIELDS = {
    "status": "status", "title": "title", "start": "start", "end": "end",
    "location": "location", "myResponse": "my_response", "recurringEventId": "recurring_event_id",
    "originalStartTime": "original_start_time",
}


class CalendarError(Exception):
    def __init__(
        self, code: str, status: int | None = None, request_id: str | None = None,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.status = status
        self.request_id = request_id
        self.retry_after = retry_after


@dataclass(frozen=True)
class EventRef:
    calendar_id: str
    event_id: str


@dataclass(frozen=True)
class EventTime:
    date: str | None = None
    date_time: str | None = None
    time_zone: str | None = None


@dataclass(frozen=True)
class CalendarEvent:
    ref: EventRef
    status: str
    version: str | None = None
    title: str | None = None
    start: EventTime | None = None
    end: EventTime | None = None
    location: str | None = None
    my_response: str | None = None
    recurring_event_id: str | None = None
    original_start_time: EventTime | None = None


@dataclass(frozen=True)
class Notification:
    schema_version: int
    notification_id: str
    cursor: str
    connection_id: str
    type: str
    observed_at: str
    changed_fields: tuple[str, ...]
    ref: EventRef | None = None
    event: CalendarEvent | None = None
    reason: str | None = None


def require(condition: object, code: str = "INVALID_RESPONSE") -> None:
    if not condition:
        raise CalendarError(code)


def object_value(value: Any) -> dict[str, Any]:
    require(isinstance(value, dict))
    return value


def matches(value: object, pattern: re.Pattern[str]) -> bool:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _valid_date_time(value: str) -> bool:
    if not matches(value, _DATE_TIME):
        return False
    try:
        offset = value[-6:]
        if not value.endswith("Z") and (int(offset[1:3]) > 23 or int(offset[4:6]) > 59):
            return False
        datetime.fromisoformat(value)
        return True
    except ValueError:
        return False


def _decode_time(value: Any) -> EventTime:
    item = object_value(value)
    time_zone = item.get("timeZone")
    require("timeZone" not in item or isinstance(time_zone, str) and 1 <= len(time_zone) <= 128)
    if matches(item.get("date"), _DATE) and "dateTime" not in item:
        try:
            date.fromisoformat(item["date"])
        except ValueError:
            raise CalendarError("INVALID_RESPONSE") from None
        return EventTime(date=item["date"], time_zone=time_zone)
    require("date" not in item and _valid_date_time(item.get("dateTime")))
    return EventTime(date_time=item["dateTime"], time_zone=time_zone)


def _decode_ref(value: Any) -> EventRef:
    item = object_value(value)
    require(matches(item.get("calendarId"), CALENDAR_ID) and matches(item.get("eventId"), EVENT_ID))
    return EventRef(item["calendarId"], item["eventId"])


def decode_event(value: Any) -> CalendarEvent:
    item = object_value(value)
    ref = _decode_ref(item.get("ref"))
    require(item.get("status") in ("confirmed", "tentative", "cancelled"))
    require("version" not in item or matches(item["version"], VERSION))
    for field in ("title", "location"):
        require(field not in item or isinstance(item[field], str) and len(item[field]) <= 8192)
    require("myResponse" not in item or item["myResponse"] in ("needsAction", *RSVP_STATUSES))
    require("recurringEventId" not in item or matches(item["recurringEventId"], EVENT_ID))
    return CalendarEvent(
        ref, item["status"], item.get("version"), item.get("title"),
        _decode_time(item["start"]) if "start" in item else None,
        _decode_time(item["end"]) if "end" in item else None,
        item.get("location"), item.get("myResponse"), item.get("recurringEventId"),
        _decode_time(item["originalStartTime"]) if "originalStartTime" in item else None,
    )


def decode_notification(value: Any, connection_id: str | None = None) -> Notification:
    item = object_value(value)
    schema = item.get("schemaVersion")
    bound = item.get("connectionId")
    require(type(schema) is int and schema == 1 and matches(bound, UUID))
    require(connection_id is None or connection_id == bound)
    cursor = item.get("cursor")
    require(matches(cursor, _CURSOR) and item.get("notificationId") == bound + ":" + cursor.split(".")[0])
    require(_valid_date_time(item.get("observedAt")))
    fields = item.get("changedFields")
    require(isinstance(fields, list) and all(isinstance(field, str) and field in _FIELDS for field in fields)
            and len(set(fields)) == len(fields))
    kind = item.get("type")
    reason = item.get("reason")
    ref = event = None
    if kind == "connection.gap":
        require(reason == "provider_cursor_expired" and "ref" not in item and "event" not in item and not fields)
    else:
        require(kind in CALENDAR_TYPES and fields)
        ref = _decode_ref(item.get("ref"))
        event = decode_event(item.get("event"))
        require(event.ref == ref)
        if kind == "event.cancelled":
            require(reason == "provider_cancelled_or_removed" and event.status == "cancelled")
        else:
            require("reason" not in item and event.status != "cancelled")
    return Notification(
        1, item["notificationId"], cursor, bound, kind, item["observedAt"],
        tuple(_FIELDS[field] for field in fields), ref, event, reason,
    )


def validated_url(value: str, origin_only: bool = False) -> str:
    try:
        require(isinstance(value, str) and len(value) <= 8192 and not re.search(r"[\s\\\x00-\x1f\x7f]", value))
        result = urlsplit(value)
        require(result.hostname and result.username is None and result.password is None and "#" not in value)
        require(result.scheme == "https" or result.scheme == "http" and result.hostname in {"127.0.0.1", "localhost", "::1"})
        require(result.port is None or 1 <= result.port <= 65535)
        if origin_only:
            require(result.path in ("", "/") and "?" not in value)
            return result.scheme + "://" + result.netloc
        return result.geturl()
    except (ValueError, CalendarError):
        raise CalendarError("INVALID_ARGUMENT" if origin_only else "INVALID_RESPONSE") from None
