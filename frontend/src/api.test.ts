import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, parsePayload, request } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("event payload validation", () => {
  it("preserves nested values and accepts empty objects", () => {
    expect(parsePayload('{"items":[{"id":3}],"active":true}')).toEqual({
      items: [{ id: 3 }],
      active: true,
    });
    expect(parsePayload("{}")).toEqual({});
  });
  it.each(["null", "[]", "42", "true", '"hello"'])(
    "rejects non-object JSON: %s",
    (input) => {
      expect(() => parsePayload(input)).toThrow("JSON object");
    },
  );
  it("explains malformed JSON without submitting it", () =>
    expect(() => parsePayload("{bad}")).toThrow("valid JSON"));
});

describe("authenticated API requests", () => {
  it("sends the key in a header, forwards cancellation, and marks JSON bodies", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"id":"event-1"}', { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    expect(
      await request("/api/events", "test-key", {
        method: "POST",
        body: "{}",
        signal,
      }),
    ).toEqual({ id: "event-1" });
    const [path, options] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/events");
    expect(options.headers.get("X-API-Key")).toBe("test-key");
    expect(options.headers.get("Content-Type")).toBe("application/json");
    expect(options.signal).toBe(signal);
    expect(options.cache).toBe("no-store");
  });
  it("preserves conflict details for an event ID collision", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"detail":"Event ID already has different content"}', {
          status: 409,
        }),
      ),
    );
    await expect(request("/api/events", "test-key")).rejects.toMatchObject({
      status: 409,
      message: "Event ID already has different content",
    });
  });
  it("handles non-JSON upstream failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>Bad gateway</html>", { status: 502 }),
        ),
    );
    await expect(request("/api/deliveries", "test-key")).rejects.toBeInstanceOf(
      ApiError,
    );
  });
  it("accepts empty successful disable responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    await expect(
      request("/api/endpoints/id/disable", "test-key", { method: "POST" }),
    ).resolves.toBeUndefined();
  });
});
