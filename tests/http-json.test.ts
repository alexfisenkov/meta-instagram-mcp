import { afterEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("node:https", () => ({ request: requestMock }));

import { requestJsonHttp } from "../src/http-json.js";

describe("JSON HTTP cancellation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    requestMock.mockReset();
  });

  it("destroys an in-flight GET and does not start a fallback route after abort", async () => {
    vi.stubEnv("META_GRAPH_FALLBACK_IPS", "203.0.113.10,203.0.113.11");
    requestMock.mockImplementation(() => {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const request: { on: (event: string, listener: (...args: unknown[]) => void) => unknown; write: () => void; end: () => void; destroy: (error?: Error) => unknown } = {
        on(event, listener) { listeners.set(event, listener); return request; },
        write() {},
        end() {},
        destroy(error) {
          if (error) listeners.get("error")?.(error);
          return request;
        }
      };
      return request;
    });
    const controller = new AbortController();

    const pending = requestJsonHttp(new URL("https://graph.facebook.com/v25.0/me/conversations"), { signal: controller.signal });
    expect(requestMock).toHaveBeenCalledOnce();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requestMock).toHaveBeenCalledOnce();
  });
});
