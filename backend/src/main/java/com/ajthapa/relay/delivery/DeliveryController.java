package com.ajthapa.relay.delivery;

import org.springframework.web.bind.annotation.*;
import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/deliveries")
public class DeliveryController {
    private final DeliveryRepository repository;
    public DeliveryController(DeliveryRepository repository) { this.repository = repository; }
    @GetMapping
    List<DeliveryView> list(@RequestParam(defaultValue = "100") int limit,
                            @RequestParam(required = false) String status) { return repository.list(limit, status); }
    @GetMapping("/{id}")
    DeliveryView detail(@PathVariable UUID id) { return repository.detail(id); }
    @PostMapping("/{id}/replay")
    DeliveryView replay(@PathVariable UUID id) { return repository.replay(id); }
}
