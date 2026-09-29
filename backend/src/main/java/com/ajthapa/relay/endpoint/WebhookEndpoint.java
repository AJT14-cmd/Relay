package com.ajthapa.relay.endpoint;

import java.time.Instant;
import java.util.UUID;

public class WebhookEndpoint {

    private final UUID id;
    private final String url;
    private final String signingSecret;
    private final boolean enabled;
    private final Instant createdAt;

    public WebhookEndpoint(UUID id, String url, String signingSecret, boolean enabled, Instant createdAt) {
        this.id = id;
        this.url = url;
        this.signingSecret = signingSecret;
        this.enabled = enabled;
        this.createdAt = createdAt;
    }

    public UUID getId() {
        return id;
    }

    public String getUrl() {
        return url;
    }

    public String getSigningSecret() {
        return signingSecret;
    }

    public boolean isEnabled() {
        return enabled;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
