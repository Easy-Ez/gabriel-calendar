# SDK and HTTP API

The implemented MVP contract is version 1. One deployment serves one test project and watches the primary calendar of each approved Google account. Its project sessions have deployment-assigned subjects. On first OAuth consent, a **connection** binds the subject to the owned primary calendar returned by Google. A **consumer** is an independent durable reader with its own checkpoint and scoped bearer credential.

## HTTP endpoints

Use HTTPS and `Authorization: Bearer <credential>` on authenticated routes. Project sessions authorize OAuth, pairing and disconnect. Consumer grants authorize delivery, reads and explicitly granted writes. The service checks the connection and consumer binding. The `X-Request-Id` header accompanies every response, and responses use `Cache-Control: no-store`.

| Method and path | Authorization | Success |
| --- | --- | --- |
| `GET /healthz` | Public | `200` with `{ "status": "ok" }` when the migrated database is reachable |
| `POST /v1/connect-sessions` | Project session | `201` with `sessionId`, `authorizationUrl` and `expiresAt`. Empty request body |
| `GET /v1/connect-sessions/{sessionId}` | Initiating project subject | `200` with `status` of `pending`, `connected` or `failed`, and `oauth` progress. A connected session includes `connectionId` |
| `GET /v1/google/oauth/callback` | One-time OAuth state and PKCE | `200` browser confirmation after linking. An expired or consumed state is rejected |
| `POST /v1/google/webhook` | Google channel headers | `204` for well-formed notifications, including duplicates and unmatched channels |
| `GET /v1/connections/{connectionId}` | Owner project session or bound consumer grant | `200` with `connectionId`, `status`, `watchedCalendars`, `lastSyncAt`, `lastWebhookAt`, `watchExpiresAt`, `capabilities` and `onboarding` |
| `POST /v1/connections/{connectionId}/disconnect` | Owner project session | `204` after local revocation. Empty request body |
| `POST /v1/connections/{connectionId}/consumers` | Owner project session | `201` with `connectionId`, `consumerId` and `credential`, returned once. The JSON body accepts `canRsvp`, `canCreate`, `canManage` and `canInvite`, all default false |
| `GET /v1/connections/{connectionId}/consumers/{consumerId}/stream` | Matching consumer grant | `200 text/event-stream`. The stream starts with `ready` and delivers ordered `notification` events |
| `GET /v1/connections/{connectionId}/consumers/{consumerId}/notifications?wait=25` | Matching consumer grant | Legacy HTTP long poll. `200` with `{ "notifications": [] }` or up to 25 ordered notifications. `wait` accepts 0–25 seconds and defaults to 0 |
| `POST /v1/connections/{connectionId}/consumers/{consumerId}/ack` | Matching consumer grant | `204` after advancing the contiguous processed prefix. The JSON body contains the last processed `cursor` |
| `GET /v1/connections/{connectionId}/calendars/{calendarId}/events?rsvp=needsAction` | Bound consumer grant | `200` with `events` and optional `nextPageCursor`. Accepts `primary` or the canonical calendar ID. Use `pageCursor` and `limit` (1–100, default 50) to paginate |
| `POST /v1/connections/{connectionId}/calendars/{calendarId}/events` | Bound consumer grant with create capability | `201` with the Google-confirmed event. Accepts `primary` or the canonical ID of the connected primary calendar |
| `PATCH /v1/connections/{connectionId}/calendars/{calendarId}/events/{eventId}` | Bound consumer grant with update capability | `200` with the updated Google event snapshot and its new version |
| `POST /v1/connections/{connectionId}/calendars/{calendarId}/events/{eventId}/cancel` | Bound consumer grant with cancel capability | `200` with the event reference and `status: "cancelled"` after Google confirms deletion |
| `PUT /v1/connections/{connectionId}/calendars/{calendarId}/events/{eventId}/rsvp` | Bound consumer grant with RSVP capability | `200` with Google's confirmed event snapshot. The JSON body contains only `status`, one of `accepted`, `tentative` or `declined`. Send the canonical calendar ID and optionally pass the event's `version` as `If-Match` |

