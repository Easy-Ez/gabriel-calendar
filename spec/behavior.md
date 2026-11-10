# Behavior

## Authorization and synchronization

Every unrevoked consumer on an active connection can perform the supported writes on the linked primary calendar. The service enforces event ownership and attendee boundaries for each operation.

1. A team token starts a 15-minute Google Web OAuth exchange with account selection, offline access and PKCE. The server stores digests of the random state and a separate session credential. It claims the state atomically before exchanging the code. It obtains the Google account's `sub` from UserInfo using the access token obtained by that exchange and binds the verified account to its owned primary calendar. The matching session credential can redeem consent for exactly one consumer grant. Rotation invalidates unfinished sessions. Subsequent consent for the same account can renew the connection. The administrator can disconnect one calendar without disrupting other connections.
2. The first successful full list establishes a queryable baseline without historical notifications. The service registers a pending channel before calling `events.watch` and schedules an incremental pass after registration to cover changes during setup. The worker requests a 24-hour watch and renews before Google's reported expiry. Old channels remain valid until expiry and can overlap with the replacement.
3. A valid webhook advances a durable work revision. The server checks the channel ID, verification value, provider resource ID once known, expiry and increasing message number. Before registration returns, only the authenticated initial `sync` message is accepted. Callbacks only trigger a read and never supply event contents. Work that arrives during a read remains pending for a later pass.
4. A PostgreSQL advisory lock serializes synchronization, writes, reconnect and disconnect per connection. The snapshot, outbox and new Google sync token commit together after all pages succeed. Periodic incremental reads cover dropped pushes. A Google `410` triggers a full read, a durable `connection.gap` and comparison with the previous snapshot. The rebuild removes missing copies from the snapshot. Only explicit Google tombstones generate cancellation notifications.
5. A revoked offline grant or permanent loss of access marks the connection `auth_required`. Reauthorization retains the checkpoint and restarts catch-up. Disconnect clears local Google authorization and snapshots, revokes consumer access and attempts to stop known watches. Any remaining channels expire at Google.

Google exposes the latest revisions observable through list operations. Multiple upstream edits between reads can be coalesced. Calendar settings control which invitations appear on the primary calendar. The worker uses Google's expanded recurring-instance results and keeps the same query parameters across full and incremental reads. [Google push notifications](https://developers.google.com/workspace/calendar/api/guides/push) · [Incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync) · [Invitation visibility](https://developers.google.com/workspace/calendar/api/concepts/inviting-attendees-to-events)

The service records the first onboarding milestones from account binding through the initial Watch and first accepted webhook. First-attempt starts survive provider retries, and later incremental reads, Watch renewals, and reauthorization of an existing connection preserve the sample. Relinking a disconnected connection starts a new sample. The migration leaves older samples unavailable. Milestones contain timestamps and durations only.

## Notification classification

| Type | Observed transition |
| --- | --- |
| `invitation.received` | A newly observed event from another organizer includes the linked user as a guest with a pending response |
| `event.created` | Another newly observed event |
| `event.updated` | One or more tracked details change, such as title, time or location |
| `event.cancelled` | Google reports a tombstone for a previously observed live event. The reason is `provider_cancelled_or_removed` because the event copy alone can be ambiguous |
| `event.rsvp_changed` | The linked user's response is the only tracked field to change |
| `connection.gap` | Google invalidates its sync token and a full reconciliation succeeds. The reason is `provider_cursor_expired` |

One observed revision emits one primary calendar notification. If details and RSVP change together, `event.updated` carries both changed fields. Provider content such as titles and locations must be rendered as text by consumers.

## Delivery

- Each consumer has an independent server checkpoint and at most one active reader. Both SDKs open an authenticated SSE stream. After validating the reader and checkpoint, the server sends `ready` and ordered notices after the last ACK. PostgreSQL signals wake the stream after the outbox or checkpoint transaction commits. Idle heartbeats also recheck the durable state for missed signals and revoked access. The legacy long-poll endpoint uses the same checkpoint.
- The server keeps at most one batch of up to 25 notices in flight. The SDK processes items in order and acknowledges each item after every matching handler succeeds. A handler failure leaves the item pending and backs off. The SDK remembers up to 1,024 successful notification IDs in process so a lost acknowledgment can be retried without invoking handlers again. Delivery remains at least once across process restarts. Callers can persist `notificationId` alongside application side effects.
- Checkpoints advance monotonically. The service signs cursors issued with a batch and binds each to the consumer. Acknowledging a cursor asserts that the prefix through that item was processed. Duplicate acknowledgments are safe.
- When retention overtakes a consumer, delivery reports `CURSOR_EXPIRED`. The SDK emits a local `connection.gap` with reason `cursor_expired` and stops. Pair a fresh consumer and query the latest snapshot to resume. A durable provider gap is delivered and acknowledged like other notifications.
- Network failures, throttling, server failures and handler failures reconnect with exponential backoff or the server retry hint. The listener emits `connection.ready` and `connection.reconnecting` as lifecycle events. Terminal auth failures surface as `auth.required`. Other terminal protocol failures surface as `connection.error`.
- For delivery diagnostics, the outbox records how many validated Google callbacks were pending when sync started and how many arrived before that sync committed its batch. Only a single pending callback with no additional arrivals can supply the batch's webhook timestamp. An expired provider cursor does not produce a timing association. These diagnostics follow the outbox retention period and leave the notification envelope unchanged.

## RSVP

The caller supplies an event reference and desired response. The service reads the event from the connection's authorized primary calendar, locates the single attendee marked `self`, and rejects organizer events, resource attendees and recurrence masters. The provider write is conditional on the ETag just read. A supplied `If-Match` must also match. The patch uses `attendeesOmitted: true` and the self attendee's response, without sending general guest update emails. The result reflects the state confirmed by Google. If confirmation is unavailable after the write was attempted, the API returns `OUTCOME_UNKNOWN`. Writes use the normal sync path for notifications. [Google event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events) · [Conditional updates](https://developers.google.com/workspace/calendar/api/guides/version-resources)

## Event creation

A create targets the bound primary calendar after the baseline is established. Before calling Google, the service persists the request fingerprint and a generated Google event ID for the connection and idempotency key. A retry first checks that ID at Google. A conflict or uncertain insert response is reconciled against the ID and a private marker. The API returns the Google event snapshot, while the normal incremental sync publishes `event.created` through the outbox. [Google event insertion](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)

## Event updates and cancellation

The service fetches the event from the bound primary calendar and verifies that the linked account organizes a timed, standalone event. It checks the requested version and passes it to Google on the patch or deletion. Google-confirmed changes reach the SSE outbox through incremental sync. If callers need to observe both an update and a subsequent cancellation, they can wait for `event.updated` before cancelling. [Google conditional modifications](https://developers.google.com/workspace/calendar/api/guides/version-resources)

Creating, updating or cancelling an event with guests requires an explicit notification policy, even when suppressing notifications. The service forwards that policy to Google and checks the current guest list before managing an existing event. It rejects resource attendees and incomplete attendee lists. Creation includes the normalized guest list and policy in the idempotency fingerprint. The API and SSE event snapshots contain no guest email list. Each guest's connected calendar observes its own Google event copy and gets its own notification sequence.

## Verification

The service uses a simulated Google HTTP server with a private PostgreSQL test cluster. Both SDKs use the same [HTTP and notification fixtures](fixtures/mvp.json). The service integration test validates delivered notifications against the [schema](schema/notification.schema.json). Live Google acceptance is a separate test-project exercise.
