package com.ajthapa.relay.endpoint;

import java.time.Instant;
import java.util.UUID;

public record CreateEndpointResponse(
        UUID id,
        String url,
        String signingSecret,
        boolean enabled,
        Instant createdAt
) {
}
