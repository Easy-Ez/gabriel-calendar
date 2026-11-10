from __future__ import annotations

import asyncio
import json
import secrets as random_source
import threading
import unittest
from collections import deque
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from gabriel_calendar import CalendarClient, CalendarError, Notification, decode_notification

FIXTURE = json.loads((Path(__file__).resolve().parents[3] / "spec/fixtures/mvp.json").read_text())


@contextmanager
def harness(test, steps):
    credentials = {kind: random_source.token_urlsafe(32) for kind in ("enrollment", "session", "grant")}
    remaining = deque(steps)
    failures = []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def run_step(self):
            try:
                step = remaining.popleft()
                test.assertEqual(self.path, step["path"])
                test.assertEqual(self.command, step["method"])
                expected = credentials[step.get("auth", "grant")]
                test.assertTrue(self.headers.get("Authorization") == "Bearer " + expected)
                test.assertEqual(self.headers.get("If-Match"), step.get("ifMatch"))
                test.assertEqual(self.headers.get("Idempotency-Key"), step.get("idempotencyKey"))
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length)) if length else None
                test.assertEqual(body, step.get("body"))
                if step["status"] == 0:
                    self.close_connection = True
                    return
                if "stream" in step:
                    test.assertEqual(self.headers.get("Accept"), "text/event-stream")
                    def frame(kind, payload):
                        return f"event: {kind}\r\ndata: {json.dumps(payload)}\r\n\r\n".encode()
                    data = b": synthetic heartbeat\r\n\r\n" + frame("ready", {})
                    data += b"".join(frame("notification", FIXTURE["notifications"][key]) for key in step["stream"])
                    if "streamError" in step:
                        data += frame("error", step["streamError"])
                    self.send_response(step["status"])
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    try:
                        for offset in range(0, len(data), 53):
                            chunk = data[offset:offset + 53]
                            self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                        self.wfile.write(b"0\r\n\r\n")
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    self.close_connection = True
                    return
                payload = step.get("payload")
                if step.get("issueSession"):
                    payload = {**payload, "sessionCredential": credentials["session"]}
                if step.get("grant"):
                    payload = {**payload, "credential": credentials["grant"]}
                data = json.dumps(payload).encode() if payload is not None else b""
                self.send_response(step["status"])
                self.send_header("X-Request-Id", FIXTURE["requestId"])
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Type", "application/json")
                if step.get("retryAfter"):
                    self.send_header("Retry-After", str(step["retryAfter"]))
                self.end_headers()
                self.wfile.write(data)
            except Exception as error:
                failures.append(error)
                self.close_connection = True

        do_GET = do_POST = do_PUT = do_PATCH = run_step

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.02), daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", credentials["enrollment"], credentials["grant"]
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
        if failures:
            raise failures[0]
        test.assertFalse(remaining)


