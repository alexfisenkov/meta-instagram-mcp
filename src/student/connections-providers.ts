import { BrokerError } from "./types.js";
import { readGoogleDailyMetrics } from "./connections-google-metrics.js";
import { ConnectionsHttp } from "./connections-http.js";
import type { ConnectionConfig, ConnectionGrant, ConnectionIdentity, ConnectionRead, ConnectionResource, DiscoveredResource } from "./connections-types.js";
export const nativeId = (v: unknown, pattern = /^[A-Za-z0-9_-]{1,128}$/): string => { if (typeof v !== "string" || !pattern.test(v)) throw new BrokerError("grant_verification_failed"); return v; };
const label = (v: unknown, fallback: string): string => typeof v === "string" && v.length && v.length <= 512 ? v : fallback;
const list = (v: unknown): Record<string, any>[] => { if (!Array.isArray(v) || v.length > 100 || v.some(x => !x || typeof x !== "object" || Array.isArray(x))) throw new BrokerError("provider_response_invalid"); return v; };
const text = (v: unknown, max = 10000) => typeof v === "string" && v.length <= max ? v : undefined;
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : undefined;
const numericId = /^\d{1,64}$/;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
export class ConnectionsProviders {
  constructor(readonly http = new ConnectionsHttp()) {}
  headers(c: ConnectionConfig, token: string): Record<string, string> {
    return { ...bearer(token), ...(c.product === "twitch" ? { "Client-Id": c.clientId } : {}), ...(c.product === "linkedin" && c.apiVersion ? { "LinkedIn-Version": c.apiVersion, "X-Restli-Protocol-Version": "2.0.0" } : {}) };
  }
  private async optionalLinkedIn(url: string, headers: Record<string, string>) {
    try { return await this.http.json(url, { headers }); }
    catch (e) { if (e instanceof BrokerError && e.code === "permission_unavailable") return undefined; throw e; }
  }
  private async pages(url: string, headers: Record<string, string>, field: string, tokenField = "nextPageToken"): Promise<Record<string, any>[]> {
    const rows: Record<string, any>[] = []; let pageToken: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const u = new URL(url); if (pageToken) u.searchParams.set("pageToken", pageToken);
      const b = await this.http.json(u.toString(), { headers }); rows.push(...list(b[field] ?? []));
      if (rows.length > 1000) throw new BrokerError("discovery_limit_exceeded");
      if (!b[tokenField]) return rows;
      pageToken = text(b[tokenField], 2048);
      if (!pageToken || seen.has(pageToken)) throw new BrokerError("provider_response_invalid");
      seen.add(pageToken);
    }
    throw new BrokerError("discovery_limit_exceeded");
  }
  async identity(c: ConnectionConfig, token: string, scopes: string[]): Promise<ConnectionIdentity> {
    const headers = this.headers(c, token);
    if (c.product === "twitch") {
      const verified = await this.http.json("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: `OAuth ${token}` } });
      if (verified.client_id !== c.clientId || !Array.isArray(verified.scopes) || verified.scopes.length > 64 || verified.scopes.some((s: unknown) => typeof s !== "string" || s.length > 255) || !Number.isSafeInteger(verified.expires_in) || verified.expires_in <= 0) throw new BrokerError("grant_verification_failed");
      const actorId = nativeId(verified.user_id, numericId);
      const b = await this.http.json("https://api.twitch.tv/helix/users", { headers });
      const users = list(b.data); if (users.length !== 1 || users[0].id !== actorId) throw new BrokerError("grant_verification_failed");
      return { actorId, validatedScopes: verified.scopes, expiresIn: verified.expires_in, resources: [{ providerId: actorId, kind: "account", label: label(users[0].display_name, actorId), capabilities: ["account", "posts", "metrics"] }] };
    }
    if (c.product === "linkedin") {
      const user = await this.http.json("https://api.linkedin.com/v2/userinfo", { headers });
      const actorId = nativeId(user.sub);
      const resources: DiscoveredResource[] = [{ providerId: actorId, kind: "account", label: label(user.name, actorId), capabilities: ["account"] }];
      // OIDC sub is never assumed to be a Person URN. Optional partner APIs require native /me identity.
      if (c.apiVersion && c.scopes.includes("r_liteprofile") && scopes.includes("r_liteprofile")) {
        const me = await this.optionalLinkedIn("https://api.linkedin.com/v2/me", headers);
        if (!me) return { actorId, resources };
        const person = `urn:li:person:${nativeId(me.id)}`;
        resources.push({ providerId: person, kind: "person", label: label(user.name, person), capabilities: ["account", ...(scopes.includes("r_member_social") ? ["posts" as const] : [])] });
        if (scopes.includes("r_organization_admin")) {
          const acls = await this.optionalLinkedIn("https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=100&start=0", headers);
          if (!acls) return { actorId, resources };
          // Never imply an incomplete discovery is complete or follow provider-supplied URLs.
          if (Array.isArray(acls.paging?.links) && acls.paging.links.some((x: any) => x?.rel === "next")) throw new BrokerError("discovery_limit_exceeded");
          for (const acl of list(acls.elements ?? [])) {
            if (acl.state !== "APPROVED" || acl.role !== "ADMINISTRATOR" || acl.roleAssignee !== person) continue;
            const providerId = nativeId(acl.organization ?? acl.organizationTarget, /^urn:li:organization:\d{1,64}$/);
            if (resources.some(r => r.providerId === providerId)) continue;
            const org = await this.optionalLinkedIn(`https://api.linkedin.com/rest/organizations/${providerId.split(":").at(-1)}`, headers);
            if (!org) continue;
            if (String(org.id) !== providerId.split(":").at(-1)) throw new BrokerError("grant_verification_failed");
            resources.push({ providerId, kind: "organization", label: label(org.localizedName, providerId), capabilities: ["account", ...(scopes.includes("r_organization_social") ? ["posts" as const] : [])] });
          }
        }
      }
      return { actorId, resources };
    }
    if (c.product === "google_business_profile") {
      const user = await this.http.json("https://openidconnect.googleapis.com/v1/userinfo", { headers });
      const actorId = nativeId(user.sub), resources: DiscoveredResource[] = [];
      for (const account of await this.pages("https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20", headers, "accounts")) {
        const parentId = nativeId(account.name, /^accounts\/\d{1,64}$/);
        for (const loc of await this.pages(`https://mybusinessbusinessinformation.googleapis.com/v1/${parentId}/locations?readMask=name,title&pageSize=100`, headers, "locations")) {
          const providerId = nativeId(loc.name, /^locations\/\d{1,64}$/);
          if (resources.some(r => r.providerId === providerId)) continue;
          resources.push({ providerId, parentId, kind: "location", label: label(loc.title, providerId), capabilities: ["account", "posts", "metrics"] });
          if (resources.length > 1000) throw new BrokerError("discovery_limit_exceeded");
        }
      }
      return { actorId, resources };
    }
    const b = await this.http.json("https://api.x.com/2/users/me?user.fields=name,username,public_metrics", { headers });
    const actorId = nativeId(b.data?.id, numericId);
    return { actorId, resources: [{ providerId: actorId, kind: "account", label: label(b.data.name, actorId), capabilities: ["account", "metrics", ...(scopes.includes("tweet.read") ? ["posts" as const] : [])] }] };
  }
  async read(c: ConnectionConfig, grant: ConnectionGrant, resource: ConnectionResource, input: ConnectionRead): Promise<Record<string, unknown>> {
    if (!resource.capabilities.includes(input.operation)) throw new BrokerError("operation_unavailable");
    const headers = this.headers(c, grant.accessToken), observedAt = new Date().toISOString();
    const result: Record<string, unknown> = { product: c.product, operation: input.operation, accountId: resource.providerId, observedAt, source: c.product === "google_business_profile" ? "google_business_profile_profile_api" : `${c.product}_api` };
    if (c.product === "twitch") {
      if (input.operation === "account") {
        const b = await this.http.json("https://api.twitch.tv/helix/users", { headers }), users = list(b.data);
        if (users.length !== 1 || users[0].id !== resource.providerId) throw new BrokerError("resource_not_owned");
        return { ...result, account: { id: resource.providerId, label: text(users[0].display_name, 512), username: text(users[0].login, 128), description: text(users[0].description) } };
      }
      const b = await this.http.json(`https://api.twitch.tv/helix/videos?user_id=${resource.providerId}&first=${input.limit}`, { headers });
      const items = list(b.data).map(v => { if (v.user_id !== resource.providerId) throw new BrokerError("resource_not_owned"); return { id: nativeId(v.id, numericId), title: text(v.title, 1000), createdAt: text(v.created_at, 40), viewCount: count(v.view_count) }; });
      return { ...result, items, ...(input.operation === "metrics" ? { window: "video_lifetime", timezone: "not_applicable", definition: "viewCount: documented per-video lifetime view count; bounded page, never a channel total" } : {}), truncated: Boolean(b.pagination?.cursor) };
    }
    if (c.product === "linkedin") {
      if (input.operation === "account") {
        if (resource.kind === "account") {
          const user = await this.http.json("https://api.linkedin.com/v2/userinfo", { headers });
          if (user.sub !== grant.actorId || user.sub !== resource.providerId) throw new BrokerError("resource_not_owned");
          return { ...result, account: { id: resource.providerId, label: text(user.name, 512), givenName: text(user.given_name, 128), familyName: text(user.family_name, 128) } };
        }
        if (resource.kind === "person") return { ...result, account: { id: resource.providerId, label: resource.label, kind: resource.kind } };
        const b = await this.http.json(`https://api.linkedin.com/rest/organizations/${resource.providerId.split(":").at(-1)}`, { headers });
        if (String(b.id) !== resource.providerId.split(":").at(-1)) throw new BrokerError("resource_not_owned");
        return { ...result, account: { id: resource.providerId, label: text(b.localizedName, 512), kind: resource.kind } };
      }
      const u = new URL("https://api.linkedin.com/rest/posts"); u.searchParams.set("q", "author"); u.searchParams.set("author", resource.providerId); u.searchParams.set("count", String(input.limit)); u.searchParams.set("viewContext", "AUTHOR");
      const b = await this.http.json(u.toString(), { headers });
      return { ...result, items: list(b.elements ?? []).map(p => { if (p.author !== resource.providerId) throw new BrokerError("resource_not_owned"); return { id: nativeId(p.id, /^urn:li:(ugcPost|share):\d{1,64}$/), text: text(p.commentary), createdAt: count(p.createdAt), state: text(p.lifecycleState, 64) }; }), truncated: Boolean(b.paging?.links?.some((x: any) => x?.rel === "next")) };
    }
    if (c.product === "google_business_profile") {
      if (input.operation === "metrics") return { ...result, ...await readGoogleDailyMetrics(this.http, resource.providerId, headers) };
      if (input.operation === "account") {
        const b = await this.http.json(`https://mybusinessbusinessinformation.googleapis.com/v1/${resource.providerId}?readMask=name,title,websiteUri`, { headers });
        if (b.name !== resource.providerId) throw new BrokerError("resource_not_owned");
        return { ...result, account: { id: resource.providerId, parentId: resource.parentId, label: text(b.title, 512), website: text(b.websiteUri, 2048) } };
      }
      const parent = `${resource.parentId}/${resource.providerId}`, b = await this.http.json(`https://mybusiness.googleapis.com/v4/${parent}/localPosts?pageSize=${input.limit}`, { headers });
      return { ...result, items: list(b.localPosts ?? []).map(p => { const id = nativeId(p.name, /^accounts\/\d{1,64}\/locations\/\d{1,64}\/localPosts\/[A-Za-z0-9_-]{1,128}$/); if (!id.startsWith(`${parent}/localPosts/`)) throw new BrokerError("resource_not_owned"); return { id, text: text(p.summary), createdAt: text(p.createTime, 40), state: text(p.state, 64) }; }), truncated: Boolean(b.nextPageToken) };
    }
    if (input.operation !== "posts") {
      const b = await this.http.json("https://api.x.com/2/users/me?user.fields=name,username,public_metrics", { headers });
      if (b.data?.id !== resource.providerId) throw new BrokerError("resource_not_owned");
      const m = b.data.public_metrics;
      return { ...result, account: { id: resource.providerId, label: text(b.data.name, 512), username: text(b.data.username, 128) }, ...(input.operation === "metrics" ? { metrics: { followers: count(m?.followers_count), following: count(m?.following_count), posts: count(m?.post_count), listed: count(m?.listed_count) }, window: "current_snapshot", timezone: "not_applicable", definition: "public_metrics of the authenticated account at observedAt" } : {}) };
    }
    const b = await this.http.json(`https://api.x.com/2/users/${resource.providerId}/tweets?max_results=${Math.max(5, input.limit)}&post.fields=author_id,created_at,public_metrics`, { headers });
    if (b.errors?.length) throw new BrokerError("provider_response_partial");
    return { ...result, items: list(b.data ?? []).slice(0, input.limit).map(p => { if (p.author_id !== resource.providerId) throw new BrokerError("resource_not_owned"); return { id: nativeId(p.id, numericId), text: text(p.text), createdAt: text(p.created_at, 40) }; }), truncated: Boolean(b.meta?.next_token) || (b.data?.length ?? 0) > input.limit };
  }
}
