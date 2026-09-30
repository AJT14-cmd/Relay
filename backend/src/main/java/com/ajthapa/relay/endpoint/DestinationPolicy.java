package com.ajthapa.relay.endpoint;

import com.ajthapa.relay.config.RelayProperties;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import java.net.URI;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;

@Component
public class DestinationPolicy {
    private final Set<String> allowedHosts;
    public DestinationPolicy(RelayProperties properties) {
        allowedHosts = properties.getAllowedHosts().stream().map(s -> s.trim().toLowerCase(Locale.ROOT)).collect(Collectors.toUnmodifiableSet());
    }
    public URI validate(String value) {
        try {
            URI uri = URI.create(value);
            if (value.length() > 2048 || uri.getHost() == null || uri.getRawUserInfo() != null ||
                    uri.getRawFragment() != null || (!"http".equalsIgnoreCase(uri.getScheme()) && !"https".equalsIgnoreCase(uri.getScheme())) ||
                    uri.getPort() == 0 || uri.getPort() > 65535 || !allowedHosts.contains(uri.getHost().toLowerCase(Locale.ROOT))) {
                throw new IllegalArgumentException();
            }
            return uri;
        } catch (IllegalArgumentException | NullPointerException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "URL must be HTTP(S), use an explicitly allowed host, and contain no credentials or fragment");
        }
    }
}
