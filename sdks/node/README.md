# Gabriel Calendar SDK for Node.js

An ESM client for the Gabriel Calendar service. It connects a Google Calendar account, streams changes to the linked primary calendar over SSE, and supports pending invitations, RSVP, and single-event writes.

## Quick start

Use Node.js 22 or later. If your team hosts Gabriel Calendar, ask the operator for the HTTPS base URL and your own project session. The operator needs to add your account to the Google OAuth test users if the app is External / Testing. Supply the URL as `GABRIEL_BASE_URL` and inject the session as `GABRIEL_PROJECT_SESSION` from your application's secret store.

```bash
npm install gabriel-calendar
```

Save this as `listen.mjs` and run `node listen.mjs`. On the first run, choose your approved Google account in the browser and allow access. On systems without a supported default browser launcher, pass an `openBrowser` callback to `connect()`.

```js
import { CalendarClient } from "gabriel-calendar";

const client = await CalendarClient.connect({
  baseUrl: process.env.GABRIEL_BASE_URL,
  getProjectCredential: () => process.env.GABRIEL_PROJECT_SESSION,
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

Ask the service operator to enable writes you need, then request `canRsvp`, `canCreate`, or `canManage` when pairing the consumer. For a guest event, also request `canInvite` and set `notifyGuests` explicitly on each write. Creation takes an idempotency key, and updates and cancellations take the current event version.

[SDK method reference](https://github.com/Easy-Ez/gabriel-calendar/blob/main/spec/api.md#sdk-surface) · [Client examples](https://github.com/Easy-Ez/gabriel-calendar/blob/main/spec/api.md#sdk-examples) · [Service operator setup](https://github.com/Easy-Ez/gabriel-calendar/blob/main/docs/zh-CN/testing.md)
