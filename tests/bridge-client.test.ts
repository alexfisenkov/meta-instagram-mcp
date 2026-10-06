import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboundBridgeClient } from "../src/bridge-client.js";

const base = {
  baseUrl: "https://hub.example.test",
  bearerToken: "b".repeat(40),
  mode: "phone_standalone" as const,
  source: "phone" as const,
  accountBinding: "acct:test",
  capabilities: ["inbox.list"],
  credentialsPath: "/tmp/bridge-config.json",
  bridgeId: "bridge-1",
  bridgeToken: "c".repeat(40)
};

describe("OutboundBridgeClient", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("requires HTTPS except explicit loopback test mode", () => {
    expect(() => new OutboundBridgeClient({ ...base, baseUrl: "http://hub.example.test" })).toThrow(/HTTPS/);
    expect(() => new OutboundBridgeClient({ ...base, baseUrl: "http://127.0.0.1", allowLoopbackHttpForTests: true })).not.toThrow();
    expect(() => new OutboundBridgeClient({ ...base, baseUrl: "http://192.168.1.4", allowLoopbackHttpForTests: true })).toThrow(/HTTPS/);
  });

  it("sends source and protocol provenance without retrying a failed write", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new OutboundBridgeClient({ ...base, fetchImpl });
    await client.heartbeat("bridge-1");
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/bridge/heartbeat");
    expect(new Headers(init.headers).get("x-api-protocol-version")).toBe("1");
    expect(new Headers(init.headers).get("x-bridge-source")).toBe("phone");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${base.bearerToken}`);
    expect(init.redirect).toBe("error");
  });

  it("registers only live capability subsets and pins the approval key returned over HTTPS", async () => {
    const root = await mkdtemp(join(tmpdir(), "instagram-bridge-client-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ ...base, credentialsPath: undefined }), { mode: 0o600 });
    const publicKey = "-----BEGIN PUBLIC KEY-----\nfixture-key\n-----END PUBLIC KEY-----";
    let registration: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      registration = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ bridgeId: "bridge-1", bridgeToken: "c".repeat(40), approvalPublicKey: publicKey }), { status: 201 });
    });
    const client = new OutboundBridgeClient({ ...base, credentialsPath: configPath, fetchImpl });

    await client.register(["inbox.list"]);

    expect(registration?.capabilities).toEqual(["inbox.list"]);
    expect(client.approvalPublicKey).toBe(publicKey);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      bridgeId: "bridge-1", trustedApprovalPublicKey: publicKey
    });
    await expect(client.register(["shell.exec"])).rejects.toThrow(/subset/);
  });

  it("refuses a cross-origin 307 before the redirect destination receives bridge credentials", async () => {
    let sinkRequests = 0;
    const sinkBodies: string[] = [];
    const sink = createServer((request, response) => {
      sinkRequests += 1;
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => { sinkBodies.push(Buffer.concat(chunks).toString("utf8")); response.end("captured"); });
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const sinkPort = (sink.address() as { port: number }).port;
    const redirect = createServer((_request, response) => {
      response.writeHead(307, { location: `http://127.0.0.1:${sinkPort}/capture` });
      response.end();
    });
    await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
    const redirectPort = (redirect.address() as { port: number }).port;
    try {
      const client = new OutboundBridgeClient({
        ...base, baseUrl: `http://127.0.0.1:${redirectPort}`, allowLoopbackHttpForTests: true
      });
      await expect(client.heartbeat("bridge-1")).rejects.toThrow();
      expect(sinkRequests).toBe(0);
      expect(sinkBodies.join("\n")).not.toContain(base.bridgeToken);
    } finally {
      await Promise.all([redirect, sink].map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
    }
  });
});
