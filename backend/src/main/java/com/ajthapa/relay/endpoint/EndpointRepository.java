package com.ajthapa.relay.endpoint;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.time.OffsetDateTime;
import java.util.UUID;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.RowMapper;

@Repository
public class EndpointRepository {
    public static final RowMapper<WebhookEndpoint> MAPPER = (rs, rowNum) -> new WebhookEndpoint(
            rs.getObject("id", UUID.class), rs.getString("url"), rs.getString("signing_secret"),
            rs.getBoolean("enabled"), rs.getObject("created_at", OffsetDateTime.class).toInstant());
    private final JdbcClient client;

    public EndpointRepository(JdbcClient client) {
        this.client = client;
    }

    public List<WebhookEndpoint> list(int limit) {
        return client.sql("SELECT * FROM webhook_endpoints ORDER BY created_at DESC, id LIMIT :limit")
                .param("limit", limit).query(MAPPER).list();
    }

    public Optional<WebhookEndpoint> disable(UUID id) {
        return client.sql("UPDATE webhook_endpoints SET enabled = false WHERE id = :id RETURNING *")
                .param("id", id).query(MAPPER).optional();
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
