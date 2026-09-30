package com.ajthapa.relay.delivery;

import com.ajthapa.relay.config.RelayProperties;
import com.ajthapa.relay.endpoint.DestinationPolicy;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.concurrent.*;

@Component
public class DeliveryWorker {
    private static final Logger log = LoggerFactory.getLogger(DeliveryWorker.class);
    private final DeliveryRepository repository;
    private final RelayProperties properties;
    private final DestinationPolicy policy;
    private final ObjectMapper json;
    private final MeterRegistry metrics;
    private final ExecutorService executor;
    private final Semaphore slots;
    private final HttpClient http;
    private volatile boolean stopping;

    public DeliveryWorker(DeliveryRepository repository, RelayProperties properties, DestinationPolicy policy,
                          ObjectMapper json, MeterRegistry metrics) {
        this.repository = repository; this.properties = properties; this.policy = policy; this.json = json; this.metrics = metrics;
        int concurrency = properties.getWorker().getConcurrency();
        slots = new Semaphore(concurrency);
        executor = Executors.newFixedThreadPool(concurrency, Thread.ofPlatform().name("delivery-", 0).factory());
        http = HttpClient.newBuilder().connectTimeout(properties.getWorker().getRequestTimeout())
                .followRedirects(HttpClient.Redirect.NEVER).build();
        metrics.gauge("relay.worker.active", slots, s -> concurrency - s.availablePermits());
    }

    @Scheduled(fixedDelayString = "${relay.worker.poll-interval:250}")
    public void scheduledTick() { if (properties.getWorker().isEnabled()) tick(); }

    public void tick() {
        if (stopping) return;
        while (!stopping && slots.tryAcquire()) {
            try {
                var claim = repository.claim();
                if (claim.isEmpty()) { slots.release(); break; }
                try {
                    executor.submit(() -> {
                        try { deliver(claim.get()); }
                        catch (Exception error) {
                            // Durable lease will recover this job if persistence or the process fails.
                            log.error("delivery_persist_failed job={} type={}", claim.get().id(), error.getClass().getSimpleName());
                        } finally { slots.release(); }
                    });
                } catch (RejectedExecutionException error) {
                    slots.release(); // Unsent claimed work will be recovered after lease expiration.
                    break;
                }
            } catch (Exception error) {
                slots.release();
                log.error("queue_claim_failed type={}", error.getClass().getSimpleName());
                break;
            }
        }
    }
    private void deliver(DeliveryRepository.Claim claim) {
        long start = System.nanoTime();
        Integer status = null;
        String error = null;
        boolean retryable = false;
        CompletableFuture<HttpResponse<Void>> pending = null;
        try {
            var envelope = new LinkedHashMap<String, Object>();
            envelope.put("id", claim.eventId()); envelope.put("type", claim.eventType());
            envelope.put("createdAt", claim.eventCreatedAt().toString()); envelope.put("payload", json.readTree(claim.payload()));
            byte[] body = json.writeValueAsBytes(envelope);
            String timestamp = Long.toString(Instant.now().getEpochSecond());
            HttpRequest request = HttpRequest.newBuilder(policy.validate(claim.url()))
                    .timeout(properties.getWorker().getRequestTimeout())
                    .header("Content-Type", "application/json")
                    .header("User-Agent", "Relay/1.0")
                    .header("X-Relay-Event-Id", claim.eventId())
                    .header("X-Relay-Timestamp", timestamp)
                    .header("X-Relay-Signature", sign(claim.signingSecret(), timestamp, body))
                    .POST(HttpRequest.BodyPublishers.ofByteArray(body)).build();
            // Deadline covers the entire response body; discard it to bound retained memory.
            pending = http.sendAsync(request, HttpResponse.BodyHandlers.discarding());
            status = pending.get(properties.getWorker().getRequestTimeout().toMillis(), TimeUnit.MILLISECONDS).statusCode();
            if (status < 200 || status >= 300) {
                error = "Receiver returned HTTP " + status;
                retryable = status == 408 || status == 425 || status == 429 || status >= 500;
            }
        } catch (ResponseStatusException rejected) {
            error = "Destination is no longer allowed";
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            error = "Delivery interrupted; outcome unknown"; retryable = true;
        } catch (TimeoutException timeout) {
            error = "Request timed out; outcome unknown"; retryable = true;
        } catch (Exception failed) {
            error = "Network or delivery failure; outcome unknown"; retryable = true;
        } finally {
            if (pending != null && !pending.isDone()) pending.cancel(true);
        }
        long duration = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        long delay = retryable ? backoff(claim.cycleAttempt()) : 0;
        boolean saved = repository.finish(claim, status, error, duration, retryable, delay);
        if (saved) {
            String outcome = error == null ? "success" : retryable ? "temporary_failure" : "permanent_failure";
            metrics.counter("relay.delivery.attempts", "outcome", outcome).increment();
            metrics.timer("relay.delivery.duration").record(duration, TimeUnit.MILLISECONDS);
            log.info("delivery_finished job={} attempt={} outcome={} httpStatus={} durationMs={}",
                    claim.id(), claim.attemptNumber(), outcome, status, duration);
        } else {
            metrics.counter("relay.delivery.stale_completions").increment();
            log.warn("delivery_stale_completion job={} attempt={}", claim.id(), claim.attemptNumber());
        }
    }
    private long backoff(int attempt) {
        long base = properties.getWorker().getBaseBackoff().toMillis();
        long cap = properties.getWorker().getMaxBackoff().toMillis();
        long window = (long) Math.min(cap, base * Math.pow(2, Math.min(attempt - 1, 30)));
        long half = Math.max(1, window / 2);
        return ThreadLocalRandom.current().nextLong(half, Math.max(half + 1, window + 1));
    }
    public static String sign(String secret, String timestamp, byte[] body) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        mac.update((timestamp + ".").getBytes(StandardCharsets.UTF_8));
        return "v1=" + HexFormat.of().formatHex(mac.doFinal(body));
    }
    @PreDestroy
    public void stop() {
        stopping = true;
        executor.shutdown();
        try {
            if (!executor.awaitTermination(properties.getWorker().getRequestTimeout().toSeconds() + 5, TimeUnit.SECONDS))
                executor.shutdownNow();
        } catch (InterruptedException ex) {
            executor.shutdownNow(); Thread.currentThread().interrupt();
        }
        http.shutdownNow();
    }
}
