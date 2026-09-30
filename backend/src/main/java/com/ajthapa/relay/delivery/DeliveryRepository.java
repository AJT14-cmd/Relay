package com.ajthapa.relay.delivery;

import com.ajthapa.relay.config.RelayProperties;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

@Repository
public class DeliveryRepository {
    private static final Set<String> STATUSES = Set.of("PENDING","IN_FLIGHT","RETRY_WAIT","SUCCEEDED","EXHAUSTED","CANCELLED");
    private final JdbcClient jdbc;
    private final RelayProperties properties;
    public DeliveryRepository(JdbcClient jdbc, RelayProperties properties) { this.jdbc = jdbc; this.properties = properties; }

    public record Claim(UUID id, UUID token, UUID attemptId, int attemptNumber, int cycleAttempt,
                        String eventId, String eventType, String payload, Instant eventCreatedAt,
                        String url, String signingSecret) {}
    private record Candidate(UUID id, String eventId, String status, int count, int cycle,
                             String type, String payload, Instant eventCreatedAt, String url, String secret, boolean enabled) {}

    @Transactional
    public Optional<Claim> claim() {
        // Skip a bounded batch of terminal cleanups so disabled endpoints cannot stall unrelated work.
        for (int scanned = 0; scanned < 64; scanned++) {
        var candidate = jdbc.sql("""
                SELECT j.*, e.type, e.payload::text, e.created_at AS event_created_at,
                       p.url, p.signing_secret, p.enabled
                FROM delivery_jobs j JOIN webhook_events e ON e.id = j.event_id
                JOIN webhook_endpoints p ON p.id = e.endpoint_id
                WHERE (j.status IN ('PENDING','RETRY_WAIT') AND j.next_attempt_at <= CURRENT_TIMESTAMP)
                   OR (j.status = 'IN_FLIGHT' AND j.lease_expires_at <= CURRENT_TIMESTAMP)
                ORDER BY j.next_attempt_at, j.created_at, j.id
                LIMIT 1 FOR UPDATE OF j SKIP LOCKED
                """).query((rs, row) -> new Candidate(rs.getObject("id", UUID.class), rs.getString("event_id"),
                    rs.getString("status"), rs.getInt("attempt_count"), rs.getInt("cycle_attempt_count"),
                    rs.getString("type"), rs.getString("payload"), instant(rs, "event_created_at"),
                    rs.getString("url"), rs.getString("signing_secret"), rs.getBoolean("enabled"))).optional();
        if (candidate.isEmpty()) return Optional.empty();
        Candidate c = candidate.get();
        if (c.status().equals("IN_FLIGHT")) {
            jdbc.sql("""
                    UPDATE delivery_attempts SET finished_at = CURRENT_TIMESTAMP,
                    error = 'Worker lease expired; outcome unknown',
                    duration_ms = GREATEST(0, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - started_at))*1000)::bigint
                    WHERE job_id = :id AND finished_at IS NULL
                    """).param("id", c.id()).update();
        }
        if (!c.enabled() || c.cycle() >= properties.getWorker().getMaxAttempts()) {
            jdbc.sql("""
                    UPDATE delivery_jobs SET status = :status, lease_token = NULL, lease_expires_at = NULL,
                    last_error = :error, updated_at = CURRENT_TIMESTAMP WHERE id = :id
                    """).param("id", c.id()).param("status", c.enabled() ? "EXHAUSTED" : "CANCELLED")
                    .param("error", c.enabled() ? "Attempt limit reached after lease expiry" : "Endpoint is disabled").update();
            continue;
        }
        UUID token = UUID.randomUUID();
        UUID attemptId = UUID.randomUUID();
        jdbc.sql("""
                UPDATE delivery_jobs SET status = 'IN_FLIGHT', attempt_count = attempt_count + 1,
                cycle_attempt_count = cycle_attempt_count + 1, lease_token = :token,
                lease_expires_at = CURRENT_TIMESTAMP + (:leaseMs * INTERVAL '1 millisecond'),
                updated_at = CURRENT_TIMESTAMP WHERE id = :id
                """).param("id", c.id()).param("token", token)
                .param("leaseMs", properties.getWorker().getLeaseDuration().toMillis()).update();
        jdbc.sql("INSERT INTO delivery_attempts(id,job_id,attempt_number) VALUES (:id,:job,:number)")
                .param("id", attemptId).param("job", c.id()).param("number", c.count() + 1).update();
        return Optional.of(new Claim(c.id(), token, attemptId, c.count() + 1, c.cycle() + 1,
                c.eventId(), c.type(), c.payload(), c.eventCreatedAt(), c.url(), c.secret()));
        }
        return Optional.empty();
    }

