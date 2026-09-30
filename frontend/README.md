# Relay dashboard

React and TypeScript console for endpoint registration, event submission, delivery inspection, replay, and the demo receiver. It uses the same API contract as external producers; business rules and authentication remain in the backend.

## Run locally

Use Node.js 22.12 or later (the Docker build pins Node 24). Start the backend on port 8080 and demo receiver on 8081, then run from this directory:

```shell
npm ci
npm run dev
```

Open `http://localhost:5173` and enter the configured API key. Vite proxies `/api` to the backend and `/receiver-api` to the receiver, so the browser makes same-origin requests. No key is embedded in the bundle or supplied through Vite environment variables.

For the complete stack, follow the root README and run Docker Compose from the repository root. The production image serves the compiled assets through nginx and uses the Compose service names `backend:8080` and `receiver:8081` for its proxies.

## Walk through the console

1. **Endpoints:** register a destination. In Compose, the demo destination is `http://receiver:8081/webhook`; when the backend runs on the host, use `http://localhost:8081/webhook`. The backend must explicitly allow the local demo destination.
2. Save the signing secret shown immediately after registration. It is held only in the component's memory and disappears when dismissed or when leaving the page. List responses do not include it.
3. **Receiver lab:** paste that secret, choose Success, and apply the configuration. Blank secret updates keep the receiver's existing secret.
4. **Send an event:** select the endpoint and submit a JSON object with an event ID. The ID stays unchanged after submission so that repeating identical content demonstrates submission deduplication. Generate a new ID for a new event.
5. **Deliveries:** inspect live status and individual attempts. The table and summary counts cover the latest 100 deliveries; its search and status filter apply to that window.
6. **Receiver lab:** try flaky failures, timeouts, or processing followed by a delayed response. The last scenario demonstrates duplicate HTTP delivery with one business effect per event ID. Set the delay above the backend's request timeout. Switch to Success to allow a retry to complete, or replay once the job is exhausted.

Resetting the demo receiver clears its counters, receipt history, and deduplication state; its behavior and secret remain configured. Its in-memory state is for demonstrations, not durable application processing.

## Structure

- `src/App.tsx`: navigation, forms, polling, live tables, and attempt inspector.
- `src/api.ts`: typed API models, authenticated requests, error handling, and JSON payload validation.
- `src/api.test.ts`: payload boundaries, authentication headers, cancellation forwarding, and API error behavior.
- `src/styles.css`: responsive light and dark themes with keyboard focus styles.
- `vite.config.ts`: development proxies.
- `nginx.conf`: production proxies and browser security headers.

The API key is stored in `sessionStorage` for this tab and cleared by Disconnect. All protected requests send it in `X-API-Key`. The theme preference is stored separately in `localStorage`. Polling is sequential, repeats 2.5 seconds after each request settles, and aborts in-flight reads when the page or credentials change. Mutations disable their submit buttons while running. The dashboard renders server-provided content as text.

## Verify

```shell
npm run build
npm test
npm run format:check
```

The build checks TypeScript before bundling. Tests cover meaningful client-side validation and request behavior; the backend's integration tests exercise delivery correctness and persistence.
