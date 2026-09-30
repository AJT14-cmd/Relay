package com.ajthapa.relay.delivery;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public record DeliveryView(UUID id, String eventId, UUID endpointId, String status, int attemptCount,
                           int cycleAttemptCount, int replayCount, Instant nextAttemptAt,
                           Instant createdAt, Instant updatedAt, String lastError, List<AttemptView> attempts) {
    public record AttemptView(UUID id, int attemptNumber, Instant startedAt, Instant finishedAt,
                              Integer httpStatus, String error, Long durationMs) {}
}
