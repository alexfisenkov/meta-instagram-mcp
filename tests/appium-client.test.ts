import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createAppiumClient } from "../src/providers/appium-client.js";

describe("AppiumClient readiness", () => {
  it("requires a ready Appium server and selected-device WDA before creating a session", async () => {
    const requests: string[] = [];
    const appium = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ value: { ready: true } }));
    });
    const wda = createServer((request, response) => {
      requests.push(`wda ${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ value: { ready: true } }));
    });
    await Promise.all([
      new Promise<void>((resolve) => appium.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => wda.listen(0, "127.0.0.1", resolve))
    ]);
    const appiumPort = (appium.address() as { port: number }).port;
    const wdaPort = (wda.address() as { port: number }).port;
    const client = createAppiumClient({
      serverUrl: `http://127.0.0.1:${appiumPort}`,
      platform: "iOS",
      selectedDevice: { id: "fixture-device", name: "Fixture iPhone" },
      wdaStatusUrl: `http://127.0.0.1:${wdaPort}/status`
    });
    try {
      await expect(client.readiness()).resolves.toMatchObject({ availability: "not_connected", transportReady: true, selectedDeviceIdentity: "unverified" });
      expect(requests).toEqual(["GET /status", "wda GET /status"]);
    } finally {
      await Promise.all([appium, wda].map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
    }
  });

  it("does not create a session when the selected device endpoint is not connected", async () => {
    const requests: string[] = [];
    const appium = createServer((request, response) => {
      requests.push(`appium ${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ value: { ready: true } }));
    });
    const wda = createServer((request, response) => {
      requests.push(`wda ${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.statusCode = 503;
      response.end(JSON.stringify({ value: { ready: false } }));
    });
    await Promise.all([
      new Promise<void>((resolve) => appium.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => wda.listen(0, "127.0.0.1", resolve))
    ]);
    const config = (appiumPort: number, wdaPort: number) => ({
      serverUrl: `http://127.0.0.1:${appiumPort}`, platform: "iOS" as const,
      selectedDevice: { id: "fixture-device" }, wdaStatusUrl: `http://127.0.0.1:${wdaPort}/status`
    });
    const appiumPort = (appium.address() as { port: number }).port;
    const wdaPort = (wda.address() as { port: number }).port;
    const client = createAppiumClient(config(appiumPort, wdaPort));
    try {
      await expect(client.readiness()).resolves.toMatchObject({ availability: "not_connected" });
      await expect(client.createSession()).rejects.toThrow(/not_connected/);
      expect(requests.filter((request) => request.includes("POST"))).toEqual([]);
    } finally {
      await Promise.all([appium, wda].map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
    }
  });

  it("creates one W3C session only after both readiness probes and pins its platform/device", async () => {
    const requests: Array<{ method: string; path: string; body: string }> = [];
    const appium = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({ method: request.method ?? "", path: request.url ?? "", body });
        response.setHeader("content-type", "application/json");
        response.end(new URL(request.url ?? "/", "http://127.0.0.1").pathname.endsWith("/status")
          ? JSON.stringify({ value: { ready: true } })
          : JSON.stringify({ value: { sessionId: "session-1", capabilities: { platformName: "iOS", udid: "fixture-device" } } }));
      });
    });
    const wda = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ value: { ready: true } })); });
    await Promise.all([
      new Promise<void>((resolve) => appium.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => wda.listen(0, "127.0.0.1", resolve))
    ]);
    const appiumPort = (appium.address() as { port: number }).port;
    const wdaPort = (wda.address() as { port: number }).port;
    const client = createAppiumClient({
      serverUrl: `http://127.0.0.1:${appiumPort}/wd/hub`, platform: "iOS",
      selectedDevice: { id: "fixture-device" }, wdaStatusUrl: `http://127.0.0.1:${wdaPort}/status`
    });
    try {
      const session = await client.createSession();
      expect(session.sessionId).toBe("session-1");
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        "GET /wd/hub/status", "POST /wd/hub/session"
      ]);
      const capabilities = JSON.parse(requests[1]!.body).capabilities.alwaysMatch;
      expect(capabilities).toMatchObject({
        platformName: "iOS", "appium:automationName": "XCUITest", "appium:udid": "fixture-device",
        "appium:bundleId": "com.burbn.instagram", "appium:noReset": true, "appium:autoAcceptAlerts": false
      });
      await expect(client.readiness()).resolves.toMatchObject({ availability: "ready", transportReady: true, selectedDeviceIdentity: "verified" });
    } finally {
      await client.close();
      await Promise.all([appium, wda].map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
    }
  });

  it.each([
    ["missing", {}],
    ["mismatched", { udid: "other-device" }]
  ])("fails closed when the pinned W3C session reports %s device identity", async (_case, capabilities) => {
    const paths: string[] = [];
    const appium = createServer((request, response) => {
      paths.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.end(request.url?.endsWith("/status")
        ? JSON.stringify({ value: { ready: true } })
        : request.method === "DELETE" ? "{}" : JSON.stringify({ value: { sessionId: "session-1", capabilities } }));
    });
    const wda = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ value: { ready: true } })); });
    await Promise.all([
      new Promise<void>((resolve) => appium.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => wda.listen(0, "127.0.0.1", resolve))
    ]);
    const appiumPort = (appium.address() as { port: number }).port;
    const wdaPort = (wda.address() as { port: number }).port;
    const client = createAppiumClient({
      serverUrl: `http://127.0.0.1:${appiumPort}`, platform: "iOS", selectedDevice: { id: "fixture-device" },
      wdaStatusUrl: `http://127.0.0.1:${wdaPort}/status`
    });
    try {
      await expect(client.createSession()).rejects.toThrow(/did not prove the selected device identity/);
      expect(paths).toContain("DELETE /session/session-1/");
      expect(await client.readiness()).toMatchObject({ availability: "not_connected", selectedDeviceIdentity: "unverified" });
    } finally {
      await client.close();
      await Promise.all([appium, wda].map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
    }
  });

  it("does not follow a session redirect to another local endpoint", async () => {
    let redirectedRequests = 0;
    const destination = createServer((_request, response) => { redirectedRequests++; response.end("{}"); });
    const appium = createServer((request, response) => {
      if (request.url?.endsWith("/status")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ value: { ready: true } }));
        return;
      }
      response.statusCode = 302;
      response.setHeader("location", `http://127.0.0.1:${(destination.address() as { port: number }).port}/session`);
      response.end();
    });
    const wda = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ value: { ready: true } })); });
    await Promise.all([
      new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => appium.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => wda.listen(0, "127.0.0.1", resolve))
    ]);
    const appiumPort = (appium.address() as { port: number }).port;
    const wdaPort = (wda.address() as { port: number }).port;
    const client = createAppiumClient({
      serverUrl: `http://127.0.0.1:${appiumPort}`, platform: "iOS", selectedDevice: { id: "fixture-device" },
      wdaStatusUrl: `http://127.0.0.1:${wdaPort}/status`
    });
    try {
      await expect(client.createSession()).rejects.toThrow(/outcome is unknown/);
      expect(redirectedRequests).toBe(0);
    } finally {
      await client.close();
      await Promise.all([destination, appium, wda].map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
    }
  });

  it("requires explicit device selection and rejects non-loopback Appium endpoints", async () => {
    const client = createAppiumClient({ serverUrl: "http://127.0.0.1:4723", platform: "iOS" });
    await expect(client.readiness()).resolves.toMatchObject({ availability: "needs_selection", capabilities: [] });
    expect(() => createAppiumClient({
      serverUrl: "http://192.168.1.20:4723", platform: "iOS", selectedDevice: { id: "private-device" },
      wdaStatusUrl: "http://127.0.0.1:8100/status"
    })).toThrow(/loopback/);
  });
});

