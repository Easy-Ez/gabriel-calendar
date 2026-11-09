# Gabriel Calendar

[简体中文](README.zh-CN.md)

Gabriel Calendar is a standalone Google Calendar service with Node.js and Python SDKs. It handles Google Web OAuth, webhook subscriptions, incremental synchronization and notification delivery. Local applications use HTTPS to follow changes to an approved user's primary calendar, list pending invitations, RSVP and manage single events with explicit guest notification choices.

The MVP supports one Google test project and approved accounts. Both SDKs run the same protocol fixtures. The service has been exercised against a simulated Google HTTP API and PostgreSQL and in live tests covering invitation, RSVP, rescheduling, cancellation, and SSE replay.

## Quick start with a hosted service

If your team already runs Gabriel Calendar, install an SDK and point it at that deployment. A shared service can onboard multiple approved users in the same Google test project. Each user connects their own primary calendar.

| SDK | Install a published release | Runnable example |
| --- | --- | --- |
| Node.js 22+ | `npm install gabriel-calendar` | [Node.js quick start](sdks/node/README.md#quick-start) |
| Python 3.11+ | `python -m pip install gabriel-calendar` | [Python quick start](sdks/python/README.md#quick-start) |

1. Ask the service operator for the HTTPS base URL and a project session issued to you. The operator also adds your Google account to the OAuth test users for an External app in Testing. The base URL is an origin such as `https://calendar.example.invalid`, without `/v1` or any other path.
2. Install your SDK and run its listener example. Supply the URL as `GABRIEL_BASE_URL` and inject your project session as `GABRIEL_PROJECT_SESSION` from your application's secret store. The example passes them as `baseUrl` and `getProjectCredential` in Node.js or `base_url` and `get_project_credential` in Python.
3. The first `CalendarClient.connect()` opens Google consent. Sign in with your approved account and allow access. The service syncs your primary calendar and the SDK listens for new changes over SSE. If an invitation query returns `SYNC_PENDING`, retry after the first sync.
4. To resume in a new process, save the consumer grant with `saveGrant` or `save_grant` in a secret store. Reuse its connection ID, consumer ID and credential with the client constructor to continue from the saved delivery checkpoint.

The service operator runs OAuth, webhook handling and PostgreSQL. SDK users need network access to the service and their own credentials. For a team-only deployment, share the URL privately and issue individual sessions. Google Calendar must still be able to reach the HTTPS webhook. See the [operator setup guide](docs/zh-CN/testing.md).

## Client API reference

- [Node.js and Python method reference](spec/api.md#sdk-surface) covers `connect`, `on`, `start` and `stop`, pending invitations, RSVP, and `events.create`, `events.update` and `events.cancel`.
- [Client call examples](spec/api.md#sdk-examples) show querying and replying to an invitation. Writes require both deployment permission and the corresponding capability when pairing a consumer.
- [Notification types and errors](spec/api.md#events-and-errors) describe event references, notification payloads and error codes. [HTTP endpoints](spec/api.md#http-endpoints) document the wire protocol.

## Scope

| Implemented | Later scope |
| --- | --- |
| Account linking with offline access and primary-calendar watch | Calendar selection and management |
| Durable invitation, event-change, cancellation and RSVP notifications | General event queries and changes to an existing guest list |
| Pending invitations and the user's own RSVP | Application integration |
| Creation, conditional updates and cancellation of single timed events, including events with guests | |

## Local verification

```bash
npm ci
npm test
npm run test:python
```

- [Synchronization and delivery behavior](spec/behavior.md)
- [Contributing and public repository boundaries](CONTRIBUTING.md)

The SDK follows the event and lifecycle conventions of [gabriel-slack](https://github.com/Easy-Ez/gabriel-slack). Gabriel Calendar is independent of Google and uses the [MIT license](LICENSE).
