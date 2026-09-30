# API reference

Base URL: `http://localhost:8080`. Routes under `/api` are also available through the dashboard proxy at `http://localhost:3000`; use the backend port directly for `/actuator` routes.

Send `X-API-Key: relay-local-dev-key` for local defaults. JSON requests use `Content-Type: application/json`. Errors return a JSON problem with `status` and `detail`. Request bodies are limited to 64 KiB. The key and credentials can be overridden using the environment; never use demo defaults on a shared deployment.

| Method | Route | Input | Result |
|---|---|---|---|
| POST | /api/endpoints | `{ "url": "http://receiver:8081/webhook" }` | 201, endpoint including one-time signingSecret |
| GET | /api/endpoints?limit=100 | — | endpoint array, secrets omitted |
| POST | /api/endpoints/{id}/disable | empty body or `{}` | endpoint with enabled=false, secret omitted |
| POST | /api/events | event shown below | 202 new, 200 identical repeat, 409 conflicting ID |
| GET | /api/deliveries?limit=100&status=EXHAUSTED | optional status | recent delivery array |
| GET | /api/deliveries/{id} | — | delivery with ordered attempt history |
| POST | /api/deliveries/{id}/replay | empty body or `{}` | reset exhausted job; 409 for other states/disabled endpoint |
| GET | /actuator/health | no key required | minimal health status |
| GET | /actuator/metrics | API key | metric names |
| GET | /actuator/metrics/relay.delivery.attempts | API key | process attempt measurements |

Registration response fields: `id` (UUID), `url`, `signingSecret`, `enabled`, `createdAt`. List/disable responses omit `signingSecret`. Keep the registration secret to configure the receiver.

## Event submission

```json
{
  "id": "order-42-created",
  "endpointId": "COPY-ENDPOINT-UUID-HERE",
  "type": "order.created",
  "payload": { "orderId": 42, "total": 29.95 }
}
```

ID: 1–128 characters from `A-Z a-z 0-9 . _ : -`. Type: nonblank, at most 128 characters. Payload: JSON object. Neither JSONB nor PostgreSQL text support NUL characters. ID reuse compares the endpoint, type and JSONB payload.

The response includes `id`, `endpointId`, `type`, `payload`, `createdAt`, and `deliveryId`. The Location header points to the delivery inspection route. A 202 means the database transaction committed, not that the receiver has been contacted.

## Delivery response

Fields: `id`, `eventId`, `endpointId`, `status`, `attemptCount`, `cycleAttemptCount`, `replayCount`, `nextAttemptAt`, `createdAt`, `updatedAt`, `lastError`, `attempts`.

List responses keep `attempts` empty; fetch the detail route for history. Attempt fields: `id`, `attemptNumber`, `startedAt`, `finishedAt`, `httpStatus`, `error`, `durationMs`. Nullable status means no HTTP status was observed. An unfinished attempt has no finishedAt. A lease-expired attempt records an unknown outcome.

States: PENDING, IN_FLIGHT, RETRY_WAIT, SUCCEEDED, EXHAUSTED, CANCELLED. Only PENDING and RETRY_WAIT have a meaningful next-attempt time. AttemptCount is lifetime attempts; cycleAttemptCount resets on explicit replay.

## Demo receiver controls

Access via `http://localhost:8081`, or the dashboard proxy prefix `/receiver-api`. Use the same API key.

- `GET /state`: mode, delay, counts and last 100 receipts; secret omitted.
- `POST /config`: configure mode, failuresRemaining, delayMs and optional signingSecret.
- `POST /reset`: clear in-memory demonstration history and counters.
- `POST /webhook`: signed incoming webhook; HMAC authorization replaces the API key.
- `GET /health`: minimal public health response.

Read [receiver behavior](../receiver/README.md) for exact failure and duplicate semantics.