Connection states are `active`, `auth_required` and `disconnected`. The timing fields are nullable RFC 3339 timestamps. Capabilities are `events.read`, `events.rsvp`, `events.create`, `events.update`, `events.cancel` and `events.invite`. When the initial baseline is pending, listing invitations, creating, updating and cancelling events return `SYNC_PENDING`. Reauthorization with the same subject and calendar preserves the connection ID and any unrevoked consumer. Disconnect the current connection before linking a different Google account. An active or authorization-required connection reserves its calendar to its project subject. Pairing an additional consumer starts it at the beginning of the retained notification window.

### Connection progress and timings

The connect-session `oauth` object reports `phase` (`waiting_for_callback`, `processing`, `completed` or `failed`) and `durationMs`. The top-level status remains `pending` while the callback is processing.

The connection `onboarding.stage` reports `waiting_for_initial_sync`, `initial_sync`, `waiting_for_watch`, `watch_registration`, `waiting_for_webhook`, `ready` or `unavailable`. Use it together with the current connection status and watch expiry.

| Field | Time measured |
| --- | --- |
| `oauthCallbackMs` | Valid OAuth callback claimed to successful account binding recorded |
| `syncQueueMs` | Binding recorded to the start of the first full-sync attempt |
| `initialSyncMs` | First full-sync attempt started to the baseline recorded, including retry delays |
| `watchQueueMs` | Baseline recorded to the start of the first Watch attempt |
| `watchRegistrationMs` | First Watch attempt started to registration recorded, including retry delays |
| `firstWebhookMs` | First Watch attempt started to the first accepted Google webhook |
| `totalMs` | Callback claimed to both Watch registration and first webhook recorded |

