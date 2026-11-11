import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { StudentVault } from "../src/student/vault.js";
import { ConnectionsStore } from "../src/student/connections-store.js";
import { ConnectionsRuntime } from "../src/student/connections-runtime.js";
import { ConnectionsProviders } from "../src/student/connections-providers.js";
import { ConnectionsHttp, connectionProviderUrl } from "../src/student/connections-http.js";
import { baseConnectionScopes, loadConnectionsConfig } from "../src/student/connections-config.js";
import type { ConnectionConfig, ConnectionProduct } from "../src/student/connections-types.js";
const subject = { tenantId: "test-school", sub: "fictitious-a" }, other = { tenantId: "test-school", sub: "fictitious-b" }, otherTenant = { ...subject, tenantId: "other-school" };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup(product: ConnectionProduct, options: { billingApproved?: boolean; linkedinScopes?: string[]; refresh?: boolean; partial?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "connections-test-")), vault = await StudentVault.open(directory, Buffer.alloc(32, 7));
  cleanup.push(() => rm(directory, { recursive: true, force: true }), () => vault.close());
  const state = { actor: "123", wrongClient: false, wrongUser: false, wrongPost: false, deniedLinkedinMe: false, invalidRefresh: false, errorStatus: 0, missingLocation: false, tokenCalls: 0, metricsStatus: 0, metrics: {} as Record<string, unknown>, scopes: options.partial ? ["openid", "profile"] : [...baseConnectionScopes[product], ...(options.linkedinScopes ?? [])] };
  const calls: { url: string; init?: RequestInit }[] = [];
  const config: ConnectionConfig = { product, clientId: "synthetic-client", clientSecret: "synthetic-not-a-real-secret", callbackUrl: `https://broker.example.test/social/accounts/oauth/${product}/callback`, admission: "test", testSubjects: [subject.sub], scopes: [...baseConnectionScopes[product], ...(options.linkedinScopes ?? [])], apiVersion: product === "linkedin" && options.linkedinScopes?.length ? "202610" : undefined, billingApproved: options.billingApproved ?? product !== "x" };
  const http = new ConnectionsHttp(async (input, init) => {
    const url = String(input), u = new URL(url); calls.push({ url, init });
    if (state.errorStatus) return Response.json({ private_upstream: "never-exposed" }, { status: state.errorStatus });
    if (u.pathname.endsWith("/token") || u.pathname.endsWith("/accessToken")) { if (state.invalidRefresh) return Response.json({ error: "invalid_grant", error_description: "never-exposed" }, { status: 400 }); state.tokenCalls++; return Response.json({ access_token: `synthetic-access-${state.tokenCalls}`, ...(options.refresh === false ? {} : { refresh_token: `synthetic-refresh-${state.tokenCalls}` }), ...(product === "linkedin" ? {} : { token_type: "bearer" }), expires_in: 3600, scope: product === "twitch" ? [] : state.scopes.join(" ") }); }
    if (u.pathname.endsWith("/validate")) return Response.json({ client_id: state.wrongClient ? "wrong-app" : config.clientId, user_id: state.actor, scopes: [], expires_in: 3500 });
    if (u.pathname === "/helix/users") return Response.json({ data: [{ id: state.wrongUser ? "999" : state.actor, display_name: "Fictitious Twitch", login: "fictitious", secret_extra: "never-exposed" }] });
    if (u.pathname === "/helix/videos") return Response.json({ data: [{ id: "777", user_id: state.wrongPost ? "999" : state.actor, title: "Fictitious video", view_count: 9, private_extra: "never-exposed" }], pagination: {} });
    if (u.pathname.endsWith("/userinfo")) return Response.json({ sub: product === "linkedin" ? `oidc-${state.actor}` : state.actor, name: "Fictitious profile", email: "should-not-return@example.test", private_extra: "never-exposed" });
    if (u.pathname === "/v2/me") return state.deniedLinkedinMe ? Response.json({ error: "forbidden" }, { status: 403 }) : Response.json({ id: `person-${state.actor}` });
    if (u.pathname === "/rest/organizationAcls") return Response.json({ elements: [{ organization: "urn:li:organization:42", roleAssignee: `urn:li:person:person-${state.actor}`, role: "ADMINISTRATOR", state: "APPROVED" }, { organization: "urn:li:organization:43", roleAssignee: "urn:li:person:someone-else", role: "ADMINISTRATOR", state: "APPROVED" }, { organization: "urn:li:organization:44", roleAssignee: `urn:li:person:person-${state.actor}`, role: "ADMINISTRATOR", state: "REVOKED" }] });
    if (u.pathname === "/rest/organizations/42") return Response.json({ id: 42, localizedName: "Fictitious organization" });
    if (u.pathname === "/rest/posts") return Response.json({ elements: [{ id: "urn:li:share:888", author: state.wrongPost ? "urn:li:organization:999" : u.searchParams.get("author"), commentary: "Fictitious post", lifecycleState: "PUBLISHED", createdAt: 1700000000000, private_extra: "never-exposed" }] });
    if (u.hostname === "businessprofileperformance.googleapis.com") return state.metricsStatus ? Response.json({ error: "provider-gate" }, { status: state.metricsStatus }) : Response.json(state.metrics);
    if (u.pathname === "/v1/accounts") return Response.json({ accounts: [{ name: "accounts/10", accountName: "Fictitious parent" }] });
    if (u.pathname === "/v1/accounts/10/locations") return Response.json({ locations: state.missingLocation ? [] : [{ name: "locations/20", title: "Fictitious location" }, { name: "locations/21", title: "Second fictitious location" }] });
    if (u.pathname === "/v1/locations/20" || u.pathname === "/v1/locations/21") return Response.json({ name: u.pathname.slice(4), title: "Fictitious location", websiteUri: "https://example.test", private_extra: "never-exposed" });
    if (u.pathname.endsWith("/localPosts")) return Response.json({ localPosts: [{ name: state.wrongPost ? "accounts/99/locations/20/localPosts/post1" : "accounts/10/locations/20/localPosts/post1", summary: "Fictitious local post", state: "LIVE", private_extra: "never-exposed" }] });
    if (u.pathname === "/2/users/me") return Response.json({ data: { id: state.actor, name: "Fictitious X", username: "fictitious", public_metrics: { followers_count: 4, post_count: 8 }, private_extra: "never-exposed" } });
    if (u.pathname.endsWith("/tweets")) return Response.json({ data: [{ id: "555", author_id: state.wrongPost ? "999" : state.actor, text: "Fictitious tweet", private_extra: "never-exposed" }], meta: {} });
    throw new Error(`unhandled synthetic endpoint: ${u.hostname}${u.pathname}`);
  });
  const store = new ConnectionsStore(vault), runtime = new ConnectionsRuntime(store, [config], new ConnectionsProviders(http), "https://platform.example.test");
  cleanup.push(() => runtime.stop());
  return { directory, vault, store, runtime, state, calls, config };
}
async function connect(x: Awaited<ReturnType<typeof setup>>, connectionId?: string) {
  const start = await x.runtime.begin(subject, x.config.product, connectionId), state = new URL(start.authorizationUrl).searchParams.get("state")!;
  const redirect = new URL(await x.runtime.callback(x.config.product, { state, code: "synthetic-code" }));
  return { start, state, redirect };
}
describe("separate read connections", () => {
  it.each(["twitch", "linkedin", "google_business_profile", "x"] as const)("binds %s consent to one subject, stores encrypted, rejects replay and foreign access", async product => {
    const x = await setup(product, { billingApproved: true }), done = await connect(x);
    expect(done.redirect.searchParams.get("social")).toBe("connected");
    const rows = (await x.runtime.list(subject)).connections;
    expect(rows.length).toBeGreaterThan(0); expect(rows.every(r => !r.capabilities.includes("publish" as any))).toBe(true);
    expect(await x.runtime.list(other)).toEqual({ connections: [] }); expect(await x.runtime.list(otherTenant)).toEqual({ connections: [] });
    for (const alien of [other, otherTenant]) {
      await expect(x.runtime.read(alien, { connectionId: rows[0].id, operation: "account" })).rejects.toThrow("connection_not_found");
      await expect(x.runtime.refresh(alien, rows[0].id)).rejects.toThrow("connection_not_found");
      await expect(x.runtime.disconnect(alien, rows[0].id)).rejects.toThrow("connection_not_found");
      await expect(x.runtime.begin(alien, product, rows[0].id)).rejects.toThrow();
    }
    const before = x.calls.length;
    expect(new URL(await x.runtime.callback(product, { state: done.state, code: "replay" })).searchParams.get("reason")).toBe("state_rejected");
    expect(x.calls).toHaveLength(before);
    expect(await readFile(join(x.directory, "vault.json"), "utf8")).not.toContain("synthetic-access");
    expect(JSON.stringify(await x.runtime.list(subject))).not.toContain("synthetic-access");
  });
  it("blocks every X OAuth/API request while billing is unverified", async () => {
    const x = await setup("x"); expect(x.runtime.catalog(subject).products.find(p => p.product === "x")?.status).toBe("billing_unverified");
    await expect(x.runtime.begin(subject, "x")).rejects.toThrow("billing_unverified"); expect(x.calls).toEqual([]);
  });
  it("uses S256 PKCE only for the documented Google and X flows", async () => {
    for (const product of ["google_business_profile", "x"] as const) {
      const x = await setup(product, { billingApproved: true }), done = await connect(x), u = new URL(done.start.authorizationUrl);
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      const token = x.calls.find(c => c.init?.method === "POST")!, fields = token.init!.body as URLSearchParams;
      expect(createHash("sha256").update(fields.get("code_verifier")!).digest("base64url")).toBe(u.searchParams.get("code_challenge"));
      expect(fields.get("redirect_uri")).toBe(`https://broker.example.test/social/accounts/oauth/${product}/callback`);
    }
  });
  it("rejects wrong issuer, wrong callback product and expired state before exchanging", async () => {
    const x = await setup("twitch");
    for (const failure of ["issuer", "product", "expiry"] as const) {
      const pending = await x.runtime.begin(subject, "twitch"), state = new URL(pending.authorizationUrl).searchParams.get("state")!;
      if (failure === "expiry") await x.store.transaction(d => { d.states[0].expiresAt = 0; });
      const response = new URL(await x.runtime.callback(failure === "product" ? "linkedin" : "twitch", { state, code: "synthetic-code", ...(failure === "issuer" ? { issuer: "https://evil.example.test" } : {}) }));
      expect(response.searchParams.get("social")).toBe("error");
    }
    expect(x.calls).toEqual([]);
  });
  it("validates Twitch client, user, and scopes; an empty-scope user grant is valid", async () => {
    const x = await setup("twitch"); x.state.wrongClient = true;
    expect((await connect(x)).redirect.searchParams.get("reason")).toBe("grant_verification_failed");
    x.state.wrongClient = false; x.state.wrongUser = true;
    expect((await connect(x)).redirect.searchParams.get("reason")).toBe("grant_verification_failed");
    x.state.wrongUser = false; await connect(x);
    expect((await x.store.snapshot()).grants[0].scopes).toEqual([]);
    expect((await x.runtime.list(subject)).connections[0].capabilities).toEqual(["account", "posts", "metrics"]);
  });
  it("supports LinkedIn OIDC-only profile without assuming Person URN or requiring refresh", async () => {
    const x = await setup("linkedin", { refresh: false }); await connect(x);
    const row = (await x.runtime.list(subject)).connections[0];
    expect(row.account).toEqual({ id: "oidc-123", label: "Fictitious profile", kind: "account" }); expect(row.capabilities).toEqual(["account"]);
    const read = await x.runtime.read(subject, { connectionId: row.id, operation: "account" });
    expect(read.account).toEqual({ id: "oidc-123", label: "Fictitious profile", givenName: undefined, familyName: undefined });
    expect(x.calls.some(c => c.url.endsWith("/v2/me"))).toBe(false);
    await expect(x.runtime.read(subject, { connectionId: row.id, operation: "posts" })).rejects.toThrow("operation_unavailable");
    await x.store.transaction(d => { d.grants[0].expiresAt = 0; });
    expect((await x.runtime.list(subject)).connections[0].status).toBe("reauth_required");
    await expect(x.runtime.refresh(subject, row.id)).rejects.toThrow("reauth_required");
  });
  it("discovers only authoritative LinkedIn person and approved matching administrator ACLs", async () => {
    const x = await setup("linkedin", { linkedinScopes: ["r_liteprofile", "r_member_social", "r_organization_admin", "r_organization_social"] }); await connect(x);
    const rows = (await x.runtime.list(subject)).connections;
    expect(rows.map(r => r.account.id)).toEqual(["oidc-123", "urn:li:person:person-123", "urn:li:organization:42"]);
    const org = rows[2]; expect(org.capabilities).toEqual(["account", "posts"]);
    const data = await x.runtime.read(subject, { connectionId: org.id, operation: "posts" });
    expect(data.items).toEqual([{ id: "urn:li:share:888", text: "Fictitious post", createdAt: 1700000000000, state: "PUBLISHED" }]);
    const call = x.calls.find(c => c.url.includes("/rest/posts?"))!;
    expect((call.init!.headers as Record<string, string>)["LinkedIn-Version"]).toBe("202610");
    x.state.wrongPost = true; await expect(x.runtime.read(subject, { connectionId: org.id, operation: "posts" })).rejects.toThrow("resource_not_owned");
  });
  it("does not invalidate an unexpired LinkedIn grant when refresh is unavailable", async () => {
    const x = await setup("linkedin", { refresh: false }); await connect(x);
    const row = (await x.runtime.list(subject)).connections[0];
    await expect(x.runtime.refresh(subject, row.id)).rejects.toThrow("refresh_unavailable");
    expect((await x.runtime.list(subject)).connections[0].status).toBe("connected");
    expect((await x.runtime.read(subject, { connectionId: row.id, operation: "account" })).account).toMatchObject({ id: "oidc-123" });
  });
  it("does not reconnect a disconnected GBP sibling when reconnecting one exact location", async () => {
    const x = await setup("google_business_profile"); await connect(x);
    const rows = (await x.runtime.list(subject)).connections;
    await x.runtime.disconnect(subject, rows[1].id);
    expect((await connect(x, rows[0].id)).redirect.searchParams.get("social")).toBe("connected");
    expect((await x.runtime.list(subject)).connections.find(r => r.id === rows[1].id)?.status).toBe("disconnected");
  });
  it("retains LinkedIn OIDC account if a claimed optional native-profile permission is refused", async () => {
    const x = await setup("linkedin", { linkedinScopes: ["r_liteprofile", "r_member_social"] }); x.state.deniedLinkedinMe = true;
    expect((await connect(x)).redirect.searchParams.get("social")).toBe("connected");
    const rows = (await x.runtime.list(subject)).connections;
    expect(rows).toHaveLength(1); expect(rows[0].account.id).toBe("oidc-123"); expect(rows[0].capabilities).toEqual(["account"]);
  });
  it("retains partial LinkedIn profile capabilities without invented organization access", async () => {
    const x = await setup("linkedin", { partial: true, linkedinScopes: ["r_liteprofile", "r_member_social", "r_organization_admin", "r_organization_social"] }); await connect(x);
    expect((await x.runtime.list(subject)).connections.map(c => c.capabilities)).toEqual([["account"]]);
  });
  it("keeps native GBP location and parent IDs and isolates shared-grant disconnect", async () => {
    const x = await setup("google_business_profile"); await connect(x);
    const rows = (await x.runtime.list(subject)).connections;
    expect(rows.map(r => r.account.id)).toEqual(["locations/20", "locations/21"]); expect(rows[0].account.parentId).toBe("accounts/10");
    expect((await x.runtime.read(subject, { connectionId: rows[0].id, operation: "posts" })).items).toEqual([{ id: "accounts/10/locations/20/localPosts/post1", text: "Fictitious local post", createdAt: undefined, state: "LIVE" }]);
    await x.runtime.disconnect(subject, rows[0].id);
    expect((await x.store.snapshot()).grants[0].status).toBe("active");
    expect((await x.runtime.read(subject, { connectionId: rows[1].id, operation: "account" })).account).toMatchObject({ id: "locations/21" });
    await x.runtime.disconnect(subject, rows[1].id); expect((await x.store.snapshot()).grants[0].accessToken).toBe("");
  });
  it.each(["twitch", "google_business_profile", "x"] as const)("rejects foreign %s posts and fixes response projections", async product => {
    const x = await setup(product, { billingApproved: true }); await connect(x); const row = (await x.runtime.list(subject)).connections[0];
    const data = await x.runtime.read(subject, { connectionId: row.id, operation: "posts" });
    expect(JSON.stringify(data)).not.toContain("never-exposed"); expect(JSON.stringify(data)).not.toContain("synthetic-access");
    x.state.wrongPost = true; await expect(x.runtime.read(subject, { connectionId: row.id, operation: "posts" })).rejects.toThrow("resource_not_owned");
  });
  it("rotates refresh token, verifies same actor, and refuses wrong actor on reconnect", async () => {
    const x = await setup("twitch"); await connect(x); const row = (await x.runtime.list(subject)).connections[0];
    await x.store.transaction(d => { d.grants[0].expiresAt = 0; });
    await x.runtime.read(subject, { connectionId: row.id, operation: "account" });
    expect((await x.store.snapshot()).grants[0].refreshToken).toBe("synthetic-refresh-2");
    x.state.actor = "999"; expect((await connect(x, row.id)).redirect.searchParams.get("reason")).toBe("grant_verification_failed");
    await expect(x.runtime.refresh(subject, row.id)).rejects.toThrow("grant_verification_failed");
    expect((await x.runtime.list(subject)).connections[0].status).toBe("reauth_required");
  });
  it("turns an OAuth invalid_grant refresh rejection into reconnect rather than retryable outage", async () => {
    const x = await setup("twitch"); await connect(x); const row = (await x.runtime.list(subject)).connections[0];
    x.state.invalidRefresh = true;
    await expect(x.runtime.refresh(subject, row.id)).rejects.toThrow("reauth_required");
    expect((await x.runtime.list(subject)).connections[0]).toMatchObject({ status: "reauth_required", reason: "reauth_required", nextAction: "reconnect" });
  });
  it("does not resurrect resources after disconnect through a pending callback", async () => {
    const x = await setup("twitch"); await connect(x); const row = (await x.runtime.list(subject)).connections[0];
    const start = await x.runtime.begin(subject, "twitch"), state = new URL(start.authorizationUrl).searchParams.get("state")!;
    await x.runtime.disconnect(subject, row.id);
    expect(new URL(await x.runtime.callback("twitch", { state, code: "synthetic-code" })).searchParams.get("reason")).toBe("oauth_cancelled");
    expect((await x.runtime.list(subject)).connections[0].status).toBe("disconnected");
  });
  it("distinguishes missing metrics from zero and records source/window", async () => {
    const x = await setup("x", { billingApproved: true }); await connect(x); const row = (await x.runtime.list(subject)).connections[0];
    const data = JSON.parse(JSON.stringify(await x.runtime.read(subject, { connectionId: row.id, operation: "metrics" })));
    expect(data.metrics).toEqual({ followers: 4, posts: 8 }); expect(data.window).toBe("current_snapshot"); expect(data.source).toBe("x_api");
  });
  it("reads bounded GBP daily metrics with native IDs, inclusive date range and documented omitted zero", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-11T00:30:00Z"));
    const x = await setup("google_business_profile"); await connect(x); const row = (await x.runtime.list(subject)).connections[0];
    expect(row.capabilities).toContain("metrics");
    x.state.metrics = { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: "WEBSITE_CLICKS", timeSeries: { datedValues: [{ date: { year: 2026, month: 11, day: 4 }, value: "9007199254740993" }, { date: { year: 2026, month: 11, day: 5 } }] } }] }] };
    const data = await x.runtime.read(subject, { connectionId: row.id, operation: "metrics" });
    expect(data.range).toEqual({ startDate: "2026-11-04", endDate: "2026-11-10", inclusive: true, selectionTimezone: "UTC" });
    expect(data.timezone).toBe("provider_unspecified"); expect(data.window).toBe("daily_range");
    expect(data.source).toBe("google_business_profile_performance_v1");
    expect((data.metrics as any).series[0]).toMatchObject({ metric: "WEBSITE_CLICKS", points: [{ date: "2026-11-04", value: "9007199254740993" }, { date: "2026-11-05", value: "0" }] });
    expect((data.metrics as any).coverage).toBe("partial"); expect((data.metrics as any).missingMetrics).toContain("CALL_CLICKS");
    const call = new URL(x.calls.find(c => c.url.includes(":fetchMultiDailyMetricsTimeSeries"))!.url);
    expect(call.pathname).toBe("/v1/locations/20:fetchMultiDailyMetricsTimeSeries"); expect(call.searchParams.getAll("dailyMetrics")).toHaveLength(7);
    expect(call.searchParams.get("dailyRange.startDate.day")).toBe("4"); expect(call.searchParams.get("dailyRange.endDate.day")).toBe("10");
    x.state.metrics = {}; const empty = await x.runtime.read(subject, { connectionId: row.id, operation: "metrics" });
    expect((empty.metrics as any).series).toEqual([]); expect((empty.metrics as any).coverage).toBe("empty"); expect((empty.metrics as any).missingMetrics).toHaveLength(7);
  });
  it("keeps GBP profile reads usable when the separate Performance API refuses metrics", async () => {
    const x = await setup("google_business_profile"); await connect(x); const row = (await x.runtime.list(subject)).connections[0];
    x.state.metricsStatus = 403;
    await expect(x.runtime.read(subject, { connectionId: row.id, operation: "metrics" })).rejects.toThrow("permission_unavailable");
    const limited = (await x.runtime.list(subject)).connections[0];
    expect(limited.status).toBe("connected"); expect(limited.capabilities).toEqual(["account", "posts"]);
    expect((await x.runtime.read(subject, { connectionId: row.id, operation: "account" })).account).toMatchObject({ id: "locations/20" });
    x.state.metricsStatus = 0; await x.runtime.refresh(subject, row.id);
    expect((await x.runtime.list(subject)).connections[0].capabilities).toContain("metrics");
  });
  it("rejects duplicate/out-of-range GBP metric points and unsupported breakdowns without totals", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-11T12:00:00Z"));
    const x = await setup("google_business_profile"); await connect(x); const row = (await x.runtime.list(subject)).connections[0];
    for (const series of [
      { dailyMetric: "WEBSITE_CLICKS", timeSeries: { datedValues: [{ date: { year: 2026, month: 11, day: 4 }, value: "1" }, { date: { year: 2026, month: 11, day: 4 }, value: "2" }] } },
      { dailyMetric: "WEBSITE_CLICKS", timeSeries: { datedValues: [{ date: { year: 2026, month: 11, day: 11 }, value: "1" }] } },
      { dailyMetric: "WEBSITE_CLICKS", dailySubEntityType: { dayOfWeek: "MONDAY" }, timeSeries: { datedValues: [] } },
    ]) {
      x.state.metrics = { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [series] }] };
      await expect(x.runtime.read(subject, { connectionId: row.id, operation: "metrics" })).rejects.toThrow("provider_response_invalid");
    }
  });
  it("maps provider refusal to fixed codes, validates at startup and ends invalid Twitch sessions", async () => {
    const x = await setup("twitch"); await connect(x); const row = (await x.runtime.list(subject)).connections[0];
    x.state.errorStatus = 429; await expect(x.runtime.read(subject, { connectionId: row.id, operation: "account" })).rejects.toThrow("rate_limited");
    expect((await x.runtime.list(subject)).connections[0].status).toBe("connected");
    x.state.errorStatus = 401; await x.runtime.tick(); expect((await x.runtime.list(subject)).connections[0].status).toBe("reauth_required");
    expect(JSON.stringify(await x.runtime.list(subject))).not.toContain("never-exposed");
  });
  it("rejects API mutations at the transport boundary without calling upstream", async () => {
    let calls = 0; const http = new ConnectionsHttp(async () => { calls++; return Response.json({}); });
    await expect(http.json("https://api.linkedin.com/rest/posts", { method: "POST", body: "{}" })).rejects.toThrow("provider_method_rejected");
    await expect(http.json("https://api.twitch.tv/helix/videos", { method: "DELETE" })).rejects.toThrow("provider_method_rejected");
    expect(calls).toBe(0);
  });
  it("uses exact trusted hosts and read paths", () => {
    for (const url of ["http://api.x.com/2/users/me", "https://api.x.com.evil.test/2/users/me", "https://user:pass@api.x.com/2/users/me", "https://api.x.com/2/tweets", "https://api.linkedin.com/rest/adCampaigns", "https://api.twitch.tv/helix/streams/key"]) expect(() => connectionProviderUrl(url)).toThrow("provider_host_rejected");
  });
  it("loads credential reference names only, fixes callback origin, rejects duplicate/invalid configurations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "connections-config-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "config.json"), row = { product: "twitch", clientIdEnv: "TEST_CLIENT", clientSecretEnv: "TEST_SECRET", admission: "disabled", testSubjects: [] };
    await writeFile(file, JSON.stringify({ version: 1, products: [row] }));
    const configs = await loadConnectionsConfig(file, { TEST_CLIENT: "synthetic-client", TEST_SECRET: "synthetic-private" }, "https://broker.example.test/base/path");
    expect(configs[0].callbackUrl).toBe("https://broker.example.test/social/accounts/oauth/twitch/callback");
    await writeFile(file, JSON.stringify({ version: 1, products: [row, row] })); await expect(loadConnectionsConfig(file, {}, "https://broker.example.test")).rejects.toThrow("invalid_provider_config");
  });
});

