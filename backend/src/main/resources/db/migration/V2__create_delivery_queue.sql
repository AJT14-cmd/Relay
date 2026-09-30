CREATE TABLE webhook_events (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id),
    type TEXT NOT NULL CHECK (length(type) BETWEEN 1 AND 128),
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE delivery_jobs (
    id UUID PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE REFERENCES webhook_events(id),
    status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','IN_FLIGHT','RETRY_WAIT','SUCCEEDED','EXHAUSTED','CANCELLED')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    cycle_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (cycle_attempt_count >= 0),
    replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
    next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lease_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((status = 'IN_FLIGHT') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX delivery_jobs_due ON delivery_jobs(next_attempt_at, created_at)
    WHERE status IN ('PENDING', 'RETRY_WAIT');
CREATE INDEX delivery_jobs_expired ON delivery_jobs(lease_expires_at) WHERE status = 'IN_FLIGHT';
CREATE INDEX delivery_jobs_recent ON delivery_jobs(created_at DESC, id);
CREATE INDEX webhook_events_endpoint ON webhook_events(endpoint_id);

CREATE TABLE delivery_attempts (
    id UUID PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES delivery_jobs(id),
    attempt_number INTEGER NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP WITH TIME ZONE,
    http_status INTEGER,
    error TEXT,
    duration_ms BIGINT,
    UNIQUE(job_id, attempt_number)
);