describe("AppiumClient response bounds", () => {
  it("stops reading chunked responses at the byte limit and never returns response contents", async () => {
    let pulls = 0;
    let cancelled = false;
    const secretBody = "PRIVATE_RESPONSE_BODY";
    const fetchImpl: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode(`${secretBody}${"x".repeat(600)}`));
        if (pulls === 3) controller.close();
      },
      cancel() { cancelled = true; }
    }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
    const client = createAppiumClient({
      serverUrl: "http://127.0.0.1:4723", platform: "iOS", selectedDevice: { id: "fixture-device" },
      wdaStatusUrl: "http://127.0.0.1:8100/status", maxResponseBytes: 1_024, fetchImpl
    });
    const status = await client.readiness();
    expect(status).toMatchObject({ availability: "offline" });
    expect(status.reason).not.toContain(secretBody);
    expect(pulls).toBeLessThanOrEqual(2);
    expect(cancelled).toBe(true);
  });

  it("rejects a lying oversized Content-Length before reading the body", async () => {
    let pulls = 0;
    let cancelled = false;
    let signal: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      signal = init?.signal;
      return ({
      ok: true, status: 200, body: new ReadableStream<Uint8Array>({
        pull(controller) { pulls++; controller.enqueue(new Uint8Array(1)); },
        cancel() { cancelled = true; }
      }, { highWaterMark: 0 }),
      headers: { get: (name: string) => name.toLowerCase() === "content-length" ? "999999" : "application/json" }
      } as unknown as Response);
    };
    const client = createAppiumClient({
      serverUrl: "http://127.0.0.1:4723", platform: "iOS", selectedDevice: { id: "fixture-device" },
      wdaStatusUrl: "http://127.0.0.1:8100/status", maxResponseBytes: 1_024, fetchImpl
    });
    await expect(client.readiness()).resolves.toMatchObject({ availability: "offline" });
    expect(pulls).toBe(0);
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
  });
});
