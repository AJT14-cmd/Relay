# Relay

Reliable webhook delivery with PostgreSQL-backed jobs, signed requests, bounded concurrency, retries, replay and an interactive failure simulator.

Relay accepts an event durably before sending it. The dashboard exposes every attempt, and the demo receiver makes failures and duplicate deliveries visible. This is a single-operator learning project: at-least-once delivery within a bounded retry policy, with no ordering or exactly-once promise.

## Run locally

Install Docker Desktop with Linux containers and Compose. From this directory:

```sh
docker compose up --build -d --wait
```

Open **http://localhost:3000** and enter the local demo API key **relay-local-dev-key**. The stack includes PostgreSQL, the Spring Boot API, the receiver and the React dashboard. No local Java or Node installation is needed to run it.

All published ports bind to loopback: dashboard 3000, API 8080, receiver 8081 and PostgreSQL 5332. Stop an IDE-run backend before starting Compose if it already occupies 8080. Copy `.env.example` to `.env` to override ports and credentials; `.env` is ignored by Git. Existing database credentials are initialized only on a fresh volume.

```sh
docker compose logs -f backend
docker compose down
```

Stopping the stack preserves the named database volume. Receiver history is intentionally in memory and resets when its process restarts. Existing V1 databases receive V2 automatically without deleting endpoints.

## Two-minute demo

1. Register `http://receiver:8081/webhook` in the dashboard. Copy the returned signing secret into the receiver controls and save it.
2. Set the receiver to **flaky**, with **2** failures. Submit `order.created` with a new event ID and a JSON object payload.
3. Open the delivery: watch two 503 failures followed by a successful acknowledgment. Inspect timestamps and retry scheduling.
4. Submit the identical event ID and content again: it returns the existing event. Change the payload under that ID to see a 409 conflict.
5. Set the receiver to **fail**, submit another event and wait for exhaustion. Switch to **success** and replay the exhausted delivery. Earlier attempts remain visible.
6. Set **commit_then_timeout** with a 5000ms delay and submit a third event. The receiver commits its effect before Relay times out. The retry is a duplicate; the receiver counts one effect and acknowledges the repeat.

The demo receiver uses one configured signing secret at a time; use one active demo endpoint per session. Its reset control clears its in-memory deduplication evidence. Use only demo data.

For an automated version of the retry/replay/duplicate demo, with the stack running and Node 22.12+ installed:

```sh
node scripts/smoke.mjs
```

This test creates demo events, resets receiver state, and disables its temporary endpoint when finished. It is intended for an isolated local demo, not a live shared receiver.

## Develop and test

Backend requires JDK 25 and Docker. Run only the database when using IntelliJ:

```sh
docker compose up -d db
cd backend
./mvnw verify
./mvnw spring-boot:run
```

On Windows use `./mvnw.cmd` in place of `./mvnw`. Open `backend/pom.xml` in the IDE. Backend defaults connect to localhost:5332; integration tests start a separate disposable PostgreSQL container, apply migrations and require Docker. They never truncate the normal development database.

Frontend requires Node 22.12+:

```sh
cd frontend
npm ci
npm test
npm run dev
```

The development proxy targets the API on localhost:8080 and receiver on localhost:8081. When the backend runs from your IDE, register `http://localhost:8081/webhook`; the `receiver` hostname is only resolved inside Compose. Start the receiver using `docker compose up -d receiver`.

```sh
cd receiver
npm test
```

GitHub Actions defines backend integration tests, dashboard tests/build, receiver tests, and a full Compose smoke test. Actual local verification results are recorded in [the project plan](docs/project-plan.md); a workflow file alone is not evidence of a remote CI pass.

## Explore the code

| Path | Responsibility |
|---|---|
| `backend/.../endpoint` | Endpoint registration, destination policy, signing-secret creation |
| `backend/.../event` | Transactional acceptance and duplicate-content checks |
| `backend/.../delivery` | Lease claims, HTTP delivery, retries, attempts and replay |
| `backend/.../config` | Authentication, configuration and safe API errors |
| `backend/src/main/resources/db/migration` | Versioned PostgreSQL schema |
| `backend/src/test` | Real database/network integration tests |
| `frontend` | React + TypeScript operations dashboard |
| `receiver` | Signature verification and controllable failure scenarios |
| `scripts/smoke.mjs` | Full-stack executable demo |

Read [architecture and failure guarantees](docs/architecture.md), [API reference](docs/api.md), and [project plan](docs/project-plan.md).

## Configuration and limits

Defaults are for local demonstration. Replace the API key and database credentials before sharing access. Endpoint signing secrets are stored in PostgreSQL; protect database storage and backups. Public multi-tenant registration is outside this MVP.

| Environment variable | Default |
|---|---|
| `RELAY_API_KEY` | `relay-local-dev-key` (minimum 16 characters) |
| `RELAY_ALLOWED_HOSTS` | `receiver,localhost,127.0.0.1` |
| `RELAY_WORKER_CONCURRENCY` | 4 per process |
| `RELAY_MAX_ATTEMPTS` | 5 per replay cycle |
| `RELAY_REQUEST_TIMEOUT` | PT3S |
| `RELAY_LEASE_DURATION` | PT30S |
| `RELAY_BASE_BACKOFF` / `RELAY_MAX_BACKOFF` | PT1S / PT1M |

Worker settings are Spring environment properties; pass them to the backend process or add them to its Compose environment. The hostname allowlist restricts destinations but is not a public SSRF defense against untrusted DNS. No automatic retention cleanup, secret rotation, fan-out, tenant isolation or deployment target is included.

Do not claim production throughput or reliability metrics from this project without measuring them. The tested failure scenarios and their evidence are the useful resume material.
