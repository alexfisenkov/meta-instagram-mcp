import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { BrokerError, PRODUCTS, type Product, type ProductConfig, type Provider, type Subject } from "./types.js";
const family: Record<Product, readonly Provider[]> = { instagram: ["instagram_unified", "instagram_login"], facebook: ["facebook_business"], messenger: ["facebook_business"], threads: ["threads"], ads: ["facebook_business"], whatsapp: ["facebook_business"] };
export const LABELS: Record<Product, string> = { instagram: "Instagram", facebook: "Facebook Pages", messenger: "Messenger", threads: "Threads", ads: "Meta Ads", whatsapp: "WhatsApp Business" };
const ref = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const configSchema = z.object({ product: z.enum(PRODUCTS), key: z.string().regex(/^[a-z0-9_-]{1,64}$/), provider: z.enum(["instagram_unified", "instagram_login", "facebook_business", "threads"]), appIdEnv: ref, appSecretEnv: ref, configId: z.string().regex(/^\d+$/).optional(), apiVersion: z.string().regex(/^v\d+\.0$/), admission: z.enum(["disabled", "test", "live"]).default("disabled"), testSubjects: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).max(100).default([]), webhookVerifyTokenEnv: ref.optional() }).strict();
export class StudentRegistry {
  private readonly configs: Map<Product, ProductConfig>;
  constructor(configs: ProductConfig[]) {
    this.configs = new Map(); const keys = new Set<string>();
    for (const config of configs) {
      if (this.configs.has(config.product) || keys.has(config.key) || !family[config.product].includes(config.provider) || !/^\d+$/.test(config.appId) || !config.appSecret || !/^v\d+\.0$/.test(config.apiVersion) || ((config.provider === "instagram_unified" || config.provider === "facebook_business") && !/^\d+$/.test(config.configId ?? "")) || (config.provider === "instagram_login" && config.product !== "instagram")) throw new BrokerError("invalid_provider_config");
      const callback = new URL(config.callbackUrl);
      if (callback.protocol !== "https:" || callback.username || callback.password || !["/student/oauth/callback", "/meta/oauth/callback"].includes(callback.pathname) || callback.search || callback.hash) throw new BrokerError("invalid_callback_url");
      this.configs.set(config.product, structuredClone(config)); keys.add(config.key);
    }
  }
  static async load(file: string | undefined, callbackUrl: string, env: NodeJS.ProcessEnv): Promise<StudentRegistry> {
    if (!file) return new StudentRegistry([]);
    const records = z.object({ version: z.literal(1), products: z.array(configSchema).max(6) }).strict().parse(JSON.parse(await readFile(file, "utf8")));
    const configs: ProductConfig[] = [];
    for (const entry of records.products) {
      const appId = env[entry.appIdEnv], appSecret = env[entry.appSecretEnv];
      // Missing credentials are visibly not_configured; never consult legacy META_ACCESS_TOKEN.
      if (!appId || !appSecret) continue;
      configs.push({ ...entry, appId, appSecret, callbackUrl, webhookVerifyToken: entry.webhookVerifyTokenEnv ? env[entry.webhookVerifyTokenEnv] : undefined });
    }
    return new StudentRegistry(configs);
  }
  get(product: Product): ProductConfig | undefined { const config = this.configs.get(product); return config ? structuredClone(config) : undefined; }
  byKey(key: string): ProductConfig | undefined { const config = [...this.configs.values()].find((c) => c.key === key); return config ? structuredClone(config) : undefined; }
  status(product: Product, subject: Subject): "not_configured" | "review_required" | "ready" {
    const c = this.configs.get(product); if (!c) return "not_configured";
    return c.admission === "live" || (c.admission === "test" && c.testSubjects.includes(subject.sub)) ? "ready" : "review_required";
  }
}
export function configFingerprint(c: ProductConfig): string {
  // Admission and webhook verification are operational policy, not the OAuth grant identity.
  return createHash("sha256").update(JSON.stringify(["oauth-grant-v1", c.product, c.key, c.provider, c.appId, c.appSecret, c.configId ?? null, c.apiVersion, c.callbackUrl])).digest("hex");
}
export function authorizationUrl(c: ProductConfig, state: string): string {
  const url = new URL(c.provider === "threads" ? "https://threads.com/oauth/authorize" : c.provider === "instagram_login" ? "https://www.instagram.com/oauth/authorize" : "https://www.facebook.com/dialog/oauth");
  url.searchParams.set("client_id", c.appId); url.searchParams.set("redirect_uri", c.callbackUrl); url.searchParams.set("response_type", "code"); url.searchParams.set("state", state);
  if (c.provider === "threads") url.searchParams.set("scope", "threads_basic,threads_read_replies,threads_manage_insights");
  else if (c.provider === "instagram_login") {
    url.searchParams.set("scope", "instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages,instagram_business_content_publish,instagram_business_manage_insights");
    url.searchParams.set("force_reauth", "true");
  }
  else { url.searchParams.set("config_id", c.configId!); if (c.provider === "instagram_unified") { url.searchParams.set("display", "popup"); url.searchParams.set("prompt", "login"); url.searchParams.set("override_default_response_type", "true"); } }
  return url.toString();
}
