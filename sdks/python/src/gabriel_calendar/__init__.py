"""Async SDK for the Gabriel Calendar service."""

from __future__ import annotations

import asyncio
import codecs
import inspect
import json
import re
import webbrowser
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import aclosing
from dataclasses import dataclass
from typing import Any, Literal, TypeVar
from urllib.parse import quote, urlencode

import httpx

from ._wire import (
    CALENDAR_ID, CREDENTIAL, EVENT_ID, RSVP_STATUSES, UUID, VERSION,
    CalendarError, CalendarEvent, EventRef, EventTime, Notification, Rsvp, decode_event,
    decode_notification, matches, object_value, require, validated_url,
)

__all__ = [
    "CalendarClient", "CalendarError", "CalendarEvent", "EventRef", "EventTime",
    "Grant", "InvitationPage", "LifecycleEvent", "Notification", "Rsvp", "decode_notification",
]

Credential = Callable[[], str | Awaitable[str]]
T = TypeVar("T")


@dataclass(frozen=True)
class Grant:
    connection_id: str
    consumer_id: str
    credential: str

    def __repr__(self) -> str:
        return "Grant(credential=[redacted])"


@dataclass(frozen=True)
class LifecycleEvent:
    type: str
    error: CalendarError | None = None
    reason: str | None = None
    attempt: int | None = None
    delay_ms: int | None = None
    code: str | None = None


@dataclass(frozen=True)
class InvitationPage:
    events: list[CalendarEvent]
    next_page_cursor: str | None = None


Handler = Callable[[Notification | LifecycleEvent], None | Awaitable[None]]


async def _result(value: T | Awaitable[T]) -> T:
    return await value if inspect.isawaitable(value) else value


async def _authorization(get_credential: Credential) -> str:
    try:
        credential = await _result(get_credential())
    except Exception:
        raise CalendarError("AUTH_REQUIRED") from None
    require(matches(credential, CREDENTIAL), "AUTH_REQUIRED")
    return "Bearer " + credential


def _response_error(payload: Any, status: int, request_id: Any, retry: Any) -> CalendarError:
    error = payload.get("error") if isinstance(payload, dict) else None
    code = error.get("code") if isinstance(error, dict) else None
    return CalendarError(
        code if matches(code, re.compile(r"[A-Z_]{1,64}")) else "HTTP_ERROR", status,
        request_id if matches(request_id, UUID) else None,
        min(3600, retry) if type(retry) is int and retry > 0 else None,
    )


def _checked_response(response: httpx.Response) -> Any:
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if not response.is_success:
        retry = response.headers.get("retry-after")
        raise _response_error(payload, response.status_code, response.headers.get("x-request-id"),
                              int(retry) if matches(retry, re.compile(r"[0-9]{1,4}")) else None)
    return payload


async def _request(
    base: str, path: str, get_credential: Credential, *, method: str = "GET",
    body: dict[str, Any] | None = None, if_match: str | None = None, idempotency_key: str | None = None,
) -> dict[str, Any] | None:
    headers = {"Authorization": await _authorization(get_credential)}
    if if_match is not None:
        headers["If-Match"] = if_match
    if idempotency_key is not None:
        headers["Idempotency-Key"] = idempotency_key
    try:
        # Use HTTPX's transport directly so its client logger does not record calendar IDs in URLs.
        async with asyncio.timeout(35), httpx.AsyncHTTPTransport(trust_env=False) as transport:
            request = httpx.Request(method, base + path, headers=headers, json=body)
            response = await transport.handle_async_request(request)
            try:
                await response.aread()
            finally:
                await response.aclose()
    except (httpx.HTTPError, TimeoutError):
        raise CalendarError("NETWORK_ERROR") from None
    if response.status_code == 204:
        return None
    return object_value(_checked_response(response))


