package com.ajthapa.relay.endpoint;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.OffsetDateTime;
import java.util.UUID;

@Repository
public class EndpointRepository {
    private final JdbcClient client;

    public EndpointRepository(JdbcClient client) {
        this.client = client;
    }

    public WebhookEndpoint create(UUID id, String url, String signingSecret) {
        return client.sql("""
                INSERT INTO webhook_endpoints (id, url, signing_secret)
                VALUES (:id, :url, :signingSecret)
                RETURNING id, url, signing_secret, enabled, created_at
                """)
                .param("id", id)
                .param("url", url)
                .param("signingSecret", signingSecret)
                .query((rs, rowNum) -> new WebhookEndpoint(
                        rs.getObject("id", UUID.class),
                        rs.getString("url"),
                        rs.getString("signing_secret"),
                        rs.getBoolean("enabled"),
                        rs.getObject("created_at", OffsetDateTime.class).toInstant()
                ))
                .single();
    }
}
