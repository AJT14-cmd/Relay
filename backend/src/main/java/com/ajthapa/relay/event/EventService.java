package com.ajthapa.relay.event;

import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;
import java.time.OffsetDateTime;
import java.util.UUID;

@Service
public class EventService {
    private final JdbcClient jdbc;
    private final ObjectMapper json;
    private final MeterRegistry metrics;
    public EventService(JdbcClient jdbc, ObjectMapper json, MeterRegistry metrics) {
        this.jdbc = jdbc; this.json = json; this.metrics = metrics;
    }
    public record Acceptance(EventController.EventView event, boolean created) {}

    @Transactional
    public Acceptance accept(EventController.SubmitEvent request) {
        if (!request.payload().isObject())
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "payload must be a JSON object");
        String payload = json.writeValueAsString(request.payload());
        if (exists(request.id())) return existing(request, payload);

        // Coordinate acceptance with disable: a registration cannot accept new work after disable commits.
        var enabled = jdbc.sql("SELECT enabled FROM webhook_endpoints WHERE id = :id FOR SHARE")
                .param("id", request.endpointId()).query(Boolean.class).optional();
        if (enabled.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Endpoint not found");
        if (!enabled.get()) throw new ResponseStatusException(HttpStatus.CONFLICT, "Endpoint is disabled");
        int inserted = jdbc.sql("""
                INSERT INTO webhook_events(id, endpoint_id, type, payload)
                VALUES (:id, :endpointId, :type, CAST(:payload AS jsonb))
                ON CONFLICT (id) DO NOTHING
                """).param("id", request.id()).param("endpointId", request.endpointId())
                .param("type", request.type()).param("payload", payload).update();
        if (inserted == 0) return existing(request, payload);
        jdbc.sql("INSERT INTO delivery_jobs(id,event_id) VALUES (:id,:eventId)")
                .param("id", UUID.randomUUID()).param("eventId", request.id()).update();
        countAfterCommit("relay.events.accepted");
        return new Acceptance(view(request.id()), true);
    }
    private boolean exists(String id) {
        return jdbc.sql("SELECT EXISTS(SELECT 1 FROM webhook_events WHERE id = :id)").param("id", id).query(Boolean.class).single();
    }
    private Acceptance existing(EventController.SubmitEvent request, String payload) {
        boolean same = jdbc.sql("""
                SELECT endpoint_id = :endpointId AND type = :type AND payload = CAST(:payload AS jsonb)
                FROM webhook_events WHERE id = :id
                """).param("id", request.id()).param("endpointId", request.endpointId())
                .param("type", request.type()).param("payload", payload).query(Boolean.class).single();
        if (!same) throw new ResponseStatusException(HttpStatus.CONFLICT, "Event ID already exists with different content");
        countAfterCommit("relay.events.duplicates");
        return new Acceptance(view(request.id()), false);
    }
    private EventController.EventView view(String id) {
        return jdbc.sql("""
                SELECT e.*, j.id AS delivery_id FROM webhook_events e
                JOIN delivery_jobs j ON j.event_id = e.id WHERE e.id = :id
                """).param("id", id).query((rs, row) -> new EventController.EventView(
                    rs.getString("id"), rs.getObject("endpoint_id", UUID.class), rs.getString("type"),
                    json.readTree(rs.getString("payload")), rs.getObject("created_at", OffsetDateTime.class).toInstant(),
                    rs.getObject("delivery_id", UUID.class))).single();
    }
    private void countAfterCommit(String name) {
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() { metrics.counter(name).increment(); }
        });
    }
}
