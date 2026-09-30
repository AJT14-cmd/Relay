package com.ajthapa.relay.endpoint;

import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/endpoints")
public class EndpointController {
    private final EndpointService service;
    public EndpointController(EndpointService service) { this.service = service; }

    @PostMapping
    ResponseEntity<CreateEndpointResponse> create(@Valid @RequestBody CreateEndpointRequest request) {
        WebhookEndpoint e = service.create(request.url());
        return ResponseEntity.created(URI.create("/api/endpoints/" + e.getId())).body(new CreateEndpointResponse(
                e.getId(), e.getUrl(), e.getSigningSecret(), e.isEnabled(), e.getCreatedAt()));
    }
    @GetMapping
    List<EndpointView> list(@RequestParam(defaultValue = "100") int limit) {
        return service.list(limit).stream().map(EndpointView::from).toList();
    }
    @PostMapping("/{id}/disable")
    EndpointView disable(@PathVariable UUID id) { return EndpointView.from(service.disable(id)); }

    public record EndpointView(UUID id, String url, boolean enabled, Instant createdAt) {
        static EndpointView from(WebhookEndpoint e) {
            return new EndpointView(e.getId(), e.getUrl(), e.isEnabled(), e.getCreatedAt());
        }
    }
}
