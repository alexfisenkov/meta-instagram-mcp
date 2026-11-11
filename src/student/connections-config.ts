import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { BrokerError } from "./types.js";
import { connectionProducts, type ConnectionConfig, type ConnectionProduct } from "./connections-types.js";
export const baseConnectionScopes: Record<ConnectionProduct, string[]> = {
  twitch: [], linkedin: ["openid", "profile"], google_business_profile: ["openid", "profile", "https://www.googleapis.com/auth/business.manage"], x: ["tweet.read", "users.read", "offline.access"],
};
const optionalLinkedInScopes = ["r_liteprofile", "r_member_social", "r_organization_admin", "r_organization_social"] as const;
export const connectionConfigSchema = z.object({ version: z.literal(1), products: z.array(z.object({
  product: z.enum(connectionProducts), clientIdEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/), clientSecretEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  admission: z.enum(["disabled", "test", "live"]), testSubjects: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).max(100),
  linkedinReadScopes: z.array(z.enum(optionalLinkedInScopes)).max(4).optional(), apiVersion: z.string().regex(/^20\d{2}(0[1-9]|1[0-2])$/).optional(),
  billingApproved: z.boolean().default(false),
}).strict()).max(4) }).strict();
export async function loadConnectionsConfig(file: string | undefined, env: NodeJS.ProcessEnv, callbackOrigin: string): Promise<ConnectionConfig[]> {
  if (!file) return [];
  const data = connectionConfigSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const origin = new URL(callbackOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash) throw new BrokerError("invalid_callback_url");
  const seen = new Set<ConnectionProduct>();
  return data.products.flatMap(row => {
    if (seen.has(row.product) || row.product !== "linkedin" && (row.linkedinReadScopes || row.apiVersion) || row.linkedinReadScopes?.length && !row.apiVersion) throw new BrokerError("invalid_provider_config");
    seen.add(row.product);
    const clientId = env[row.clientIdEnv], clientSecret = env[row.clientSecretEnv];
    if (!clientId && !clientSecret) return [];
    if (!clientId || !clientSecret || !/^[A-Za-z0-9._-]{1,256}$/.test(clientId) || clientSecret.length > 8192 || /[\r\n]/.test(clientSecret)) throw new BrokerError("invalid_provider_config");
    return [{ product: row.product, clientId, clientSecret, callbackUrl: `${origin.origin}/social/accounts/oauth/${row.product}/callback`, admission: row.admission, testSubjects: row.testSubjects, scopes: [...baseConnectionScopes[row.product], ...new Set(row.linkedinReadScopes ?? [])], apiVersion: row.apiVersion, billingApproved: row.billingApproved }];
  });
}
export function connectionFingerprint(c: ConnectionConfig): string { return createHash("sha256").update(JSON.stringify([c.product, c.clientId, c.clientSecret, c.callbackUrl, c.scopes, c.apiVersion, c.billingApproved])).digest("hex"); }
