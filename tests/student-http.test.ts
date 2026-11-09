import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startStudentServer } from "../src/student/http.js";
import { StudentBroker } from "../src/student/broker.js";
import { StudentRegistry } from "../src/student/registry.js";
import { StudentVault } from "../src/student/vault.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it("serves only the restricted MCP catalog over the real SDK and rejects subject/token overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "student-http-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const vault = await StudentVault.open(dir, randomBytes(32)); cleanup.push(() => vault.close());
  const registry = new StudentRegistry([]);
  const broker = new StudentBroker(vault, registry, { exchange: async () => { throw new Error(); }, read: async () => { throw new Error(); } }, "https://platform.example");
  const key = randomBytes(32), serviceToken = "s".repeat(40), now = Math.floor(Date.now() / 1000);
  const head = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"), body = Buffer.from(JSON.stringify({ iss: "masterskaya-platform", aud: "meta-student-broker", tenantId: "masterskaya", sub: "student-a", iat: now, exp: now + 60 })).toString("base64url");
  const token = `${head}.${body}.${createHmac("sha256", key).update(`${head}.${body}`).digest("base64url")}`;
  const server = await startStudentServer({ broker, vault, registry, auth: { serviceToken, subjectKey: key }, port: 0 }); cleanup.push(() => server.close());
  const direct = await fetch(`${server.url}/student/mcp`, { method: "POST", headers: { Authorization: `Bearer ${serviceToken}`, "X-Meta-Subject": token, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "meta_connections_list", arguments: {} } }) });
  expect(direct.status).toBe(200); const directBody = await direct.json() as { result: { content: Array<{ text: string }> } }; expect(directBody.result.content[0].text).toBe('{"connections":[]}');
  const client = new Client({ name: "test", version: "1" }); cleanup.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/student/mcp`), { requestInit: { headers: { Authorization: `Bearer ${serviceToken}`, "X-Meta-Subject": token } } }));
  expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["meta_connections_begin", "meta_connections_catalog", "meta_connections_disconnect", "meta_connections_list", "meta_connections_read"]);
  const catalog = await client.callTool({ name: "meta_connections_catalog", arguments: {} }); expect(JSON.stringify(catalog)).toContain("not_configured");
  const forged = await client.callTool({ name: "meta_connections_catalog", arguments: { subject: "other", accessToken: "owner-token" } }); expect(forged.isError).toBe(true);
  expect((await fetch(`${server.url}/student/mcp`, { method: "POST", headers: { Authorization: `Bearer ${serviceToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status).toBe(401);
  expect((await fetch(`${server.url}/mcp`, { method: "POST" })).status).toBe(404);
  expect((await fetch(`${server.url}/privacy`)).status).toBe(503);
});
it("serves escaped Russian legal pages with secure headers only when operator/contact are configured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "student-legal-")); cleanup.push(() => rm(dir, { recursive: true, force: true })); const vault = await StudentVault.open(dir, randomBytes(32)); cleanup.push(() => vault.close());
  const registry = new StudentRegistry([]), broker = new StudentBroker(vault, registry, { exchange: async () => { throw new Error(); }, read: async () => { throw new Error(); } }, "https://platform.example");
  const server = await startStudentServer({ broker, vault, registry, auth: { serviceToken: "s".repeat(40), subjectKey: randomBytes(32) }, port: 0, legal: { operatorName: '<script>alert("x")</script>', privacyContact: "privacy@example.com" } }); cleanup.push(() => server.close());
  for (const route of ["/privacy", "/data-deletion"]) {
    const response = await fetch(`${server.url}${route}`), html = await response.text(); expect(response.status).toBe(200); expect(response.headers.get("content-security-policy")).toContain("default-src 'none'"); expect(response.headers.get("x-content-type-options")).toBe("nosniff"); expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>"); expect(html).toContain('href="mailto:privacy@example.com"'); expect(html).not.toContain("<form");
  }
  expect((await fetch(`${server.url}/data-deletion`, { method: "POST", body: "private" })).status).toBe(405);
});
