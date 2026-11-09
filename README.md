# Gabriel Calendar

[简体中文](README.zh-CN.md)

Gabriel Calendar is a standalone Google Calendar service with Node.js and Python SDKs. It handles Google Web OAuth, webhook subscriptions, incremental synchronization and notification delivery. Local applications use HTTPS to follow changes to an approved user's primary calendar, list pending invitations, RSVP and manage single events with explicit guest notification choices.

The MVP supports one Google test project and approved accounts. Both SDKs run the same protocol fixtures. The service has been exercised against a simulated Google HTTP API and PostgreSQL and in live tests covering invitation, RSVP, rescheduling, cancellation, and SSE replay.

## SDKs

| SDK | Install a published release | Quickstart |
| --- | --- | --- |
| Node.js 22+ | `npm install gabriel-calendar` | [Node.js SDK](sdks/node/README.md) |
| Python 3.11+ | `python -m pip install gabriel-calendar` | [Python SDK](sdks/python/README.md) |

The SDKs connect to a Gabriel Calendar service. Set up the service and obtain a project session before connecting a Google account. [Service setup](docs/zh-CN/testing.md) · [SDK and HTTP contract](spec/api.md)

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

- [Test deployment and Google acceptance (中文)](docs/zh-CN/testing.md)
- [SDK and HTTP contract](spec/api.md)
- [Synchronization and delivery behavior](spec/behavior.md)
- [Contributing and public repository boundaries](CONTRIBUTING.md)

The SDK follows the event and lifecycle conventions of [gabriel-slack](https://github.com/Easy-Ez/gabriel-slack). Gabriel Calendar is independent of Google and uses the [MIT license](LICENSE).
