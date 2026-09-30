package com.ajthapa.relay.event;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import jakarta.validation.constraints.Pattern;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.JsonNode;
import java.net.URI;
import java.time.Instant;
import java.util.UUID;

@RestController
@RequestMapping("/api/events")
public class EventController {
    private final EventService service;
    public EventController(EventService service) { this.service = service; }

    @PostMapping
    ResponseEntity<EventView> submit(@Valid @RequestBody SubmitEvent request) {
        EventService.Acceptance result = service.accept(request);
        return ResponseEntity.status(result.created() ? 202 : 200)
                .location(URI.create("/api/deliveries/" + result.event().deliveryId())).body(result.event());
    }
    public record SubmitEvent(@NotBlank @Pattern(regexp = "[A-Za-z0-9._:-]{1,128}") String id, @NotNull UUID endpointId,
                              @NotBlank @Size(max = 128) String type, @NotNull JsonNode payload) {}
    public record EventView(String id, UUID endpointId, String type, JsonNode payload, Instant createdAt, UUID deliveryId) {}
}
