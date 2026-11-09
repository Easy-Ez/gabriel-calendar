# Gabriel Calendar SDK for Node.js

An ESM client for the Gabriel Calendar service. It connects a Google Calendar account, streams changes to the linked primary calendar over SSE, and supports pending invitations, RSVP, and single-event writes.

## Install

```bash
npm install gabriel-calendar
```

Requires Node.js 22 or later, a Gabriel Calendar service URL, and a project session supplied by the service operator. Load the session from your application's secret store and pass it through `getProjectCredential`.

```js
import { CalendarClient } from "gabriel-calendar";

const client = await CalendarClient.connect({
  baseUrl: "https://calendar.example.invalid",
  getProjectCredential: () => process.env.GABRIEL_PROJECT_SESSION,
});
client.on("invitation.received", (notice) => {
  console.log(notice.type);
});

await client.start();
try {
  const { events } = await client.events.listInvitations();
  console.log("Pending invitations", events.length);
} finally {
  await client.stop();
}
```

`connect()` opens the Google consent page and pairs a consumer. Use `saveGrant` to store its connection ID, consumer ID, and credential in a secret store. Construct a new `CalendarClient` with those IDs and a `getCredential` callback to resume delivery in another process. Notifications are acknowledged after the registered handlers succeed. Use `notificationId` to make handler side effects idempotent across restarts.

Request `canRsvp`, `canCreate`, or `canManage` when pairing a writer. For a guest event, also request `canInvite` and set `notifyGuests` explicitly on each write. Creation takes an idempotency key, and updates and cancellations take the current event version.

[SDK and HTTP contract](https://github.com/Easy-Ez/gabriel-calendar/blob/main/spec/api.md) · [Service setup](https://github.com/Easy-Ez/gabriel-calendar/blob/main/docs/zh-CN/testing.md)