it("offline subject purge removes the separate read vault without disturbing another subject or legacy records", async () => {
  const { purgeStudentSubject } = await import("../src/student/purge-subject.js");
  const directory = await mkdtemp(join(tmpdir(), "connections-purge-")); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const key = Buffer.alloc(32, 7), meta = await StudentVault.open(directory, key);
  await meta.transaction(() => undefined); await meta.close();
  const vault = await StudentVault.open(join(directory, "connections"), key), store = new ConnectionsStore(vault);
  const a = { tenantId: "masterskaya", sub: "fictitious-a" }, b = { ...a, sub: "fictitious-b" };
  const runtime = new ConnectionsRuntime(store, [{ product: "twitch", clientId: "synthetic-client", clientSecret: "synthetic-private", admission: "live", testSubjects: [], scopes: [], callbackUrl: "https://broker.example.test/social/accounts/oauth/twitch/callback", billingApproved: false }]);
  await runtime.begin(a, "twitch"); await runtime.begin(b, "twitch");
  await store.transaction(d => {
    for (const s of [a, b]) {
      d.grants.push({ ...s, id: s.sub, product: "twitch", actorId: s.sub, accessToken: "synthetic-private", scopes: [], expiresAt: Date.now() + 3600000, fingerprint: "f".repeat(64), status: "active", validatedAt: Date.now() });
      d.resources.push({ ...s, id: s.sub, grantId: s.sub, product: "twitch", providerId: s.sub, kind: "account", label: "Fictitious account", capabilities: ["account"], status: "connected" });
      d.generations[JSON.stringify([s.tenantId, s.sub, "twitch"])] = 1;
    }
  });
  await vault.close();
  expect(await purgeStudentSubject(directory, key, a)).toEqual({ connections: 1, grants: 1, states: 1, generations: 1, events: 0 });
  const reopened = await StudentVault.open(join(directory, "connections"), key); cleanup.push(() => reopened.close());
  const remaining = await new ConnectionsStore(reopened).snapshot();
  expect(remaining.grants.map(g => g.sub)).toEqual([b.sub]); expect(remaining.states.map(s => s.sub)).toEqual([b.sub]); expect(remaining.resources.map(r => r.sub)).toEqual([b.sub]);
});