class Conformance(unittest.IsolatedAsyncioTestCase):
    def test_decode(self):
        for raw in FIXTURE["notifications"].values():
            event = decode_notification(raw, FIXTURE["connectionId"])
            self.assertEqual(event.notification_id, raw["notificationId"])
            self.assertEqual(event.type, raw["type"])
        invitation = decode_notification(FIXTURE["notifications"]["invitation"])
        self.assertEqual(invitation.event.start.date_time, "2030-01-01T12:00:00+08:00")
        self.assertEqual(invitation.event.original_start_time.date, "2030-01-01")
        self.assertEqual(invitation.changed_fields, ("status", "my_response"))
        for raw in FIXTURE["invalidNotifications"]:
            with self.assertRaisesRegex(CalendarError, "INVALID_RESPONSE"):
                decode_notification(raw)

    async def test_lifecycle(self):
        with harness(self, FIXTURE["steps"]) as (base, token, grant):
            client = await CalendarClient.connect(
                base_url=base, token=token,
                open_browser=lambda url: self.assertEqual(url, "https://consent.example.invalid/authorize"),
                save_grant=lambda saved: self.assertTrue(saved.credential == grant),
            )
            self.assertEqual(client.consumer_id, FIXTURE["consumerId"])
            raw = FIXTURE["createInput"]
            options = dict(start=raw["start"], end=raw["end"], show_as=raw["showAs"], idempotency_key=FIXTURE["createKey"])
            with self.assertRaisesRegex(CalendarError, "INVALID_ARGUMENT"):
                await client.events.create("primary", title=raw["title"], guests=raw["guests"], **options)
            options.update(guests=raw["guests"], notify_guests=raw["notifyGuests"])
            created = await client.events.create("primary", title=raw["title"], **options)
            self.assertEqual(created.title, raw["title"])
            self.assertEqual(created.ref.event_id, "syntheticcreated")
            with self.assertRaisesRegex(CalendarError, "IDEMPOTENCY_CONFLICT"):
                await client.events.create("primary", title="Changed appointment", **options)
            patch = FIXTURE["updateInput"]
            with self.assertRaisesRegex(CalendarError, "INVALID_ARGUMENT"):
                await client.events.update(created.ref, start=patch["start"], if_match=created.version)
            updated = await client.events.update(created.ref, **patch, if_match=created.version, notify_guests=False)
            self.assertEqual(updated.start.date_time, patch["start"])
            with self.assertRaisesRegex(CalendarError, "VERSION_CONFLICT"):
                await client.events.cancel(created.ref, if_match=created.version, notify_guests=True)
            self.assertEqual((await client.events.cancel(updated.ref, if_match=updated.version, notify_guests=True)).status, "cancelled")
            [event] = (await client.events.list_invitations()).events
            self.assertEqual(event.my_response, "needsAction")
            reply = await client.events.rsvp(event.ref, "tentative", if_match=event.version)
            self.assertEqual(reply.my_response, "tentative")
            with self.assertRaisesRegex(CalendarError, "VERSION_CONFLICT") as failure:
                await client.events.rsvp(event.ref, "tentative", if_match='"stale"')
            self.assertEqual(failure.exception.request_id, FIXTURE["requestId"])
            retries = []
            processed = []
            gaps = []
            terminal = asyncio.Event()
            first = True

            @client.on("connection.reconnecting")
            def retry(event):
                retries.append((event.code, event.delay_ms))

            @client.on("invitation.received")
            async def invite(event):
                nonlocal first
                if first:
                    first = False
                    raise RuntimeError("Synthetic handler failure")
                processed.append(event.notification_id)

            client.on("event.rsvp_changed", lambda event: processed.append(event.notification_id))

            @client.on("connection.gap")
            def gap(event):
                if isinstance(event, Notification):
                    processed.append(event.notification_id)
                else:
                    gaps.append(event.error.code)
                    terminal.set()

            async with asyncio.timeout(8), client:
                await terminal.wait()
            self.assertEqual(gaps, ["CURSOR_EXPIRED"])
            self.assertEqual(retries, [tuple(pair) for pair in FIXTURE["expectedRetries"]])
            self.assertEqual(processed, [
                event["notificationId"] for event in FIXTURE["notifications"].values() if event["type"] != "event.cancelled"
            ])

    async def test_initial_auth_error(self):
        connection, consumer = FIXTURE["connectionId"], FIXTURE["consumerId"]
        path = f"/v1/connections/{connection}/consumers/{consumer}/stream"
        steps = [{"method": "GET", "path": path, "status": 401, "payload": FIXTURE["authError"]}]
        with harness(self, steps) as (base, _, grant):
            client = CalendarClient(base_url=base, connection_id=connection, consumer_id=consumer, get_credential=lambda: grant)
            auth = []
            client.on("auth.required", lambda event: auth.append(event.error.code))
            with self.assertRaisesRegex(CalendarError, "AUTH_REQUIRED"):
                await client.start()
            self.assertEqual(auth, ["AUTH_REQUIRED"])

    async def test_stop_drains_current_handler(self):
        with harness(self, FIXTURE["drainSteps"]) as (base, _, grant):
            client = CalendarClient(base_url=base, connection_id=FIXTURE["connectionId"],
                                    consumer_id=FIXTURE["consumerId"], get_credential=lambda: grant)
            entered = asyncio.Event()
            blocked = asyncio.Event()
            processed = []

            @client.on("invitation.received")
            async def first(event):
                entered.set()
                await blocked.wait()
                processed.append(event.type)

            client.on("event.rsvp_changed", lambda event: processed.append(event.type))
            async with asyncio.timeout(3):
                await client.start()
                await entered.wait()
                drained = asyncio.create_task(client.stop())
                await asyncio.sleep(0)
                blocked.set()
                await drained
            self.assertEqual(processed, ["invitation.received"])
