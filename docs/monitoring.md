# Production monitoring

The monitor stores one atomically committed state envelope below OpenClaw's
state directory. Parcel observations, change history, notification outbox, rate
state, and UniFi event progress are separate logical ledgers.

## Delivery lifecycle

1. `parcel_monitor_poll` makes at most one active-deliveries request when due.
2. The first successful poll establishes a silent baseline.
3. Later semantic transitions create deterministic pending notifications.
4. Call `parcel_monitor_attempt` immediately before transport delivery.
5. Call `parcel_monitor_ack` only after the transport reports success.

Polling again, restarting OpenClaw, or reprocessing a transition cannot create a
second notification with the same semantic identity.

The default rate gate allows no more than 18 attempts/hour and enforces a
10-minute minimum interval. An invocation that is too early returns pending
notifications without contacting Parcel. HTTP calls are not retried.

## UniFi parcel cameras

Enable `unifi`, configure one or more cameras with the `parcel` role, an ingress
token SecretRef, Protect snapshot access, and an ordered list of vision models.
POST normalized events to:

`/plugins/openclaw-parcel/unifi/events`

Use `Authorization: Bearer <ingress token>` or `x-plugin-token`. The event is
persisted before the route returns `202`. Immediate processing is best-effort;
`parcel_camera_process` and the heartbeat resume durable incomplete work.

OpenClaw's native media-understanding runtime is used for structured vision.
Models are tried in configured order. `No MediaUnderstandingProvider registered`
is classified as provider unavailability, persisted, and exposed through an
operational outbox notification. It is never interpreted as “no package.”

`parcel_monitor_status` reports `degraded` when the latest poll failed or when
a pending notification has gone unattempted or unacknowledged for more than 15
minutes. Heartbeat integrations must surface that status visibly rather than
returning a silent success response.

## Private boundaries

Tracking history, camera identifiers, Protect endpoints, message destinations,
credentials, and provider/model choices belong in private configuration. Use
only synthetic fixtures in upstream issues and pull requests.