async def _stream(base: str, path: str, get_credential: Credential) -> AsyncIterator[tuple[str, str]]:
    headers = {"Authorization": await _authorization(get_credential), "Accept": "text/event-stream"}
    try:
        async with httpx.AsyncHTTPTransport(trust_env=False) as transport:
            async with asyncio.timeout(35):
                response = await transport.handle_async_request(httpx.Request("GET", base + path, headers=headers))
            try:
                if not response.is_success:
                    async with asyncio.timeout(35):
                        await response.aread()
                    _checked_response(response)
                require(response.status_code == 200 and
                        response.headers.get("content-type", "").split(";")[0].strip().lower() == "text/event-stream")
                decoder = codecs.getincrementaldecoder("utf-8-sig")()
                chunks = response.aiter_bytes()
                newline = re.compile(r"\r\n|[\r\n]")
                buffer = event = data = ""
                size = 0
                comment = False
                while True:
                    try:
                        async with asyncio.timeout(35):
                            chunk = await anext(chunks)
                    except StopAsyncIteration:
                        raise CalendarError("NETWORK_ERROR") from None
                    try:
                        buffer += decoder.decode(chunk)
                    except UnicodeError:
                        raise CalendarError("INVALID_RESPONSE") from None
                    while match := newline.search(buffer):
                        if match.group() == "\r" and match.end() == len(buffer):
                            break
                        line, buffer = buffer[:match.start()], buffer[match.end():]
                        size += len(line) + 1
                        require(size <= 256 * 1024)
                        if not line:
                            frame = (event or "message", data[:-1]) if data else ("heartbeat", "") if comment else None
                            event = data = ""
                            size = 0
                            comment = False
                            if frame:
                                yield frame
                        elif line.startswith(":"):
                            comment = True
                        else:
                            field, _, raw = line.partition(":")
                            value = raw.removeprefix(" ")
                            if field == "event":
                                event = value
                            if field == "data":
                                data += value + "\n"
                    require(len(buffer) + size <= 256 * 1024)
            finally:
                await response.aclose()
    except (httpx.HTTPError, TimeoutError):
        raise CalendarError("NETWORK_ERROR") from None


async def _next_frame(frames: AsyncIterator[tuple[str, str]]) -> tuple[str, str]:
    return await anext(frames)


def _frame_data(value: str) -> Any:
    try:
        return json.loads(value)
    except ValueError:
        raise CalendarError("INVALID_RESPONSE") from None


async def _open_browser(url: str) -> None:
    if not await asyncio.to_thread(webbrowser.open, url):
        raise CalendarError("BROWSER_UNAVAILABLE")


def _retryable(error: CalendarError) -> bool:
    return (
        error.code in ("NETWORK_ERROR", "HANDLER_FAILED", "READER_BUSY", "RATE_LIMITED")
        or error.status is not None and error.status >= 500
    )


def _terminal(error: CalendarError) -> LifecycleEvent:
    if error.code == "CURSOR_EXPIRED":
        return LifecycleEvent("connection.gap", error=error, reason="cursor_expired")
    if error.code == "AUTH_REQUIRED":
        return LifecycleEvent("auth.required", error=error)
    return LifecycleEvent("connection.error", error=error)


@dataclass
class _Run:
    ready: asyncio.Future[None]
    task: asyncio.Task[None] | None = None
    intake: asyncio.Task[Any] | None = None
    stopping: bool = False
    abandoned: bool = False


