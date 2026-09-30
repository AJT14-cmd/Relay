package com.ajthapa.relay;

import com.ajthapa.relay.delivery.DeliveryRepository;
import com.ajthapa.relay.delivery.DeliveryWorker;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.*;

/** Exercises the actual HTTP API, Flyway schema, PostgreSQL transactions and delivery worker. */
@Testcontainers
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "relay.api-key=integration-test-key",
        "relay.allowed-hosts=localhost,127.0.0.1",
        "relay.worker.enabled=false",
        "relay.worker.concurrency=2",
        "relay.worker.lease-duration=PT3S",
        "relay.worker.request-timeout=PT1S",
        "relay.worker.poll-interval=100",
        "relay.worker.max-attempts=3",
        "relay.worker.base-backoff=PT0.05S",
        "relay.worker.max-backoff=PT0.2S"
})
class RelayIntegrationTests {
    @Container
    static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:18.6");

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry properties) {
        properties.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        properties.add("spring.datasource.username", POSTGRES::getUsername);
        properties.add("spring.datasource.password", POSTGRES::getPassword);
    }

    @LocalServerPort
    private int port;
    @Autowired
    private JdbcClient database;
    @Autowired
    private ObjectMapper json;
    @Autowired
    private DeliveryWorker worker;
    @Autowired
    private DeliveryRepository deliveries;

    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    private ProbeReceiver receiver;

    @BeforeEach
    void cleanDatabaseAndStartReceiver() throws IOException {
        database.sql("TRUNCATE delivery_attempts, delivery_jobs, webhook_events, webhook_endpoints CASCADE").update();
        receiver = new ProbeReceiver();
    }

    @AfterEach
    void stopReceiver() {
        if (receiver != null) receiver.close();
        await("all outgoing requests to finish", () -> count("SELECT count(*) FROM delivery_jobs WHERE status = 'IN_FLIGHT'") == 0);
        client.close();
    }

    @Test
    void apiRequiresKeyAndRejectsInvalidInputsWithoutWritingRows() throws Exception {
        assertEquals(401, request("GET", "/api/endpoints", null, null).statusCode());
        assertEquals(401, request("GET", "/api/endpoints", null, "wrong-key").statusCode());
        assertEquals(400, post("/api/endpoints", Map.of("url", " ")).statusCode());
        assertEquals(400, post("/api/endpoints", Map.of("url", "not-a-url")).statusCode());
        assertEquals(400, post("/api/endpoints", Map.of("url", "ftp://localhost/file")).statusCode());
        assertEquals(400, post("/api/endpoints", Map.of("url", "http://example.com/hook")).statusCode());
        assertEquals(0, count("SELECT count(*) FROM webhook_endpoints"));

        JsonNode endpoint = register();
        assertEquals(400, post("/api/events", Map.of("id", "", "endpointId", endpoint.path("id").asText(),
                "type", "order.created", "payload", Map.of())).statusCode());
        for (String invalidId : List.of("line\nbreak", "line\rbreak", "event-\u2603")) {
            assertEquals(400, post("/api/events", event(invalidId, endpoint, Map.of())).statusCode());
        }
        assertEquals(400, post("/api/events", Map.of("id", "bad-payload", "endpointId", endpoint.path("id").asText(),
                "type", "order.created", "payload", List.of("not-an-object"))).statusCode());
        assertEquals(400, post("/api/events", event("nul-value-event", endpoint,
                Map.of("value", "text" + (char) 0))).statusCode());
        assertEquals(400, post("/api/events", event("nul-key-event", endpoint,
                Map.of("key" + (char) 0, "value"))).statusCode());
        assertEquals(413, post("/api/events", event("oversized-event", endpoint,
                Map.of("message", "x".repeat(65_536)))).statusCode());
        assertEquals(0, count("SELECT count(*) FROM webhook_events"));
        assertEquals(0, count("SELECT count(*) FROM delivery_jobs"));
    }

    @Test
    void unsupportedRoutesMethodsAndMediaTypesKeepTheirClientErrorStatuses() throws Exception {
        assertEquals(404, get("/api/not-a-route").statusCode());
        assertEquals(405, request("PUT", "/api/endpoints", Map.of("url", receiver.url()),
                "integration-test-key").statusCode());
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/endpoints"))
                .timeout(Duration.ofSeconds(10))
                .header("X-API-Key", "integration-test-key")
                .header("Content-Type", "text/plain")
                .POST(HttpRequest.BodyPublishers.ofString(receiver.url())).build();
        assertEquals(415, client.send(request, HttpResponse.BodyHandlers.ofString()).statusCode());
        assertEquals(0, count("SELECT count(*) FROM webhook_endpoints"));
    }

    @Test
    void registrationRevealsSecretOnceAndListingOmitsIt() throws Exception {
        JsonNode endpoint = register();
        assertTrue(endpoint.path("enabled").asBoolean());
        assertFalse(endpoint.path("signingSecret").asText().isBlank());
        assertNotNull(UUID.fromString(endpoint.path("id").asText()));
        assertNotNull(Instant.parse(endpoint.path("createdAt").asText()));

        HttpResponse<String> response = get("/api/endpoints");
        assertEquals(200, response.statusCode());
        JsonNode endpoints = json.readTree(response.body());
        assertEquals(1, endpoints.size());
        assertFalse(endpoints.get(0).has("signingSecret"));
        assertFalse(response.body().contains(endpoint.path("signingSecret").asText()));
    }

    @Test
    void concurrentDuplicateSubmissionsCreateExactlyOneEventAndOneJob() throws Exception {
        JsonNode endpoint = register();
        var originalPayload = new java.util.LinkedHashMap<String, Object>();
        originalPayload.put("orderId", 42);
        originalPayload.put("total", 12);
        Map<String, Object> event = event("concurrent-event", endpoint, originalPayload);
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var futures = new ArrayList<java.util.concurrent.Future<Integer>>();
            for (int i = 0; i < 10; i++) futures.add(executor.submit(() -> post("/api/events", event).statusCode()));
            List<Integer> statuses = new ArrayList<>();
            for (var future : futures) statuses.add(future.get(10, TimeUnit.SECONDS));
            assertEquals(1, statuses.stream().filter(status -> status == 202).count(), statuses.toString());
            assertEquals(9, statuses.stream().filter(status -> status == 200).count(), statuses.toString());
        }
        assertEquals(1, count("SELECT count(*) FROM webhook_events"));
        assertEquals(1, count("SELECT count(*) FROM delivery_jobs"));
        assertEquals("PENDING", status("concurrent-event"));
        assertEquals(0, receiver.requests.size());

        // JSON property order is not part of the idempotency key's meaning.
        var reorderedPayload = new java.util.LinkedHashMap<String, Object>();
        reorderedPayload.put("total", 12);
        reorderedPayload.put("orderId", 42);
        assertEquals(200, post("/api/events", event("concurrent-event", endpoint, reorderedPayload)).statusCode());
        assertEquals(409, post("/api/events", event("concurrent-event", endpoint,
                Map.of("orderId", 42, "total", 99))).statusCode());
        var differentType = new java.util.HashMap<>(event);
        differentType.put("type", "order.cancelled");
        assertEquals(409, post("/api/events", differentType).statusCode());
        JsonNode secondEndpoint = register();
        assertEquals(409, post("/api/events", event("concurrent-event", secondEndpoint,
                Map.of("orderId", 42, "total", 12))).statusCode());
        assertEquals(1, count("SELECT count(*) FROM delivery_jobs"));
    }

    @Test
    void failureToCreateJobRollsBackTheEventInTheSameTransaction() throws Exception {
        JsonNode endpoint = register();
        database.sql("""
                CREATE FUNCTION relay_test_reject_job() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    RAISE EXCEPTION 'Deliberate integration test failure';
                END;
                $$
                """).update();
        database.sql("""
                CREATE TRIGGER relay_test_reject_job BEFORE INSERT ON delivery_jobs
                FOR EACH ROW EXECUTE FUNCTION relay_test_reject_job()
                """).update();
        try {
            assertEquals(500, post("/api/events", event("atomic-event", endpoint, Map.of("value", 1))).statusCode());
            assertEquals(0, count("SELECT count(*) FROM webhook_events"));
            assertEquals(0, count("SELECT count(*) FROM delivery_jobs"));
        } finally {
            database.sql("DROP TRIGGER relay_test_reject_job ON delivery_jobs").update();
            database.sql("DROP FUNCTION relay_test_reject_job()").update();
        }
        assertEquals(202, post("/api/events", event("atomic-event", endpoint, Map.of("value", 1))).statusCode());
    }

    @Test
    void workerDeliversExactSignedEnvelopeAndRecordsAnAttempt() throws Exception {
        JsonNode endpoint = register();
        assertEquals(202, post("/api/events", event("signed-event", endpoint, Map.of("message", "café", "orderId", 42))).statusCode());
        pumpUntil("signed-event", "SUCCEEDED");
        assertEquals(1, receiver.requests.size());
        Received received = receiver.requests.getFirst();
        JsonNode envelope = json.readTree(received.body());
        assertEquals("signed-event", envelope.path("id").asText());
        assertEquals("order.created", envelope.path("type").asText());
        assertEquals("café", envelope.path("payload").path("message").asText());
        assertNotNull(Instant.parse(envelope.path("createdAt").asText()));
        assertEquals("signed-event", received.eventId());
        assertTrue(Math.abs(Instant.now().getEpochSecond() - Long.parseLong(received.timestamp())) < 30);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(endpoint.path("signingSecret").asText().getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        mac.update((received.timestamp() + ".").getBytes(StandardCharsets.UTF_8));
        assertEquals("v1=" + HexFormat.of().formatHex(mac.doFinal(received.body())), received.signature());

        JsonNode detail = json.readTree(get("/api/deliveries/" + jobId("signed-event")).body());
        assertEquals("SUCCEEDED", detail.path("status").asText());
        assertEquals(1, detail.path("attempts").size());
        assertEquals(204, detail.path("attempts").get(0).path("httpStatus").asInt());
        assertFalse(detail.toString().contains(endpoint.path("signingSecret").asText()));
        assertEquals(1, count("SELECT count(*) FROM delivery_attempts WHERE finished_at IS NOT NULL AND http_status = 204"));
        HttpResponse<String> deliveries = get("/api/deliveries");
        assertEquals(200, deliveries.statusCode());
        assertEquals(1, json.readTree(deliveries.body()).size());
        assertFalse(deliveries.body().contains(endpoint.path("signingSecret").asText()));
    }

    @Test
    void temporaryFailureSchedulesARetryThatCanSucceed() throws Exception {
        receiver.responseStatus = 429;
        JsonNode endpoint = register();
        assertEquals(202, post("/api/events", event("retry-event", endpoint, Map.of())).statusCode());
        worker.tick();
        await("first retry scheduled", () -> status("retry-event").equals("RETRY_WAIT"));
        assertEquals(1, receiver.requests.size());
        assertEquals(1, count("SELECT count(*) FROM delivery_jobs WHERE next_attempt_at > updated_at AND status = 'RETRY_WAIT'"));
        receiver.responseStatus = 204;
        pumpUntil("retry-event", "SUCCEEDED");
        assertEquals(2, receiver.requests.size());
        assertEquals(2, count("SELECT count(*) FROM delivery_attempts"));
    }

    @Test
    void temporaryFailuresExhaustAndExplicitReplayKeepsTheEventIdAndHistory() throws Exception {
        receiver.responseStatus = 503;
        JsonNode endpoint = register();
        assertEquals(202, post("/api/events", event("replay-event", endpoint, Map.of("orderId", 42))).statusCode());
        pumpUntil("replay-event", "EXHAUSTED");
        assertEquals(3, receiver.requests.size());
        assertEquals(3, count("SELECT count(*) FROM delivery_attempts"));
        receiver.responseStatus = 204;
        HttpResponse<String> replay = post("/api/deliveries/" + jobId("replay-event") + "/replay", null);
        assertTrue(replay.statusCode() >= 200 && replay.statusCode() < 300, replay.body());
        pumpUntil("replay-event", "SUCCEEDED");
        assertEquals(4, receiver.requests.size());
        assertEquals(4, count("SELECT count(*) FROM delivery_attempts"));
        assertEquals(1, count("SELECT count(*) FROM delivery_jobs WHERE replay_count = 1"));
        assertTrue(receiver.requests.stream().allMatch(request -> request.eventId().equals("replay-event")));
        for (Received request : receiver.requests) assertArrayEquals(receiver.requests.getFirst().body(), request.body());
        assertEquals(409, post("/api/deliveries/" + jobId("replay-event") + "/replay", null).statusCode());
    }

    @Test
    void permanentHttpFailureStopsWithoutRetrying() throws Exception {
        receiver.responseStatus = 400;
        JsonNode endpoint = register();
        assertEquals(202, post("/api/events", event("permanent-event", endpoint, Map.of())).statusCode());
        pumpUntil("permanent-event", "EXHAUSTED");
        assertEquals(1, receiver.requests.size());
        assertEquals(1, count("SELECT count(*) FROM delivery_attempts"));
    }

    @Test
    void workerDoesNotFollowReceiverRedirects() throws Exception {
        try (var redirectTarget = new ProbeReceiver()) {
            receiver.responseStatus = 302;
            receiver.redirectLocation = redirectTarget.url();
            JsonNode endpoint = register();
            assertEquals(202, post("/api/events", event("redirect-event", endpoint, Map.of())).statusCode());
            pumpUntil("redirect-event", "EXHAUSTED");
            assertEquals(1, receiver.requests.size());
            assertEquals(0, redirectTarget.requests.size(), "Redirects must not bypass the destination allowlist");
        }
    }

    @Test
    void timeoutCanCauseDuplicateDeliveryButReceiverDeduplicatesItsEffect() throws Exception {
        receiver.firstRequestDelayMillis = 1500;
        JsonNode endpoint = register();
        assertEquals(202, post("/api/events", event("timeout-event", endpoint, Map.of())).statusCode());
        pumpUntil("timeout-event", "SUCCEEDED");
        assertEquals(2, receiver.requests.size());
        assertEquals(1, receiver.processedIds.size(), "Business effects must deduplicate by stable event ID");
        assertEquals(2, count("SELECT count(*) FROM delivery_attempts"));
        assertEquals(1, count("SELECT count(*) FROM delivery_attempts WHERE http_status IS NULL AND error IS NOT NULL"));
    }

    @Test
    void concurrentTicksCannotSendTheSameLiveLeaseTwice() throws Exception {
        receiver.releaseResponses = new CountDownLatch(1);
        JsonNode endpoint = register();
        assertEquals(202, post("/api/events", event("claimed-event", endpoint, Map.of())).statusCode());
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var futures = new ArrayList<java.util.concurrent.Future<?>>();
            for (int i = 0; i < 12; i++) futures.add(executor.submit(worker::tick));
            for (var future : futures) future.get(10, TimeUnit.SECONDS);
        }
        await("one outgoing request", () -> {
            worker.tick();
            return receiver.requests.size() == 1;
        });
        assertEquals("IN_FLIGHT", status("claimed-event"));
        assertEquals(1, count("SELECT count(*) FROM delivery_jobs WHERE attempt_count = 1"));
        receiver.releaseResponses.countDown();
        pumpUntil("claimed-event", "SUCCEEDED");
        assertEquals(1, receiver.requests.size());
    }

    @Test
    void workerNeverExceedsItsConfiguredConcurrency() throws Exception {
        receiver.releaseResponses = new CountDownLatch(1);
        JsonNode endpoint = register();
        for (int i = 0; i < 6; i++) {
            assertEquals(202, post("/api/events", event("bounded-" + i, endpoint, Map.of())).statusCode());
        }
        for (int i = 0; i < 8; i++) worker.tick();
        await("two outgoing requests", () -> {
            worker.tick();
            return receiver.requests.size() == 2;
        });
        assertEquals(2, count("SELECT count(*) FROM delivery_jobs WHERE status = 'IN_FLIGHT'"));
        assertEquals(4, count("SELECT count(*) FROM delivery_jobs WHERE status = 'PENDING'"));
        receiver.releaseResponses.countDown();
        for (int i = 0; i < 6; i++) pumpUntil("bounded-" + i, "SUCCEEDED");
        assertEquals(6, receiver.requests.size());
        assertTrue(receiver.maximumActive.get() <= 2, "Bounded pool exceeded configured concurrency");
    }

    @Test
    void workerRecoversAnExpiredLeaseAfterACrashedProcess() throws Exception {
        JsonNode endpoint = register();
        assertEquals(202, post("/api/events", event("recover-event", endpoint, Map.of())).statusCode());
        DeliveryRepository.Claim lostClaim = deliveries.claim().orElseThrow();
        expire(lostClaim);
        pumpUntil("recover-event", "SUCCEEDED");
        assertEquals(1, receiver.requests.size());
        assertEquals(2, count("SELECT count(*) FROM delivery_attempts"));
        assertEquals(1, count("SELECT count(*) FROM delivery_attempts WHERE finished_at IS NOT NULL AND error LIKE '%lease expired%'"));
        assertEquals(1, count("SELECT count(*) FROM delivery_jobs WHERE lease_token IS NULL AND lease_expires_at IS NULL"));
    }

    @Test
    void staleWorkerCompletionCannotChangeAReclaimedJobOrItsNewAttempt() throws Exception {
        JsonNode endpoint = register();
        assertEquals(202, post("/api/events", event("fenced-event", endpoint, Map.of())).statusCode());
        DeliveryRepository.Claim stale = deliveries.claim().orElseThrow();
        expire(stale);
        assertFalse(deliveries.finish(stale, 204, null, 10, false, 0), "An expired lease cannot complete work");
        DeliveryRepository.Claim current = deliveries.claim().orElseThrow();
        assertNotEquals(stale.token(), current.token());
        assertFalse(deliveries.finish(stale, 503, "Late failure", 20, true, 50));
        assertEquals("IN_FLIGHT", status("fenced-event"));
        assertTrue(deliveries.finish(current, 204, null, 10, false, 0));
        assertFalse(deliveries.finish(stale, 503, "Even later failure", 30, true, 50));
        assertEquals("SUCCEEDED", status("fenced-event"));
        assertEquals(1, count("SELECT count(*) FROM delivery_attempts WHERE http_status = 204"));
        assertEquals(1, count("SELECT count(*) FROM delivery_attempts WHERE http_status IS NULL AND error LIKE '%lease expired%'"));
    }

    @Test
    void independentDatabaseClaimersNeverAcquireTheSameJob() throws Exception {
        JsonNode endpoint = register();
        for (int i = 0; i < 2; i++) {
            assertEquals(202, post("/api/events", event("database-claim-" + i, endpoint, Map.of())).statusCode());
        }
        List<DeliveryRepository.Claim> claims = new ArrayList<>();
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var start = new CountDownLatch(1);
            var futures = new ArrayList<java.util.concurrent.Future<java.util.Optional<DeliveryRepository.Claim>>>();
            for (int i = 0; i < 10; i++) futures.add(executor.submit(() -> {
                start.await();
                return deliveries.claim();
            }));
            start.countDown();
            for (var future : futures) future.get(10, TimeUnit.SECONDS).ifPresent(claims::add);
        }
        assertEquals(2, claims.size());
        assertEquals(2, claims.stream().map(DeliveryRepository.Claim::id).distinct().count());
        assertEquals(2, count("SELECT count(*) FROM delivery_attempts"));
        for (var claim : claims) assertTrue(deliveries.finish(claim, 204, null, 1, false, 0));
    }

    @Test
    void repeatedWorkerCrashesConsumeAttemptBudgetAndRetainExhaustedHistory() throws Exception {
        JsonNode endpoint = register();
        assertEquals(202, post("/api/events", event("crashing-event", endpoint, Map.of())).statusCode());
        for (int i = 0; i < 3; i++) {
            DeliveryRepository.Claim interrupted = deliveries.claim().orElseThrow();
            expire(interrupted);
        }
        worker.tick();
        assertEquals("EXHAUSTED", status("crashing-event"));
        assertTrue(deliveries.claim().isEmpty());
        assertEquals(3, count("SELECT count(*) FROM delivery_attempts WHERE finished_at IS NOT NULL"));
        assertEquals(1, count("SELECT count(*) FROM delivery_jobs WHERE attempt_count = 3 AND cycle_attempt_count = 3"));
        assertEquals(1, count("SELECT count(*) FROM webhook_events"));
        assertEquals(0, receiver.requests.size());
        HttpResponse<String> response = get("/api/deliveries/" + jobId("crashing-event"));
        assertEquals(200, response.statusCode());
        assertEquals(3, json.readTree(response.body()).path("attempts").size());
    }

    @Test
    void racingReplayRequestsStartExactlyOneNewDeliveryCycle() throws Exception {
        JsonNode endpoint = register();
        assertEquals(202, post("/api/events", event("replay-race-event", endpoint, Map.of())).statusCode());
        DeliveryRepository.Claim first = deliveries.claim().orElseThrow();
        assertTrue(deliveries.finish(first, 400, "Permanent receiver error", 1, false, 0));
        String path = "/api/deliveries/" + jobId("replay-race-event") + "/replay";
        try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
            var start = new CountDownLatch(1);
            var futures = new ArrayList<java.util.concurrent.Future<Integer>>();
            for (int i = 0; i < 8; i++) futures.add(executor.submit(() -> {
                start.await();
                return post(path, null).statusCode();
            }));
            start.countDown();
            List<Integer> statuses = new ArrayList<>();
            for (var future : futures) statuses.add(future.get(10, TimeUnit.SECONDS));
            assertEquals(1, statuses.stream().filter(status -> status >= 200 && status < 300).count(), statuses.toString());
            assertEquals(7, statuses.stream().filter(status -> status == 409).count(), statuses.toString());
        }
        assertEquals("PENDING", status("replay-race-event"));
        assertEquals(1, count("SELECT count(*) FROM delivery_jobs WHERE replay_count = 1 AND cycle_attempt_count = 0 AND attempt_count = 1"));
        assertEquals(1, count("SELECT count(*) FROM delivery_attempts"));
        pumpUntil("replay-race-event", "SUCCEEDED");
        assertEquals(2, count("SELECT count(*) FROM delivery_attempts"));
        assertEquals(1, receiver.requests.size());
    }

    @Test
    void disablingAnEndpointCancelsPendingWork() throws Exception {
        JsonNode endpoint = register();
        assertEquals(202, post("/api/events", event("disabled-event", endpoint, Map.of())).statusCode());
        HttpResponse<String> disabled = post("/api/endpoints/" + endpoint.path("id").asText() + "/disable", null);
        assertTrue(disabled.statusCode() >= 200 && disabled.statusCode() < 300, disabled.body());
        pumpUntil("disabled-event", "CANCELLED");
        assertEquals(0, receiver.requests.size());
        assertEquals(0, count("SELECT count(*) FROM delivery_attempts"));
        assertEquals(200, post("/api/events", event("disabled-event", endpoint, Map.of())).statusCode(),
                "A duplicate is a lookup of accepted work even when its endpoint is now disabled");
        assertEquals(409, post("/api/events", event("new-disabled-event", endpoint, Map.of())).statusCode());
    }

    @Test
    void cancelledBacklogDoesNotPreventAHealthyEndpointFromBeingScheduled() throws Exception {
        JsonNode disabled = register();
        for (int i = 0; i < 10; i++) {
            assertEquals(202, post("/api/events", event("disabled-backlog-" + i, disabled, Map.of())).statusCode());
        }
        HttpResponse<String> response = post("/api/endpoints/" + disabled.path("id").asText() + "/disable", null);
        assertTrue(response.statusCode() >= 200 && response.statusCode() < 300, response.body());
        JsonNode healthy = register();
        assertEquals(202, post("/api/events", event("healthy-event", healthy, Map.of())).statusCode());
        // One scheduling pass must skip a short disabled backlog instead of declaring the queue empty.
        worker.tick();
        await("healthy delivery behind cancelled work", () -> status("healthy-event").equals("SUCCEEDED"));
        assertEquals(10, count("SELECT count(*) FROM delivery_jobs WHERE status = 'CANCELLED'"));
        assertEquals(1, receiver.requests.size());
        assertEquals("healthy-event", receiver.requests.getFirst().eventId());
    }

    private JsonNode register() throws Exception {
        HttpResponse<String> response = post("/api/endpoints", Map.of("url", receiver.url()));
        assertEquals(201, response.statusCode(), response.body());
        return json.readTree(response.body());
    }

    private Map<String, Object> event(String id, JsonNode endpoint, Object payload) {
        return Map.of("id", id, "endpointId", endpoint.path("id").asText(), "type", "order.created", "payload", payload);
    }

    private HttpResponse<String> post(String path, Object body) throws Exception {
        return request("POST", path, body, "integration-test-key");
    }

    private HttpResponse<String> get(String path) throws Exception {
        return request("GET", path, null, "integration-test-key");
    }

    private HttpResponse<String> request(String method, String path, Object body, String key) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                .timeout(Duration.ofSeconds(10)).header("Content-Type", "application/json");
        if (key != null) builder.header("X-API-Key", key);
        builder.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    private UUID jobId(String eventId) {
        return database.sql("SELECT id FROM delivery_jobs WHERE event_id = :id")
                .param("id", eventId).query(UUID.class).single();
    }

    private String status(String eventId) {
        return database.sql("SELECT status FROM delivery_jobs WHERE event_id = :id")
                .param("id", eventId).query(String.class).single();
    }

    private long count(String sql) {
        return database.sql(sql).query(Long.class).single();
    }

    private void expire(DeliveryRepository.Claim claim) {
        database.sql("UPDATE delivery_jobs SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = :id")
                .param("id", claim.id()).update();
    }

    private void pumpUntil(String eventId, String wantedStatus) {
        await("event " + eventId + " to reach " + wantedStatus, () -> {
            worker.tick();
            return status(eventId).equals(wantedStatus);
        });
    }

    private void await(String description, BooleanSupplier condition) {
        long deadline = System.nanoTime() + Duration.ofSeconds(12).toNanos();
        while (System.nanoTime() < deadline) {
            if (condition.getAsBoolean()) return;
            try {
                Thread.sleep(15);
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                throw new AssertionError("Interrupted waiting for " + description, exception);
            }
        }
        fail("Timed out waiting for " + description);
    }

    private record Received(byte[] body, String eventId, String timestamp, String signature) { }

    /** Represents a receiver that commits a deduplicated effect before sending its HTTP response. */
    private static final class ProbeReceiver implements AutoCloseable {
        private final HttpServer server;
        private final java.util.concurrent.ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
        private final List<Received> requests = new CopyOnWriteArrayList<>();
        private final Set<String> processedIds = ConcurrentHashMap.newKeySet();
        private final AtomicInteger sequence = new AtomicInteger();
        private final AtomicInteger active = new AtomicInteger();
        private final AtomicInteger maximumActive = new AtomicInteger();
        private volatile int responseStatus = 204;
        private volatile String redirectLocation;
        private volatile long firstRequestDelayMillis;
        private volatile CountDownLatch releaseResponses = new CountDownLatch(0);

        private ProbeReceiver() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/hook", this::receive);
            server.setExecutor(executor);
            server.start();
        }

        private String url() {
            return "http://127.0.0.1:" + server.getAddress().getPort() + "/hook";
        }

        private void receive(HttpExchange exchange) throws IOException {
            int current = active.incrementAndGet();
            maximumActive.accumulateAndGet(current, Math::max);
            try (exchange) {
                var headers = exchange.getRequestHeaders();
                String eventId = headers.getFirst("X-Relay-Event-Id");
                requests.add(new Received(exchange.getRequestBody().readAllBytes(), eventId,
                        headers.getFirst("X-Relay-Timestamp"), headers.getFirst("X-Relay-Signature")));
                if (eventId != null && responseStatus >= 200 && responseStatus < 300) processedIds.add(eventId);
                if (sequence.incrementAndGet() == 1 && firstRequestDelayMillis > 0) Thread.sleep(firstRequestDelayMillis);
                releaseResponses.await(8, TimeUnit.SECONDS);
                if (redirectLocation != null) exchange.getResponseHeaders().set("Location", redirectLocation);
                exchange.sendResponseHeaders(responseStatus, -1);
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
            } finally {
                active.decrementAndGet();
            }
        }

        @Override
        public void close() {
            releaseResponses.countDown();
            server.stop(0);
            executor.shutdownNow();
        }
    }
}
