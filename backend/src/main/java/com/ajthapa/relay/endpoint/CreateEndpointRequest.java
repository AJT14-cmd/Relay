package com.ajthapa.relay.endpoint;
import jakarta.validation.constraints.NotBlank;

public record CreateEndpointRequest(
        @NotBlank String url
) {
}
