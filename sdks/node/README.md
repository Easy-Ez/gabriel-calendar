# Gabriel Calendar SDK for Node.js

An ESM client for the Gabriel Calendar service. It connects a Google Calendar account, streams changes to the linked primary calendar over SSE, and supports pending invitations, RSVP, and single-event writes.

## Quick start

Use Node.js 22 or later. Ask the operator for the HTTPS base URL and the team enrollment token. If the app is External / Testing, your account must be on the Google OAuth test-user list. Supply the URL as `GABRIEL_BASE_URL` and inject `GABRIEL_ENROLLMENT_TOKEN` from your application's secret store.

```bash
npm install gabriel-calendar
```

Save this as `listen.mjs` and run `node listen.mjs`. On the first run, choose your approved Google account in the browser and allow access. On systems without a supported default browser launcher, pass an `openBrowser` callback to `connect()`.

```js
import { CalendarClient } from "gabriel-calendar";

const client = await CalendarClient.connect({
  baseUrl: process.env.GABRIEL_BASE_URL,
  token: process.env.GABRIEL_ENROLLMENT_TOKEN,
});

client.on("invitation.received", (notice) => {
  console.log(notice.type);
});

await client.start();
try {
  console.log("Listening for new invitations. Press Ctrl+C to stop.");
  await new Promise((resolve) => process.once("SIGINT", resolve));
} finally {
  await client.stop();
}
```

The first sync establishes the baseline. New invitations arrive over SSE. Use `client.events.listInvitations()` to query existing pending invitations after the initial sync. If the server returns `SYNC_PENDING`, retry after that sync completes.

## Resume a connection

Pass a `saveGrant` callback to `connect()` to store the returned `{ connectionId, consumerId, credential }` in your application's secret store. In later runs, load the same grant and use the constructor in place of `connect()`.

```js
import { CalendarClient } from "gabriel-calendar";

const client = new CalendarClient({
  baseUrl: process.env.GABRIEL_BASE_URL,
  connectionId: process.env.GABRIEL_CONNECTION_ID,
  consumerId: process.env.GABRIEL_CONSUMER_ID,
  getCredential: () => process.env.GABRIEL_CONSUMER_CREDENTIAL,
});
```

Register handlers and call `start()` as above. The SDK acknowledges notifications after the registered handlers succeed. Use `notificationId` to make handler side effects idempotent across restarts.

## Client API

| What you want to do | Method |
| --- | --- |
| Authorize a Google account | `await CalendarClient.connect({ baseUrl, token, saveGrant })` |
| Attach to a saved consumer | `new CalendarClient({ baseUrl, connectionId, consumerId, getCredential })` |
| Register a handler | `client.on(type, handler)` returns an unsubscribe function |
| Start and stop SSE | `await client.start()` and `await client.stop()` |
| List pending invitations | `await client.events.listInvitations({ calendarId, pageCursor, limit })` |
| Reply to an invitation | `await client.events.rsvp(ref, status, { ifMatch })` |
| Create an event | `await client.events.create("primary", input, { idempotencyKey, notifyGuests })` |
| Update or cancel | `await client.events.update(ref, patch, { ifMatch, notifyGuests })` or `await client.events.cancel(ref, { ifMatch, notifyGuests })` |

Register handlers for `invitation.received`, `event.created`, `event.updated`, `event.cancelled`, or `event.rsvp_changed`. RSVP accepts `accepted`, `tentative`, or `declined`. Use the `ref` and current `version` from the event snapshot when updating or cancelling.

The consumer grant supports writing to the linked primary calendar. Set `notifyGuests` explicitly to `true` or `false` when creating, updating or cancelling an event with guests.

For example, reschedule an event you organize and ask Google to notify the guests. Use `false` to skip the notification request.

```js
await client.events.update(
  event.ref,
  { start: "2030-01-03T15:00:00+08:00", end: "2030-01-03T15:30:00+08:00" },
  { ifMatch: event.version, notifyGuests: true },
);
```

[SDK method reference](https://github.com/Easy-Ez/gabriel-calendar/blob/main/spec/api.md#sdk-surface) · [Client examples](https://github.com/Easy-Ez/gabriel-calendar/blob/main/spec/api.md#sdk-examples) · [Service operator setup](https://github.com/Easy-Ez/gabriel-calendar/blob/main/docs/zh-CN/testing.md)
