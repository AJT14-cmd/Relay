# Webhook Delivery Service — Project Plan

Status: MVP implemented and verified locally on 2026-09-29.
Created: 2026-09-28
Project name: Relay — Reliable Webhook Delivery Service.

## 1. Goal

Build a service that accepts events, delivers them to registered HTTP endpoints, and makes failures easy to inspect and recover from. Include a configurable receiver that demonstrates timeouts, temporary failures, and duplicate deliveries.

The project should provide evidence of backend engineering beyond CRUD: asynchronous work, database transactions, concurrency, security, observability, and recovery. It should be understandable through a two-minute demo and reproducible from the repository.

This plan assumes the standalone delivery-service idea discussed in the conversation. FinTrack integration is an optional later extension.

## 2. How we will use this plan

- Work on one milestone at a time. Meet its acceptance criteria before broadening scope.
- Keep completed checkboxes, decisions, and the handoff section current.
- Start each work session by reading this plan, repository instructions, and current code and test results.
- Explain the purpose of unfamiliar concepts and significant trade-offs as we implement them.
- Prefer small, reviewable changes. Avoid adding infrastructure without a concrete requirement.
- Record actual commands and results after verification; never mark an item complete based only on code existing.
- Do not turn planned features or target metrics into resume accomplishments. Use verified implementation and measured results only.

Implementation lives in the dedicated Relay repository: https://github.com/AJT14-cmd/Relay. This file is the canonical project plan; PROJECT_PLAN.md at the repository root links here.

## 3. Users and core workflow

The first user is a developer who needs to send application events to another service and understand delivery failures.

1. Register a webhook endpoint and receive its signing secret.
2. Submit an event, such as `order.created`, with a client-supplied event ID.
3. Receive an acceptance response after the event and delivery job are committed.
4. A background worker sends the event to the endpoint.
5. Inspect delivery attempts, retry scheduling, and the final result.
6. Replay an exhausted delivery after fixing the receiving service.

For the MVP, the producer explicitly selects one endpoint per event. Multiple subscriptions and fan-out are stretch goals.

## 4. Scope

### MVP

- [x] Register, list, and disable endpoints.
- [x] Authenticate management and event-submission APIs with a configured API key.
- [x] Accept events with unique IDs and detect repeated submissions.
- [x] Persist events and jobs atomically in PostgreSQL.
- [x] Deliver jobs asynchronously using a bounded worker pool.
- [x] Sign outgoing payloads and supply a receiver verification example.
- [x] Retry temporary failures with exponential backoff and jitter.
- [x] Retain exhausted deliveries and support explicit replay.
- [x] Expose delivery status and attempt history through an API.
- [x] Provide a small dashboard and configurable demo receiver.
- [x] Run locally through Docker Compose with automated integration tests.

### Out of scope for the first release

Billing, enterprise accounts, a visual workflow builder, arbitrary payload transformation, Kafka, Kubernetes, multi-region deployment, and exactly-once delivery claims.

The first release is a single-operator service. A public demo should use predefined destinations and demo data. Opening endpoint registration to untrusted users requires additional abuse controls and tenant isolation.

## 5. Technical approach

| Area | Initial choice | Reason |
|---|---|---|
| Backend | Java and Spring Boot | Builds on existing Java/backend experience |
| Storage | PostgreSQL with Flyway migrations | Durable state, constraints, transactional job creation |
| Worker | PostgreSQL-backed queue with leases | Keeps initial infrastructure small while exposing concurrency problems |
| Frontend | React and TypeScript | Small interface for delivery inspection and the demo |
| Packaging | Docker Compose | Reproducible local setup |
| Tests | JUnit, Testcontainers, controllable HTTP receiver | Exercise database and network behavior |
| CI | GitHub Actions | Repeatable build and test execution |

Select supported dependency versions during scaffolding and pin them. Hosting is undecided. Start locally, then choose one modest deployment target after the delivery path works.

```text
Producer -> Authenticated API -> PostgreSQL: event + delivery job
                                      |
                                Background worker
                                      |
                              Signed HTTP request
                                      |
                           Receiver / failure simulator

Dashboard -> Management API -> delivery state + attempt history
```

