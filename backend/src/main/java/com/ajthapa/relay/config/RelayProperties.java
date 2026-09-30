package com.ajthapa.relay.config;

import jakarta.annotation.PostConstruct;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;
import java.time.Duration;
import java.util.List;

@Component
@ConfigurationProperties(prefix = "relay")
public class RelayProperties {
    private String apiKey = "relay-local-dev-key";
    private List<String> allowedHosts = List.of("localhost", "127.0.0.1", "receiver");
    private final Worker worker = new Worker();

    @PostConstruct
    void validate() {
        if (apiKey == null || apiKey.length() < 16) throw new IllegalArgumentException("relay.api-key must contain at least 16 characters");
        if (allowedHosts == null || allowedHosts.isEmpty()) throw new IllegalArgumentException("relay.allowed-hosts must not be empty");
        if (worker.concurrency < 1 || worker.concurrency > 64 || worker.maxAttempts < 1 || worker.maxAttempts > 100)
            throw new IllegalArgumentException("Invalid worker concurrency or attempt limit");
        if (worker.requestTimeout.isNegative() || worker.requestTimeout.isZero() || worker.leaseDuration.compareTo(worker.requestTimeout.multipliedBy(2)) < 0)
            throw new IllegalArgumentException("Lease must be at least twice the positive request timeout");
        if (worker.baseBackoff.isNegative() || worker.baseBackoff.isZero() || worker.maxBackoff.compareTo(worker.baseBackoff) < 0)
            throw new IllegalArgumentException("Invalid retry backoff");
    }
    public String getApiKey() { return apiKey; }
    public void setApiKey(String apiKey) { this.apiKey = apiKey; }
    public List<String> getAllowedHosts() { return allowedHosts; }
    public void setAllowedHosts(List<String> allowedHosts) { this.allowedHosts = allowedHosts; }
    public Worker getWorker() { return worker; }

    public static class Worker {
        private boolean enabled = true;
        private int concurrency = 4;
        private int maxAttempts = 5;
        private Duration requestTimeout = Duration.ofSeconds(3);
        private Duration leaseDuration = Duration.ofSeconds(30);
        private Duration baseBackoff = Duration.ofSeconds(1);
        private Duration maxBackoff = Duration.ofMinutes(1);
        public boolean isEnabled() { return enabled; }
        public void setEnabled(boolean value) { enabled = value; }
        public int getConcurrency() { return concurrency; }
        public void setConcurrency(int value) { concurrency = value; }
        public int getMaxAttempts() { return maxAttempts; }
        public void setMaxAttempts(int value) { maxAttempts = value; }
        public Duration getRequestTimeout() { return requestTimeout; }
        public void setRequestTimeout(Duration value) { requestTimeout = value; }
        public Duration getLeaseDuration() { return leaseDuration; }
        public void setLeaseDuration(Duration value) { leaseDuration = value; }
        public Duration getBaseBackoff() { return baseBackoff; }
        public void setBaseBackoff(Duration value) { baseBackoff = value; }
        public Duration getMaxBackoff() { return maxBackoff; }
        public void setMaxBackoff(Duration value) { maxBackoff = value; }
    }
}
