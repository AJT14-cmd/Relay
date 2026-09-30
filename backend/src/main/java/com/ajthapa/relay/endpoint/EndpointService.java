package com.ajthapa.relay.endpoint;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

@Service
public class EndpointService {
    private final EndpointRepository repository;
    private final DestinationPolicy policy;
    private final SecureRandom random = new SecureRandom();
    public EndpointService(EndpointRepository repository, DestinationPolicy policy) {
        this.repository = repository; this.policy = policy;
    }
    public WebhookEndpoint create(String url) {
        String validated = policy.validate(url).toASCIIString();
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        return repository.create(UUID.randomUUID(), validated, Base64.getUrlEncoder().withoutPadding().encodeToString(bytes));
    }
    public List<WebhookEndpoint> list(int limit) {
        if (limit < 1 || limit > 500) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "limit must be between 1 and 500");
        return repository.list(limit);
    }
    @Transactional
    public WebhookEndpoint disable(UUID id) {
        return repository.disable(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Endpoint not found"));
    }
}
