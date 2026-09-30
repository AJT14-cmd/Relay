# Relay demonstration receiver

This dependency-free Node service verifies Relay webhooks, deduplicates simulated
business effects, and lets the dashboard demonstrate failures and recovery. Run it
through the repository's Docker Compose stack, or use Node 22 or later:

```powershell
$env:RELAY_API_KEY = 'your-local-management-key'
npm start
```

It listens on `8081` unless `PORT` is set. `RELAY_API_KEY` is required; there is no
fallback key. The key protects all controls. It can be the same local key used by
the Relay API. `GET /health` is public. Tests use only Node's built-in test runner:

```text
npm test
```

## Configure the receiver

After registering a Relay endpoint, set the returned signing secret through
`POST /config` with `X-API-Key` and `Content-Type: application/json`. The dashboard
provides this form. Alternatively, supply `RECEIVER_SIGNING_SECRET` at startup.
Sending a webhook before configuring a secret returns `503` without an effect.

```json
{
  "mode": "flaky",
  "failuresRemaining": 2,
  "delayMs": 5000,
  "signingSecret": "secret-returned-by-endpoint-registration"
}
```

Fields may be omitted to keep their current values. Unknown fields and invalid
values return `400`, with no partial update. `failuresRemaining` accepts integers
from 0 through 10000; `delayMs` accepts integers from 0 through 60000. The secret is
never returned by the controls; state includes only `signingSecretConfigured`.

| Mode | Behavior for an event with no committed effect |
| --- | --- |
| `success` | Commit the effect and respond `200`. |
| `fail` | Respond `503` without an effect on every attempt. |
| `flaky` | Respond `503` for the next `failuresRemaining` attempts, then succeed. |
| `timeout` | Wait `delayMs`, then commit and respond. Disconnecting before the delay ends cancels the pending effect. |
| `commit_then_timeout` | Commit immediately, then wait `delayMs` before responding. A lost response leaves the effect committed. |

All valid deliveries of an already committed event are immediately acknowledged
with `200` and `duplicate: true`, in any mode. In `commit_then_timeout`, the first
send therefore times out at the sender, and the retry succeeds without repeating
the business effect. Choose a delay greater than Relay's HTTP timeout.

`GET /state` returns the mode, current failure counter, delay, received request
count, effect count, duplicate count, and the latest 100 receipts. Receipts contain
event ID, type, whether the effect was already committed, arrival time, and
signature validity. Payloads, signatures, API keys, and signing secrets are not
retained in receipts. `receivedCount` includes rejected webhook requests;
`duplicateCount` counts authenticated deliveries of already committed effects.
The flaky counter is global across events, suitable for a small controlled demo.

`POST /reset` clears counters, receipts, and deduplication memory while retaining
configuration. Pending delayed requests from the previous run cannot add effects
after reset. Run reset when starting a new demonstration, not while proving
deduplication across retries or replay.

## Signature and payload contract

`POST /webhook` requires JSON and these headers:

- `X-Relay-Event-Id`: must match the envelope's `id`.
- `X-Relay-Timestamp`: Unix timestamp in seconds, within five minutes of the
  receiver's clock in either direction.
- `X-Relay-Signature`: `v1=` followed by lowercase hexadecimal HMAC-SHA256 of the
  timestamp, a literal period, and the exact raw request body bytes.

The key is the UTF-8 signing-secret string returned by Relay, with no base64
decoding. Signature comparison uses `timingSafeEqual`. Requests exceeding 256 KiB
are rejected with `413`. The raw bytes are verified before interpreting JSON, so
whitespace changes invalidate signatures. The envelope is:

```json
{
  "id": "client-supplied-event-id",
  "type": "order.created",
  "createdAt": "2026-09-29T12:00:00Z",
  "payload": { "orderId": "order-42" }
}
```

## Limits of this demonstration

Deduplication is intentionally **in memory**, shared by requests in this single
process. Restarting the receiver or resetting it forgets prior event IDs. The
deduplication set grows with distinct committed event IDs; use this service for
short demonstrations and tests. A real receiver must persist the event ID and its
business effect atomically in a durable database with a unique constraint. A
short signature acceptance window does not replace that deduplication.

One signing secret is active at a time. Configure one endpoint per demonstration;
rotating the receiver's secret will reject old-secret deliveries. Keep the demo
receiver and controls local or on a trusted development network.

The container runs as an unprivileged user and uses the pinned official image
[`node:22.23.3-alpine3.24`](https://hub.docker.com/_/node/tags?name=22.23.3-alpine3.24).
