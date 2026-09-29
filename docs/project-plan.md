# Webhook Delivery Service — Project Plan

Status: planning; implementation has not started.
Created: 2026-09-28
Working name: Reliable Webhook Delivery Service (rename later).

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

This file currently lives in the career-ops workspace for planning. Put the implementation in a dedicated project repository, and copy this plan there when that repository is selected. Do not place service code in the career-ops system files.

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

- [ ] Register, list, and disable endpoints.
- [ ] Authenticate management and event-submission APIs with a configured API key.
- [ ] Accept events with unique IDs and detect repeated submissions.
- [ ] Persist events and jobs atomically in PostgreSQL.
- [ ] Deliver jobs asynchronously using a bounded worker pool.
- [ ] Sign outgoing payloads and supply a receiver verification example.
- [ ] Retry temporary failures with exponential backoff and jitter.
- [ ] Retain exhausted deliveries and support explicit replay.
- [ ] Expose delivery status and attempt history through an API.
- [ ] Provide a small dashboard and configurable demo receiver.
- [ ] Run locally through Docker Compose with automated integration tests.

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