Durations are nonnegative integer milliseconds or `null` when unavailable. In particular, previously established connections show their readiness without historical timings. Watch registration and first-webhook timings share a start and may overlap. [Google initial sync message](https://developers.google.com/workspace/calendar/api/guides/push#sync-message)

### Creating an event

Successful create, update and cancel responses can include `X-Gabriel-Google-Confirmed-At`, the service clock in Unix milliseconds when the direct Google write response was received and decoded. A create confirmed by retrieving an already-existing event has no timing header. The response body remains the event snapshot.

Send a nonblank `title` of up to 512 UTF-16 code units, `start` and `end` as RFC 3339 date-times with an explicit offset and up to millisecond precision, and optionally `showAs` (`busy` by default, or `free`). The end must be after the start. This operation creates a single timed event without reminders. It accepts an optional `guests` array of up to 12 distinct ASCII email addresses. A nonempty array requires a boolean `notifyGuests` and the `events.invite` capability in addition to `events.create`.

Send an `Idempotency-Key` header with 1–128 ASCII letters, digits, underscores or hyphens. Use a fresh key for each intended event and reuse that key and input after a timeout or `OUTCOME_UNKNOWN`. The key is scoped to the connection across its consumers and calendar aliases. Changed input for a used key returns `IDEMPOTENCY_CONFLICT`. A successful retry returns the same Google event reference and its current snapshot. A previously confirmed event that Google reports as removed returns `NOT_FOUND`. Creation is disabled unless the deployment permits the project subject and the consumer was paired with `canCreate: true`.

### Updating and cancelling events

Use the canonical reference and current `version` from a Google-confirmed snapshot, such as a create response or a notification. Send the version as `If-Match`. A stale version returns `VERSION_CONFLICT`; an event that Google reports as removed returns `NOT_FOUND`. An uncertain provider write returns `OUTCOME_UNKNOWN`. Check the latest observed state before sending another write.

Update accepts a new `title`, a pair of `start` and `end`, or both. These fields follow the same validation as creation. Both operations require a primary-calendar timed single event organized by the linked account, an enabled deployment subject and a consumer paired with `canManage: true`. For an event with guests, both operations additionally require `events.invite` and a boolean `notifyGuests` in the body. For an event without guests, the cancel body can be empty JSON `{}`. Update preserves the guest list.

For operations involving guests, `notifyGuests: true` requests Google's `sendUpdates=all`; `false` requests `sendUpdates=none`. The latter can affect propagation to guest calendars. Google controls email delivery and whether an invitation appears in a guest's calendar. [Google event insertion](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) · [Guest calendar settings](https://developers.google.com/workspace/calendar/api/concepts/inviting-attendees-to-events)

### SSE delivery

Open the stream with `Accept: text/event-stream` and the bound bearer credential. Each `notification` event has one JSON envelope in its data. The server can send comment heartbeats during idle periods. The `ready` event has an empty JSON object as data.

An error before the stream opens uses the ordinary HTTP error response. An error after it opens is sent as an `error` event with the same JSON error envelope, numeric `status` and optional `retryAfter` in seconds. The server then closes the stream.

Only one reader can use a consumer at a time, including the legacy poll endpoint. The server waits for the ACK through the current batch before sending the next batch. Reconnect with the same consumer and credential to resume from the durable ACK. The HTTP `Last-Event-ID` header does not advance the checkpoint.

## Events and errors

An `EventRef` contains the canonical `calendarId` and `eventId`. An event contains `ref` and `status`. It can also include `version` (opaque ETag), `title`, `start`, `end`, `location`, `myResponse`, `recurringEventId` and `originalStartTime`. Timed events use RFC 3339 date-times. All-day events use dates with an exclusive end. `needsAction` is a readable response. RSVP on a recurring meeting requires a concrete instance.

The [notification schema](schema/notification.schema.json) defines the envelope. Calendar notifications have a reference and event snapshot. A cancellation snapshot can be a tombstone. A provider synchronization gap has a reason and no event reference. Use the stable `notificationId` to deduplicate side effects and the consumer-scoped `cursor` to acknowledge delivery.

Errors use `{ "error": { "code": "...", "message": "..." }, "requestId": "..." }`. A retry hint is expressed as seconds in `Retry-After` when available.

| HTTP | Codes |
| --- | --- |
| 400 | `INVALID_ARGUMENT` |
| 401 | `AUTH_REQUIRED` |
| 403 | `FORBIDDEN`, `OAUTH_CONSENT_DENIED`, `OAUTH_SCOPE_MISSING`, `OAUTH_OFFLINE_GRANT_MISSING`, `OAUTH_PRIMARY_UNAVAILABLE`, `OAUTH_PRIMARY_MISMATCH`, `OAUTH_PRIMARY_IN_USE`, `OAUTH_GOOGLE_DENIED` |
| 404 | `NOT_FOUND` |
| 409 | `VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `SYNC_PENDING`, `READER_BUSY`, `CONNECTION_BUSY` |
| 410 | `CURSOR_EXPIRED` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL` |
| 502 | `OUTCOME_UNKNOWN` |
| 503 | `PROVIDER_UNAVAILABLE` |

## SDK surface

| Operation | Node.js | Python |
| --- | --- | --- |
| Connect and pair | `await CalendarClient.connect(options)` | `await CalendarClient.connect(...)` |
| Attach to a stored grant | `new CalendarClient(options)` | `CalendarClient(...)` |
| Subscribe | `client.on(type, handler)` returns an unsubscribe function | Same or `@client.on(type)` |
| Run the listener | `await client.start()`, `await client.stop()` | Same or `async with client` |
| List pending invitations | `await client.events.listInvitations(query)` | `await client.events.list_invitations(...)` |
| Create an event | `await client.events.create("primary", { title, start, end, showAs }, { idempotencyKey })` | `await client.events.create("primary", title=title, start=start, end=end, show_as=show_as, idempotency_key=key)` |
| Update an event | `await client.events.update(ref, { start, end }, { ifMatch })` | `await client.events.update(ref, start=start, end=end, if_match=version)` |
| Cancel an event | `await client.events.cancel(ref, { ifMatch })` | `await client.events.cancel(ref, if_match=version)` |
| Set RSVP | `await client.events.rsvp(ref, status, { ifMatch })` | `await client.events.rsvp(ref, status, if_match=...)` |

`connect()` takes an HTTPS origin and a project credential supplier. An optional browser callback supports headless consent. The default uses the system browser on macOS and Linux in Node.js, and Python's `webbrowser` module in Python. Pass `canRsvp` or `can_rsvp` when pairing a consumer that needs to RSVP. The optional `saveGrant` or `save_grant` callback can save the returned grant to an approved secret store. Construct a client with that grant's connection ID, consumer ID and credential supplier to resume in a new process.

`start()` waits for the SSE `ready` frame. `stop()` closes the stream and drains the current item up to the configured deadline. Query and writes remain callable with the listener stopped. Pass `canCreate` or `can_create` when pairing a creator and `canManage` or `can_manage` for updates and cancellation. Errors are typed `CalendarError` instances with `code`, optional HTTP status, request ID and retry hint. Python exposes attributes and changed-field names in snake_case. Event types, response values and error codes are shared across languages.

For guest events, pass `guests` as part of the create input and choose `notifyGuests` in the Node.js options or `notify_guests` in Python for each write. Pair a guest-enabled consumer with `canInvite` or `can_invite` in addition to the corresponding create or manage permission.

Calendar selection, calendar management, general event queries and editing the guest list of an existing event remain in the later design scope.

[Behavior](behavior.md) · [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth) · [Conditional updates](https://developers.google.com/workspace/calendar/api/guides/version-resources)

## SDK examples

See the [Node.js quickstart](../sdks/node/README.md) or [Python quickstart](../sdks/python/README.md) for installation. These examples use application callbacks to obtain and store credentials, handle notifications, and select an invitation the user wants to answer.

```ts
import { CalendarClient } from "gabriel-calendar";

const client = await CalendarClient.connect({
  baseUrl: "https://calendar.example.invalid",
  getProjectCredential,
  saveGrant,
  canRsvp: true,
});

client.on("invitation.received", onInvitation);
await client.start();

try {
  const page = await client.events.listInvitations();
  const selected = await selectInvitation(page.events);
  if (selected) {
    await client.events.rsvp(selected.ref, "tentative", { ifMatch: selected.version });
  }
} finally {
  await client.stop();
}
```

```python
from gabriel_calendar import CalendarClient

client = await CalendarClient.connect(
    base_url="https://calendar.example.invalid",
    get_project_credential=get_project_credential,
    save_grant=save_grant,
    can_rsvp=True,
)
client.on("invitation.received", on_invitation)

async with client:
    page = await client.events.list_invitations()
    selected = await select_invitation(page.events)
    if selected is not None:
        await client.events.rsvp(selected.ref, "tentative", if_match=selected.version)
```

## Later API design

The following paths and SDK operations are reserved in the design for a later phase. All paths are relative to `/v1/connections/{connectionId}`.

| Proposed path | SDK operation |
| --- | --- |
| `PUT /watched-calendars` | `client.setWatchedCalendars(ids)` or `client.set_watched_calendars(ids)` |
| `GET /calendars` | `client.calendars.list()` |
| `POST /calendars` | `client.calendars.create(input)` |
| `GET /calendars/{calendarId}` | `client.calendars.get(id)` |
| `PATCH /calendars/{calendarId}` | `client.calendars.update(id, patch)` |
| `GET /calendars/{calendarId}/events` with time range and other filters | `client.events.list(query)` |
| `GET /calendars/{calendarId}/events/{eventId}` | `client.events.get(ref)` |

Calendar metadata includes title, description, time zone and access role. Event creation initially supports single events. Writes to an existing recurring event use a concrete instance. `primary` is accepted for list and create operations. Creates accept an `Idempotency-Key` scoped to project, connection and operation. A reused key with a changed body is a conflict. Version-sensitive writes support `If-Match`. Event writes affecting guests require a guest notification policy.
