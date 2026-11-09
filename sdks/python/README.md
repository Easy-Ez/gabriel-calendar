# Gabriel Calendar SDK for Python

An async client for the Gabriel Calendar service. It connects a Google Calendar account, streams changes to the linked primary calendar over SSE, and supports pending invitations, RSVP, and single-event writes.

## Install

```bash
python -m pip install gabriel-calendar
```

Requires Python 3.11 or later, a Gabriel Calendar service URL, and a project session supplied by the service operator. Load the session from your application's secret store and pass it through `get_project_credential`.

```python
import asyncio
import os

from gabriel_calendar import CalendarClient


async def main():
    client = await CalendarClient.connect(
        base_url="https://calendar.example.invalid",
        get_project_credential=lambda: os.environ["GABRIEL_PROJECT_SESSION"],
    )

    @client.on("invitation.received")
    def handle_invitation(notice):
        print(notice.type)

    async with client:
        page = await client.events.list_invitations()
        print("Pending invitations", len(page.events))


asyncio.run(main())
```

`connect()` opens the Google consent page and pairs a consumer. Use `save_grant` to store its connection ID, consumer ID, and credential in a secret store. Construct a new `CalendarClient` with those IDs and a `get_credential` callback to resume delivery in another process. Notifications are acknowledged after the registered handlers succeed. Use `notification_id` to make handler side effects idempotent across restarts.

Request `can_rsvp`, `can_create`, or `can_manage` when pairing a writer. For a guest event, also request `can_invite` and set `notify_guests` explicitly on each write. Creation takes an idempotency key, and updates and cancellations take the current event version.

[SDK and HTTP contract](https://github.com/Easy-Ez/gabriel-calendar/blob/main/spec/api.md) · [Service setup](https://github.com/Easy-Ez/gabriel-calendar/blob/main/docs/zh-CN/testing.md)
