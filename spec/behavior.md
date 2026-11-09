# Behavior

Status: draft. This document defines behavior shared by both SDKs and the hosted service.

## Google synchronization

1. Create one Google event watch per monitored connection and calendar. Associate the pending channel with its connection before registering it so an early Google sync notification can be handled. Validate incoming notifications against the registered channel and its verification value, and check the provider resource identifier once known.
2. Establish the initial calendar state as a baseline. Use a reconciliation pass after registering the watch to cover changes during setup. The initial baseline is queryable without emitting historical invitations as new.
3. Treat a Google callback as a sync trigger. Run at most one incremental sync at a time per connection and calendar. Coalesce repeated triggers and run another pass when changes arrive during a sync. Save the new cursor only after fetching the last page and committing the corresponding snapshot and notifications. Serialize writes to that calendar's synchronization state.
4. Renew channels before the reported expiration. Old and new channels can overlap. Perform periodic catch-up syncs because upstream notifications can be dropped. On Google `410 Gone`, rebuild the baseline and reconcile changes. Report a gap when earlier transitions cannot be reconstructed. A permission change or incomplete sync must not produce fabricated cancellations.
5. When Google authorization expires or is revoked and cannot be refreshed, mark the connection as requiring authorization. A disconnect stops scheduling, revokes SDK access and stops upstream watches where possible.

Google Webhooks do not identify changed meetings or include their contents. The service delivers observed differences between syncs. Several Google writes can therefore appear as one change. [Google push notifications](https://developers.google.com/workspace/calendar/api/guides/push) · [Incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync)

## Notification classification

| Type | Observed transition |
| --- | --- |
| `invitation.received` | A newly observed event from another organizer includes the linked user as a guest with a pending response |
| `event.created` | A new event that does not match the pending-invitation rule |
| `event.updated` | Meeting details changed, such as title, time, or location |
| `event.cancelled` | Google reports a cancellation or a removed event copy; the reason distinguishes these when known |
| `event.rsvp_changed` | Only the linked user's response changed among the tracked fields |

Emit one primary type for an observed revision. A new pending invitation uses `invitation.received` instead of `event.created`. When meeting details and RSVP change together, `event.updated` includes both changes. A cancellation may carry a tombstone. Losing a calendar permission is a connection or calendar status change. A removed local event copy alone does not prove the organizer cancelled the meeting for everyone.

Notification IDs are stable across delivery retries and separate from resource IDs. Source data such as titles and descriptions is untrusted content. Logs and status endpoints carry operational metadata and do not include event bodies.

## Delivery

- Each consumer has an independent server checkpoint and one active reader. The SDK reconnects with backoff and resumes after the last acknowledged cursor.
- Deliver in queue order within the consumer. The SDK runs matching handlers and acknowledges the contiguous processed prefix only after all matching handlers return successfully. If processing fails, leave the failed item unacknowledged and retry with backoff. Callers should use `notificationId` to deduplicate side effects.
- Advance checkpoints monotonically. Repeat acknowledgements are safe. Reject a cursor issued to a different consumer or beyond that reader's delivered batch.
- Deliver at least once while a notification remains in the service's configured retention window and the reader remains authorized. If a checkpoint falls outside retention, report `CURSOR_EXPIRED` and surface a `connection.gap` event. The caller can establish a fresh consumer position, query the latest state and resume; old transitions may be unavailable.
- Expose `connection.ready`, `connection.reconnecting`, `connection.gap` and `auth.required` separately from calendar notifications. A consumer can stop without disconnecting its Google account.

## Writes and permissions

- Offer separate capabilities for reading events, writing events and managing calendar metadata. Request the narrowest applicable Google scope. Check the connection owner's role and the SDK grant for the requested calendar and operation. Secondary calendars are owned by the authorized Google user.
- RSVP targets the linked account's attendee record on its copy of the event. Identify that attendee from Google data, validate the response, and use Google's participant-only update semantics. The request cannot supply another attendee identity. Preserve the rest of the guest list. Return the confirmed response and let the normal sync path produce any notification. [Google event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events)
- Validate dates and times, time zones, sizes, enumerations, and fields before sending updates. Require an explicit guest notification policy for changes affecting guests. Use conditional updates when a version is provided and surface conflicts to the caller.
- Deduplicate create attempts by project, connection, operation and idempotency key. Reusing a key with a different body is a conflict. If the upstream result is ambiguous, reconcile where possible and return `OUTCOME_UNKNOWN` otherwise. The SDK must not automatically issue a new create with a fresh key.
- Cancellation is scoped to an explicit event reference and requires permission to cancel it. A guest declines through RSVP. Expose a changed or cancelled event to listeners through the same synchronization path used for edits made in Google Calendar. [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth) · [Conditional updates](https://developers.google.com/workspace/calendar/api/guides/version-resources)

## Conformance plan

Both SDKs will use the same fixtures for event decoding, callback ordering, failed handlers, resume, duplicate delivery, and expired cursors. Service tests will use a fake Google provider to exercise overlapping watches, partial sync failures, concurrent changes, cross-tenant authorization, RSVP isolation, and ambiguous writes.
