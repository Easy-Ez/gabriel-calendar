# SDK and HTTP API

Status: draft for the MVP. Method names and paths are proposals. Code examples show the intended interfaces.

## Client identity and connection

A **project** owns an OAuth application configuration. A **connection** belongs to one project and one authorized user and links that user to one Google account. A **consumer** is a durable notification reader for one connection. Two independent applications use two consumers and keep separate delivery positions.

A project or account session authorizes configuration and pairing. A bound SDK client receives a separate, revocable grant scoped to its connection, consumer, and allowed capabilities. The service checks resource ownership on every operation and checks both the SDK grant and the Google permission before writes. Browser callbacks validate OAuth state bound to the originating project and user. Google credentials stay in the service's secret manager.

## Public SDK

| Operation | Node.js | Python |
| --- | --- | --- |
| Authorize Google account | `CalendarClient.connect(options)` | `await CalendarClient.connect(options)` |
| Attach to an existing grant | `new CalendarClient(options)` | `CalendarClient(...)` |
| Register an event handler | `client.on(type, handler)` | `client.on(type, handler)` or decorator |
| Run the listener | `await client.start()` and `await client.stop()` | `async with client` or explicit `start()` and `stop()` |
| Watch selected calendars | `client.setWatchedCalendars(ids)` | `client.set_watched_calendars(ids)` |
| Read calendars | `client.calendars.list()`, `.get(id)` | Same |
| Manage calendars | `client.calendars.create(input)`, `.update(id, patch)` | Same |
| Read events | `client.events.list(query)`, `.get(ref)` | Same |
| Manage events | `client.events.create(calendarId, input, options)`, `.update(ref, patch, options)`, `.cancel(ref, options)` | Same with Python keyword arguments |
| Respond to an invitation | `client.events.rsvp(ref, status, options)` | Same |

`connect()` takes an authenticated project session and an optional browser-opening callback. It returns a bound client after consent and pairing. Headless clients can display the consent URL and wait for completion. `start()` starts the background listener and resolves after the server confirms the consumer can read. `stop()` stops new polling and drains handlers up to a deadline. Ordinary query and write methods remain available when the listener is stopped.

`EventRef` contains the canonical `calendarId` and `eventId` returned by the service. The client already knows its connection. `primary` is accepted for list and create operations; responses carry the canonical ID. A recurring instance has its own reference and may also carry `recurringEventId` and `originalStartTime`. MVP writes to existing recurring events require a concrete instance. The initial event creation API supports single events.

```ts
const client = new CalendarClient({ baseUrl, connectionId, consumerId, getCredential });

client.on("invitation.received", async ({ event }) => {
  await storeInvitation(event);
});

await client.start();
```

```ts
// Called after the user selects Maybe on a specific invitation.
const event = await client.events.rsvp(eventRef, "tentative");
```

```python
client = CalendarClient(
    base_url=base_url,
    connection_id=connection_id,
    consumer_id=consumer_id,
    get_credential=get_credential,
)

@client.on("invitation.received")
async def on_invitation(notification):
    await store_invitation(notification.event)

async with client:
    await run_application()
```

```python
# Called after the user selects Maybe on a specific invitation.
event = await client.events.rsvp(event_ref, "tentative")
```

## HTTP endpoints

All public endpoints use HTTPS. Paths containing `{connectionId}` are scoped to that connection. Responses carry a request ID for troubleshooting.

| Method and path | Result |
| --- | --- |
| `POST /v1/connect-sessions` | Create an expiring OAuth session; return its ID and browser authorization URL |
| `GET /v1/connect-sessions/{sessionId}` | Read the caller's consent status and resulting connection ID |
| `GET /v1/connections/{connectionId}` | Read connection status, granted capabilities, watched calendars and last successful sync |
| `PUT /v1/connections/{connectionId}/watched-calendars` | Replace the authorized list of calendars to monitor |
| `POST /v1/connections/{connectionId}/disconnect` | Disable this connection and revoke its SDK grants |
| `POST /v1/connections/{connectionId}/consumers` | Pair a reader to this connection with its own delivery position |
| `GET /v1/connections/{connectionId}/consumers/{consumerId}/notifications?wait=25` | Long poll for a bounded batch of ordered, unacknowledged notifications |
| `POST /v1/connections/{connectionId}/consumers/{consumerId}/ack` | Acknowledge a contiguous prefix using the cursor returned for its last notification |
| `GET /v1/connections/{connectionId}/calendars` | List calendars and their access roles |
| `POST /v1/connections/{connectionId}/calendars` | Create a secondary calendar |
| `GET /v1/connections/{connectionId}/calendars/{calendarId}` | Read calendar metadata |
| `PATCH /v1/connections/{connectionId}/calendars/{calendarId}` | Change title, description, or time zone |
| `GET /v1/connections/{connectionId}/calendars/{calendarId}/events` | List events with an optional time range, RSVP filter and page cursor |
| `POST /v1/connections/{connectionId}/calendars/{calendarId}/events` | Create an event |
| `GET /v1/connections/{connectionId}/calendars/{calendarId}/events/{eventId}` | Read a specific event |
| `PATCH /v1/connections/{connectionId}/calendars/{calendarId}/events/{eventId}` | Edit an allowed subset of event fields |
| `PUT /v1/connections/{connectionId}/calendars/{calendarId}/events/{eventId}/rsvp` | Set the current user's response |
| `POST /v1/connections/{connectionId}/calendars/{calendarId}/events/{eventId}/cancel` | Cancel one event the caller is authorized to manage |

OAuth callbacks and Google webhook ingress are provider-facing routes. Project OAuth registration is an authenticated control-panel operation; SDK credentials cannot read or change those settings.

## Data and errors

- A calendar exposes `id`, `title`, `description`, `timeZone` and the caller's access role when available.
- An event exposes `ref`, `version` (opaque), `title`, `start`, `end`, `location`, `status`, `myResponse` and the recurring event references where applicable. Timed events use RFC 3339 date-times; all-day events use dates with an exclusive end.
- An RSVP body is `{ "status": "tentative" }`. Allowed writes are `accepted`, `tentative` and `declined`. `needsAction` is a readable state.
- Event creates, edits and cancellations that affect guests require a guest notification policy. Version-sensitive writes accept `If-Match` and return a conflict if the version changed. Both create endpoints accept an `Idempotency-Key` so callers can repeat an ambiguous request with the same key.
- Every delivery has `schemaVersion`, `notificationId`, `cursor`, `connectionId`, `type`, `ref`, `observedAt` and `changedFields`. The event snapshot is included when available. A cancellation can be a tombstone with only its reference, recurrence identifiers and reason.
- Expected error codes include `AUTH_REQUIRED`, `FORBIDDEN`, `NOT_FOUND`, `INVALID_ARGUMENT`, `VERSION_CONFLICT`, `CURSOR_EXPIRED`, `RATE_LIMITED` and `OUTCOME_UNKNOWN`. The SDK maps these codes to typed errors and honors the service's retry hint for rate limits.

The Node.js and Python SDKs share a language-neutral wire schema. Python maps public attribute names to snake_case while preserving the values and semantics on the wire. See [behavior](behavior.md) for synchronization, delivery and mutation rules.

[Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth) · [Google event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events) · [Conditional updates](https://developers.google.com/workspace/calendar/api/guides/version-resources)