class _Events:
    def __init__(self, client: CalendarClient) -> None:
        self._client = client

    async def create(
        self, calendar_id: str, *, title: str, start: str, end: str, idempotency_key: str,
        show_as: Literal["busy", "free"] | None = None,
        guests: list[str] | None = None, notify_guests: bool | None = None,
    ) -> CalendarEvent:
        require(
            matches(calendar_id, CALENDAR_ID) and matches(idempotency_key, re.compile(r"[A-Za-z0-9_-]{1,128}"))
            and all(isinstance(value, str) for value in (title, start, end))
            and (show_as is None or show_as in ("busy", "free"))
            and (guests is None or (isinstance(guests, list) and len(guests) <= 12
                                   and all(isinstance(guest, str) for guest in guests)))
            and (notify_guests is None or type(notify_guests) is bool)
            and (not guests or notify_guests is not None), "INVALID_ARGUMENT",
        )
        path = f"{self._client._path}/calendars/{quote(calendar_id, safe='')}/events"
        body: dict[str, Any] = {"title": title, "start": start, "end": end}
        if show_as is not None:
            body["showAs"] = show_as
        if guests is not None:
            body["guests"] = guests
        if notify_guests is not None:
            body["notifyGuests"] = notify_guests
        event = decode_event(await _request(
            self._client._base, path, self._client._credential, method="POST", body=body, idempotency_key=idempotency_key,
        ))
        require(calendar_id == "primary" or calendar_id == event.ref.calendar_id)
        return event

    async def update(
        self, ref: EventRef, *, if_match: str, title: str | None = None,
        start: str | None = None, end: str | None = None, notify_guests: bool | None = None,
    ) -> CalendarEvent:
        require((title is not None or start is not None or end is not None)
                and (title is None or isinstance(title, str))
                and ((start is None and end is None) or (isinstance(start, str) and isinstance(end, str))),
                "INVALID_ARGUMENT")
        patch = {key: value for key, value in (("title", title), ("start", start), ("end", end)) if value is not None}
        return await self._manage(ref, if_match, notify_guests, patch)

    async def cancel(self, ref: EventRef, *, if_match: str, notify_guests: bool | None = None) -> CalendarEvent:
        return await self._manage(ref, if_match, notify_guests)

    async def _manage(
        self, ref: EventRef, if_match: str, notify_guests: bool | None, patch: dict[str, str] | None = None,
    ) -> CalendarEvent:
        require(isinstance(ref, EventRef) and matches(ref.calendar_id, CALENDAR_ID)
                and matches(ref.event_id, EVENT_ID) and matches(if_match, VERSION)
                and (notify_guests is None or type(notify_guests) is bool), "INVALID_ARGUMENT")
        path = f"{self._client._path}/calendars/{quote(ref.calendar_id, safe='')}/events/{quote(ref.event_id, safe='')}"
        updating = patch is not None
        body: dict[str, Any] = dict(patch or {})
        if notify_guests is not None:
            body["notifyGuests"] = notify_guests
        event = decode_event(await _request(
            self._client._base, path if updating else path + "/cancel", self._client._credential,
            method="PATCH" if updating else "POST", body=body, if_match=if_match,
        ))
        require(event.ref == ref and (event.status != "cancelled" and event.version is not None
                                      if updating else event.status == "cancelled"))
        return event

    async def list_invitations(
        self, *, calendar_id: str = "primary", page_cursor: str | None = None, limit: int | None = None,
    ) -> InvitationPage:
        return await self._client.list_invitations(calendar_id=calendar_id, page_cursor=page_cursor, limit=limit)

    async def rsvp(self, ref: EventRef, status: Rsvp, *, if_match: str | None = None) -> CalendarEvent:
        require(
            isinstance(ref, EventRef) and matches(ref.calendar_id, CALENDAR_ID) and matches(ref.event_id, EVENT_ID)
            and status in RSVP_STATUSES and (if_match is None or matches(if_match, VERSION)), "INVALID_ARGUMENT",
        )
        path = f"{self._client._path}/calendars/{quote(ref.calendar_id, safe='')}/events/{quote(ref.event_id, safe='')}/rsvp"
        event = decode_event(await _request(
            self._client._base, path, self._client._credential, method="PUT", body={"status": status}, if_match=if_match,
        ))
        require(event.ref == ref)
        return event


