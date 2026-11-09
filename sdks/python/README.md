# Gabriel Calendar SDK for Python

An async client for the Gabriel Calendar service. It connects a Google Calendar account, streams changes to the linked primary calendar over SSE, and supports pending invitations, RSVP, and single-event writes.

## Quick start

Use Python 3.11 or later. If your team hosts Gabriel Calendar, ask the operator for the HTTPS base URL and your own project session. The operator needs to add your account to the Google OAuth test users if the app is External / Testing. Supply the URL as `GABRIEL_BASE_URL` and inject the session as `GABRIEL_PROJECT_SESSION` from your application's secret store.

```bash
python -m pip install gabriel-calendar
```

Save this as `listen.py` and run `python listen.py`. On the first run, choose your approved Google account in the browser and allow access. For a custom browser launcher, pass an `open_browser` callback to `connect()`.

```python
import asyncio
import os

from gabriel_calendar import CalendarClient


async def main():
    client = await CalendarClient.connect(
        base_url=os.environ["GABRIEL_BASE_URL"],
        get_project_credential=lambda: os.environ["GABRIEL_PROJECT_SESSION"],
    )

    @client.on("invitation.received")
    def handle_invitation(notice):
        print(notice.type)

    async with client:
        print("Listening for new invitations. Press Ctrl+C to stop.")
        await asyncio.Event().wait()


try:
    asyncio.run(main())
except KeyboardInterrupt:
    pass
```

The first sync establishes the baseline. New invitations arrive over SSE. Use `await client.events.list_invitations()` to query existing pending invitations after the initial sync. If the server returns `SYNC_PENDING`, retry after that sync completes.

## Resume a connection

Pass a `save_grant` callback to `connect()` to store the returned grant's `connection_id`, `consumer_id` and `credential` in your application's secret store. In later runs, load the same grant and use the constructor in place of `connect()`.

```python
import os

from gabriel_calendar import CalendarClient

client = CalendarClient(
    base_url=os.environ["GABRIEL_BASE_URL"],
    connection_id=os.environ["GABRIEL_CONNECTION_ID"],
    consumer_id=os.environ["GABRIEL_CONSUMER_ID"],
    get_credential=lambda: os.environ["GABRIEL_CONSUMER_CREDENTIAL"],
)
```

Register handlers and enter `async with client` as above. The SDK acknowledges notifications after the registered handlers succeed. Use `notification_id` to make handler side effects idempotent across restarts.

## Client API

| What you want to do | Method |
| --- | --- |
| Authorize a Google account | `await CalendarClient.connect(base_url=..., get_project_credential=..., save_grant=...)` |
| Attach to a saved consumer | `CalendarClient(base_url=..., connection_id=..., consumer_id=..., get_credential=...)` |
| Register a handler | `client.on(type, handler)` returns an unsubscribe function, or use `@client.on(type)` |
| Start and stop SSE | `async with client`, or `await client.start()` and `await client.stop()` |
| List pending invitations | `await client.events.list_invitations(calendar_id=..., page_cursor=..., limit=...)` |
| Reply to an invitation | `await client.events.rsvp(ref, status, if_match=...)` |
| Create an event | `await client.events.create("primary", title=..., start=..., end=..., idempotency_key=..., notify_guests=...)` |
| Update or cancel | `await client.events.update(ref, start=..., end=..., if_match=..., notify_guests=...)` or `await client.events.cancel(ref, if_match=..., notify_guests=...)` |

Register handlers for `invitation.received`, `event.created`, `event.updated`, `event.cancelled`, or `event.rsvp_changed`. RSVP accepts `accepted`, `tentative`, or `declined`. Use the `ref` and current `version` from the event snapshot when updating or cancelling.

Ask the service operator to enable writes you need, then request `can_rsvp`, `can_create`, or `can_manage` when pairing the consumer. For a guest event, also request `can_invite` and set `notify_guests` explicitly on each write.

[SDK method reference](https://github.com/Easy-Ez/gabriel-calendar/blob/main/spec/api.md#sdk-surface) · [Client examples](https://github.com/Easy-Ez/gabriel-calendar/blob/main/spec/api.md#sdk-examples) · [Service operator setup](https://github.com/Easy-Ez/gabriel-calendar/blob/main/docs/zh-CN/testing.md)
