# Gabriel Calendar

[简体中文](README.zh-CN.md)

Gabriel Calendar is a planned Node.js and Python SDK for receiving Google Calendar changes and acting on behalf of an authorized user. A hosted service handles Google OAuth, webhook subscriptions, synchronization, and delivery. Client applications make outbound HTTPS requests and can run on a desktop or behind a firewall.

This repository contains the MVP design. The service and SDKs are not yet implemented or published.

| Capability | First release |
| --- | --- |
| Connect | Authorize a Google account in the browser and watch its primary calendar |
| Receive | New invitations, event creation, changes, cancellation, and the user's RSVP changes |
| Respond | Accept, tentatively accept, or decline an invitation |
| Manage events | List, read, create, edit, and cancel events the user is allowed to manage |
| Manage calendars | List and read calendars, create a secondary calendar, and edit calendar metadata with the required permission |

The SDK follows the event and lifecycle conventions of [gabriel-slack](https://github.com/Easy-Ez/gabriel-slack). Both languages will share one service protocol and behavior specification.

- [MVP and onboarding plan (中文)](docs/zh-CN/mvp.md)
- [SDK and HTTP API draft](spec/api.md)
- [Synchronization and delivery behavior](spec/behavior.md)
- [Contributing and public repository boundaries](CONTRIBUTING.md)

Gabriel Calendar is an independent project. It is not affiliated with Google. See the [MIT license](LICENSE).