class CalendarClient:
    def __init__(self, *, base_url: str, connection_id: str, consumer_id: str, get_credential: Credential) -> None:
        self._base = validated_url(base_url, origin_only=True)
        require(matches(connection_id, UUID) and matches(consumer_id, UUID) and callable(get_credential), "INVALID_ARGUMENT")
        self.connection_id = connection_id
        self.consumer_id = consumer_id
        self._credential = get_credential
        self._path = f"/v1/connections/{connection_id}"
        self._reader = f"{self._path}/consumers/{consumer_id}"
        self.events = _Events(self)
        self._handlers: dict[str, list[Handler]] = {}
        self._processed: set[str] = set()
        self._processed_order: deque[str] = deque()
        self._run: _Run | None = None

    @classmethod
    async def connect(
        cls, *, base_url: str, token: str,
        open_browser: Callable[[str], None | Awaitable[None]] | None = None,
        save_grant: Callable[[Grant], None | Awaitable[None]] | None = None,
    ) -> CalendarClient:
        base = validated_url(base_url, origin_only=True)
        require(matches(token, CREDENTIAL), "INVALID_ARGUMENT")
        try:
            async with asyncio.timeout(15 * 60):
                session = object_value(await _request(base, "/v1/connect-sessions", lambda: token, method="POST"))
                require(matches(session.get("sessionId"), UUID) and matches(session.get("sessionCredential"), CREDENTIAL))
                session_credential = session["sessionCredential"]
                path = f"/v1/connect-sessions/{session['sessionId']}"
                await _result((open_browser or _open_browser)(validated_url(session.get("authorizationUrl"))))
                while True:
                    result = object_value(await _request(base, path, lambda: session_credential))
                    if result.get("status") == "failed":
                        raise CalendarError("CONSENT_FAILED")
                    if result.get("status") == "connected":
                        connection = result.get("connectionId")
                        require(matches(connection, UUID))
                        grant = object_value(await _request(
                            base, f"{path}/consumer", lambda: session_credential, method="POST",
                        ))
                        require(grant.get("connectionId") == connection and matches(grant.get("consumerId"), UUID)
                                and matches(grant.get("credential"), CREDENTIAL))
                        credential = grant["credential"]
                        if save_grant is not None:
                            await _result(save_grant(Grant(connection, grant["consumerId"], credential)))
                        return cls(base_url=base, connection_id=connection, consumer_id=grant["consumerId"],
                                   get_credential=lambda: credential)
                    require(result.get("status") == "pending")
                    await asyncio.sleep(1)
        except TimeoutError:
            raise CalendarError("CONSENT_EXPIRED") from None

    def on(self, kind: str, handler: Handler | None = None):
        handlers = self._handlers.setdefault(kind, [])

        def subscribe(callback: Handler):
            if callback not in handlers:
                handlers.append(callback)
            return callback

        if handler is None:
            return subscribe
        subscribe(handler)

        def unsubscribe() -> None:
            if handler in handlers:
                handlers.remove(handler)

        return unsubscribe

    async def list_invitations(
        self, *, calendar_id: str = "primary", page_cursor: str | None = None, limit: int | None = None,
    ) -> InvitationPage:
        require(matches(calendar_id, CALENDAR_ID) and (page_cursor is None or matches(page_cursor, EVENT_ID))
                and (limit is None or type(limit) is int and 1 <= limit <= 100), "INVALID_ARGUMENT")
        query = {"rsvp": "needsAction"}
        if page_cursor is not None:
            query["pageCursor"] = page_cursor
        if limit is not None:
            query["limit"] = str(limit)
        path = f"{self._path}/calendars/{quote(calendar_id, safe='')}/events?{urlencode(query)}"
        result = object_value(await _request(self._base, path, self._credential))
        events = result.get("events")
        next_cursor = result.get("nextPageCursor")
        require(isinstance(events, list) and len(events) <= 100
                and ("nextPageCursor" not in result or matches(next_cursor, EVENT_ID)))
        return InvitationPage([decode_event(event) for event in events], next_cursor)

    async def start(self) -> None:
        if self._run is not None:
            raise CalendarError("INVALID_STATE")
        run = _Run(asyncio.get_running_loop().create_future())
        self._run = run
        run.task = asyncio.create_task(self._listen(run))
        try:
            await asyncio.wait_for(asyncio.shield(run.ready), timeout=35)
        except TimeoutError:
            run.ready.cancel()
            await self.stop(drain=0)
            raise CalendarError("NETWORK_TIMEOUT") from None
        except BaseException:
            run.ready.cancel()
            await self.stop(drain=0)
            raise

    async def stop(self, *, drain: float = 10.0) -> None:
        require(type(drain) in (int, float) and 0 <= drain <= 60, "INVALID_ARGUMENT")
        run = self._run
        if run is None or run.task is None:
            return
        run.stopping = True
        if run.intake is not None:
            run.intake.cancel()
        if run.task is asyncio.current_task():
            return
        _, pending = await asyncio.wait({run.task}, timeout=drain)
        if pending:
            run.abandoned = True
            run.task.cancel()

    async def __aenter__(self) -> CalendarClient:
        await self.start()
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.stop()

    async def _intake(self, run: _Run, awaitable: Any) -> Any:
        run.intake = asyncio.create_task(awaitable)
        try:
            return await run.intake
        finally:
            run.intake = None

    async def _emit(self, event: Notification | LifecycleEvent, run: _Run, strict: bool) -> None:
        for handler in tuple(self._handlers.get(event.type, ())):
            if run.abandoned or (not strict and run.stopping):
                return
            try:
                await _result(handler(event))
            except Exception:
                if strict:
                    raise CalendarError("HANDLER_FAILED") from None

    async def _process(self, event: Notification, run: _Run) -> None:
        if event.notification_id not in self._processed:
            await self._emit(event, run, strict=True)
            if run.abandoned:
                return
            self._processed.add(event.notification_id)
            self._processed_order.append(event.notification_id)
            if len(self._processed_order) > 1024:
                self._processed.remove(self._processed_order.popleft())
        if not run.abandoned:
            result = await _request(
                self._base, self._reader + "/ack", self._credential, method="POST", body={"cursor": event.cursor},
            )
            require(result is None)

    async def _listen(self, run: _Run) -> None:
        ready = False
        attempt = 0
        try:
            while not run.stopping:
                try:
                    opened = False
                    async with aclosing(_stream(self._base, self._reader + "/stream", self._credential)) as frames:
                        while not run.stopping:
                            # Wrap anext in a coroutine because create_task requires one.
                            frame = await self._intake(run, _next_frame(frames))
                            if run.stopping:
                                break
                            kind, raw = frame
                            if kind == "heartbeat":
                                if opened:
                                    attempt = 0
                                continue
                            if kind == "ready":
                                require(not opened)
                                object_value(_frame_data(raw))
                                opened = ready = True
                                if not run.ready.done():
                                    run.ready.set_result(None)
                                await self._emit(LifecycleEvent("connection.ready"), run, strict=False)
                                continue
                            if kind == "error":
                                data = object_value(_frame_data(raw))
                                status = data.get("status")
                                require(type(status) is int and 400 <= status <= 599)
                                raise _response_error(data, status, data.get("requestId"), data.get("retryAfter"))
                            require(opened and kind == "notification")
                            await self._process(decode_notification(_frame_data(raw), self.connection_id), run)
                            attempt = 0
                except CalendarError as error:
                    if run.stopping:
                        break
                    if not _retryable(error):
                        if not run.ready.done():
                            run.ready.set_exception(error)
                        await self._emit(_terminal(error), run, strict=False)
                        return
                    attempt += 1
                    delay_ms = error.retry_after * 1000 if error.retry_after else min(250 * 2 ** min(attempt - 1, 7), 30_000)
                    await self._emit(
                        LifecycleEvent("connection.reconnecting", attempt=attempt, delay_ms=delay_ms, code=error.code),
                        run, strict=False,
                    )
                    if not run.stopping:
                        await self._intake(run, asyncio.sleep(delay_ms / 1000))
        except asyncio.CancelledError:
            if not run.stopping:
                raise
        finally:
            if not run.ready.done():
                run.ready.set_exception(CalendarError("INVALID_STATE"))
            self._run = None