### Delivery contract

- An accepted event is durable: return `202` only after its event and job transaction commits.
- Delivery uses at-least-once semantics within a bounded retry policy. Eventual success depends on the receiver recovering before exhaustion or an operator replaying the job.
- Duplicates are possible, especially if the receiver commits work but its response is lost. The receiver must deduplicate effects using the event ID.
- Do not promise ordering between events.
- A `2xx` response means the receiver acknowledged delivery; it does not prove its downstream business work completed.
- Resubmitting an event ID with the same endpoint, type, and payload returns the existing event. Conflicting content returns `409`.
- Replay retains the original event ID so receivers can still identify duplicates.

## 6. Implementation decisions

- The API and bounded worker run in one Spring Boot application; separate processes can share the PostgreSQL queue.
- V1 remains unchanged. V2 adds immutable events, one job per event, and delivery attempts with lease fencing.
- Producer event IDs use 1–128 ASCII letters, digits, periods, underscores, colons or hyphens for HTTP header compatibility.
- Duplicate comparison uses PostgreSQL JSONB equality and returns 200; new accepted events return 202, conflicting content returns 409.
- The retry policy defaults to 5 attempts per cycle, equal-jitter exponential backoff, a 3-second HTTP deadline and a 30-second lease. Replay retains history and the original event ID.
- Destination registration uses an operator-managed exact hostname allowlist. Local Docker ports bind to loopback; deployment to untrusted/public users remains outside this MVP.
- The React dashboard uses same-origin proxies and a session-only API key. The dependency-free Node receiver demonstrates raw-body HMAC verification, failures, timeouts and event-ID deduplication.
- API lists are bounded to the latest 100 records by default (maximum 500); pagination and automated retention are deferred.
- Deployment target remains undecided. No hosting account was created and nothing was publicly deployed.

## 7. Verification evidence — 2026-09-29

| Check | Actual result |
|---|---|
| `backend: .\\mvnw.cmd verify` | PASS: 20 PostgreSQL/Testcontainers integration tests; 0 failures, errors or skips; executable JAR built |
| `receiver: npm test` | PASS: 16 signature/authentication/failure/deduplication tests |
| `frontend: npm test` | PASS: 11 API helper and payload validation tests |
| `frontend: npm run build` | PASS: TypeScript check and production Vite bundle |
| `frontend: npm run format:check` | PASS |
| `docker compose up --build -d --wait` | Images built; Windows rejected port 8080. Added ignored local `.env` with API_PORT=18080 and reran startup successfully; all four services healthy |
| `node scripts/smoke.mjs` | PASS through dashboard proxy: signed delivery, 2 temporary failures then success, idempotent repeat and conflict, exhaustion/replay, timeout duplicate with one effect |
| Browser walkthrough | Registered a new endpoint, configured its receiver secret, submitted dashboard-demo-001, and inspected its successful signed delivery and attempt history |
| Browser layout and console | Verified desktop light/dark views and narrow layout; corrected global overflow at 520px; no captured browser errors or warnings |
| `git diff --check` | PASS |

Integration coverage includes concurrent acceptance, rollback when job creation fails, concurrent queue claims, bounded pool size, expired lease recovery, stale completion rejection, crash exhaustion, replay races, endpoint disable, backlog fairness, redirect refusal, secret omission, malformed input and authentication.

GitHub Actions is configured to run backend, frontend, receiver and full Compose checks. No remote CI result has been claimed. No throughput benchmark or production uptime claim has been made.

## 8. Handoff

- Start/rebuild: `docker compose up --build -d --wait` from the Relay repository root.
- Dashboard: http://localhost:3000; local demo key: `relay-local-dev-key`.
- This workstation uses API port 18080 via ignored `.env`; fresh clones default to 8080.
- The current local stack is running. Stop it with `docker compose down`; keep the named database volume to retain events and attempts.
- See README.md for the two-minute demo and docs/architecture.md for delivery guarantees, configuration and security limits.
- Signing secrets are stored in the database for this local MVP; the receiver's deduplication state is intentionally in memory. Neither is presented as production secret management or durable receiver storage.