    @Transactional
    public boolean finish(Claim claim, Integer httpStatus, String error, long durationMs, boolean retryable, long delayMs) {
        boolean success = httpStatus != null && httpStatus >= 200 && httpStatus < 300 && error == null;
        String status = success ? "SUCCEEDED" :
                retryable && claim.cycleAttempt() < properties.getWorker().getMaxAttempts() ? "RETRY_WAIT" : "EXHAUSTED";
        // A stale process must not overwrite a result after another process acquires the expired lease.
        int changed = jdbc.sql("""
                UPDATE delivery_jobs SET status = :status, lease_token = NULL, lease_expires_at = NULL,
                    next_attempt_at = CURRENT_TIMESTAMP + (:delay * INTERVAL '1 millisecond'),
                    last_error = :error, updated_at = CURRENT_TIMESTAMP
                WHERE id = :id AND status = 'IN_FLIGHT' AND lease_token = :token
                    AND lease_expires_at > CURRENT_TIMESTAMP
                """).param("status", status).param("delay", delayMs).param("error", error, Types.VARCHAR)
                .param("id", claim.id()).param("token", claim.token()).update();
        if (changed == 0) return false;
        jdbc.sql("""
                UPDATE delivery_attempts SET finished_at = CURRENT_TIMESTAMP, http_status = :httpStatus,
                    error = :error, duration_ms = :duration WHERE id = :id
                """).param("id", claim.attemptId()).param("httpStatus", httpStatus, Types.INTEGER)
                .param("error", error, Types.VARCHAR).param("duration", durationMs).update();
        return true;
    }

    public List<DeliveryView> list(int limit, String status) {
        if (limit < 1 || limit > 500) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "limit must be between 1 and 500");
        if (status != null && !STATUSES.contains(status)) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unknown delivery status");
        return jdbc.sql("""
                SELECT j.*, e.endpoint_id FROM delivery_jobs j JOIN webhook_events e ON e.id = j.event_id
                WHERE (:status IS NULL OR j.status = :status)
                ORDER BY j.created_at DESC, j.id LIMIT :limit
                """).param("status", status, Types.VARCHAR).param("limit", limit)
                .query((rs, row) -> map(rs, List.of())).list();
    }
    @Transactional(readOnly = true, isolation = org.springframework.transaction.annotation.Isolation.REPEATABLE_READ)
    public DeliveryView detail(UUID id) {
        var attempts = jdbc.sql("SELECT * FROM delivery_attempts WHERE job_id = :id ORDER BY attempt_number")
                .param("id", id).query((rs, row) -> new DeliveryView.AttemptView(rs.getObject("id", UUID.class),
                    rs.getInt("attempt_number"), instant(rs, "started_at"), instant(rs, "finished_at"),
                    rs.getObject("http_status", Integer.class), rs.getString("error"), rs.getObject("duration_ms", Long.class))).list();
        return jdbc.sql("SELECT j.*, e.endpoint_id FROM delivery_jobs j JOIN webhook_events e ON e.id = j.event_id WHERE j.id = :id")
                .param("id", id).query((rs, row) -> map(rs, attempts)).optional()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Delivery not found"));
    }
    @Transactional
    public DeliveryView replay(UUID id) {
        var status = jdbc.sql("""
                SELECT j.status FROM delivery_jobs j JOIN webhook_events e ON e.id = j.event_id
                JOIN webhook_endpoints p ON p.id = e.endpoint_id WHERE j.id = :id FOR UPDATE OF j
                """).param("id", id).query(String.class).optional()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Delivery not found"));
        if (!"EXHAUSTED".equals(status)) throw new ResponseStatusException(HttpStatus.CONFLICT, "Only exhausted deliveries can be replayed");
        boolean enabled = jdbc.sql("""
                SELECT p.enabled FROM webhook_endpoints p JOIN webhook_events e ON e.endpoint_id = p.id
                JOIN delivery_jobs j ON j.event_id = e.id WHERE j.id = :id FOR SHARE OF p
                """).param("id", id).query(Boolean.class).single();
        if (!enabled) throw new ResponseStatusException(HttpStatus.CONFLICT, "Endpoint is disabled");
        jdbc.sql("""
                UPDATE delivery_jobs SET status = 'PENDING', cycle_attempt_count = 0, replay_count = replay_count + 1,
                next_attempt_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = :id
                """).param("id", id).update();
        return detail(id);
    }
    private static DeliveryView map(ResultSet rs, List<DeliveryView.AttemptView> attempts) throws SQLException {
        return new DeliveryView(rs.getObject("id", UUID.class), rs.getString("event_id"), rs.getObject("endpoint_id", UUID.class),
                rs.getString("status"), rs.getInt("attempt_count"), rs.getInt("cycle_attempt_count"), rs.getInt("replay_count"),
                instant(rs,"next_attempt_at"), instant(rs,"created_at"), instant(rs,"updated_at"), rs.getString("last_error"), attempts);
    }
    private static Instant instant(ResultSet rs, String field) throws SQLException {
        OffsetDateTime value = rs.getObject(field, OffsetDateTime.class);
        return value == null ? null : value.toInstant();
    }
}
