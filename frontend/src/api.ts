export type DeliveryStatus =
  | "PENDING"
  | "IN_FLIGHT"
  | "RETRY_WAIT"
  | "SUCCEEDED"
  | "EXHAUSTED"
  | "CANCELLED";
export interface Endpoint {
  id: string;
  url: string;
  enabled: boolean;
  createdAt: string;
}
export interface CreatedEndpoint extends Endpoint {
  signingSecret: string;
}
export interface Delivery {
  id: string;
  eventId: string;
  endpointId: string;
  status: DeliveryStatus;
  attemptCount: number;
  cycleAttemptCount: number;
  replayCount: number;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}
export interface Attempt {
  id: string;
  attemptNumber: number;
  startedAt: string;
  finishedAt: string | null;
  httpStatus: number | null;
  error: string | null;
  durationMs: number | null;
}
export interface DeliveryDetail extends Delivery {
  attempts: Attempt[];
}
export interface AcceptedEvent {
  id: string;
  deliveryId: string;
}
export type ReceiverMode =
  "success" | "fail" | "flaky" | "timeout" | "commit_then_timeout";
export interface Receipt {
  eventId: string;
  type: string;
  duplicate: boolean;
  receivedAt: string;
  signatureValid: boolean;
}
export interface ReceiverState {
  mode: ReceiverMode;
  failuresRemaining: number;
  delayMs: number;
  signingSecretConfigured: boolean;
  receivedCount: number;
  effectCount: number;
  duplicateCount: number;
  receipts: Receipt[];
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function request<T>(
  path: string,
  apiKey: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("X-API-Key", apiKey);
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...options,
    headers,
    cache: "no-store",
  });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = (await response.json()) as {
        detail?: string;
        message?: string;
      };
      message = body.detail || body.message || message;
    } catch {
      /* Reverse proxies may return HTML instead of JSON. */
    }
    if (response.status === 401)
      message =
        "The API key was not accepted. Check the configured key and reconnect.";
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function parsePayload(value: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new Error(
      "Payload must be valid JSON. Check commas and quotation marks.",
    );
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new Error(
      'Payload must be a JSON object, such as { "orderId": "order_1042" }.',
    );
  }
  return payload as Record<string, unknown>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
export function readableStatus(status: string): string {
  return status.toLowerCase().replaceAll("_", " ");
}
