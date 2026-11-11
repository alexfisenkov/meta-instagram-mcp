import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import { StudentVault } from "../src/student/vault.js";
import { StudentBroker } from "../src/student/broker.js";
import { StudentRegistry } from "../src/student/registry.js";
import { MetaStudentProvider } from "../src/student/meta-provider.js";
import { startStudentServer } from "../src/student/http.js";
import { PublishingStore } from "../src/student/publishing-store.js";
import { PublishingBroker } from "../src/student/publishing-broker.js";
import { PublishingProviders } from "../src/student/provider-publishing.js";
import { PublishingOAuth } from "../src/student/provider-publishing-oauth.js";
import { PublishingRuntime } from "../src/student/publishing-runtime.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse())
        await c();
});
function signed(subjectKey: Buffer, sub: string) {
    const now = Math.floor(Date.now() / 1000);
    const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"), body = Buffer.from(JSON.stringify({ iss: "masterskaya-platform", aud: "meta-student-broker", tenantId: "masterskaya", sub, iat: now, exp: now + 60 })).toString("base64url");
    return `${head}.${body}.${createHmac("sha256", subjectKey).update(`${head}.${body}`).digest("base64url")}`;
}
it("composes new subject-bound MCP with legacy catalog while default capability remains unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "publishing-http-")), vault = await StudentVault.open(directory, Buffer.alloc(32, 1));
    cleanups.push(() => rm(directory, { recursive: true, force: true }), () => vault.close());
    const registry = new StudentRegistry([]), broker = new StudentBroker(vault, registry, new MetaStudentProvider(), "https://platform.example.test"), auth = { serviceToken: "synthetic-service-credential-32-chars", subjectKey: Buffer.alloc(32, 3) }, store = new PublishingStore(vault), oauth = new PublishingOAuth(store, []), publisher = new PublishingBroker(store, async () => {
        throw new Error("not configured");
    }, new PublishingProviders(), { origin: "https://media.example.test", pathPrefix: "/media/", maxBytes: 1024 }, directory), publishing = new PublishingRuntime(publisher, oauth, vault, registry);
    let server = await startStudentServer({ broker, registry, vault, auth, port: 0, publishing });
    cleanups.push(() => server.close());
    const call = async (name: string, args: unknown = {}, sub = "synthetic-a") => {
        const response = await fetch(`${server.url}/student/mcp`, { method: "POST", headers: { Authorization: `Bearer ${auth.serviceToken}`, "X-Meta-Subject": signed(auth.subjectKey, sub), "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
        return response.json() as Promise<any>;
    };
    const list = await call("social_connections_catalog");
    expect(JSON.parse(list.result.content[0].text).products).toHaveLength(4);
    expect(list.result.isError).not.toBe(true);
    const legacy = await call("youtube_connections_catalog");
    expect(JSON.parse(legacy.result.content[0].text).products[0]).toMatchObject({ product: "youtube", status: "not_configured" });
    const missing = await call("social_publish_status", { deliveryId: "11111111-1111-4111-8111-111111111111" }, "synthetic-b");
    expect(JSON.parse(missing.result.content[0].text)).toEqual({ error: "delivery_not_found" });
    expect(await (await fetch(`${server.url}/capabilities`)).json()).toEqual({ capabilities: ["youtube_oauth_readonly_v1", "social_publishing_v1"] });
    await server.close();
    server = await startStudentServer({ broker, registry, vault, auth, port: 0 });
    expect(await (await fetch(`${server.url}/capabilities`)).json()).toEqual({ capabilities: ["youtube_oauth_readonly_v1"] });
    const absent = await call("social_connections_catalog");
    expect(absent.result.isError).toBe(true);
});
