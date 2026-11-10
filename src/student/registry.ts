import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { BrokerError, PRODUCTS, type Product, type ProductConfig, type Provider, type Subject } from "./types.js";
const family: Record<Product, readonly Provider[]> = { instagram: ["instagram_unified", "instagram_login"], facebook: ["facebook_business"], messenger: ["facebook_business"], threads: ["threads"], ads: ["facebook_business"], whatsapp: ["facebook_business"], youtube: ["youtube"] };
export const LABELS: Record<Product, string> = { instagram: "Instagram", facebook: "Facebook Pages", messenger: "Messenger", threads: "Threads", ads: "Meta Ads", whatsapp: "WhatsApp Business", youtube: "YouTube" };
const ref = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const configSchema = z.object({ product: z.enum(PRODUCTS), key: z.string().regex(/^[a-z0-9_-]{1,64}$/), provider: z.enum(["instagram_unified", "instagram_login", "facebook_business", "threads", "youtube"]), appIdEnv: ref.optional(), appSecretEnv: ref.optional(), googleClientIdEnv: ref.optional(), googleClientSecretEnv: ref.optional(), callbackUrlEnv: ref.optional(), configId: z.string().regex(/^\d+$/).optional(), apiVersion: z.string().regex(/^v\d+\.0$|^v3$/), admission: z.enum(["disabled", "test", "live"]).default("disabled"), testSubjects: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).max(100).default([]), webhookVerifyTokenEnv: ref.optional() }).strict().superRefine((entry, ctx) => {
  const google = entry.provider === "youtube";
  if (google ? (!entry.googleClientIdEnv || !entry.googleClientSecretEnv || !entry.callbackUrlEnv || entry.appIdEnv !== undefined || entry.appSecretEnv !== undefined || entry.product !== "youtube" || entry.configId !== undefined || entry.apiVersion !== "v3") : (!entry.appIdEnv || !entry.appSecretEnv || entry.googleClientIdEnv !== undefined || entry.googleClientSecretEnv !== undefined || entry.callbackUrlEnv !== undefined)) ctx.addIssue({ code: "custom", message: "credential environment references do not match provider" });
});
export class StudentRegistry {
  private readonly configs: Map<Product, ProductConfig>;
  constructor(configs: ProductConfig[]) {
    this.configs = new Map(); const keys = new Set<string>();
    for (const config of configs) {
      const google = config.provider === "youtube";
      const validClientId = google ? /^[A-Za-z0-9._-]{1,256}$/.test(config.appId) : /^\d+$/.test(config.appId);
      const versionOK = google ? config.apiVersion === "v3" && config.product === "youtube" && config.configId === undefined : /^v\d+\.0$/.test(config.apiVersion);
      if (this.configs.has(config.product) || keys.has(config.key) || !family[config.product].includes(config.provider) || !validClientId || !config.appSecret || !versionOK || ((config.provider === "instagram_unified" || config.provider === "facebook_business") && !/^\d+$/.test(config.configId ?? "")) || ((config.provider === "instagram_login" && config.product !== "instagram") || (google && config.product !== "youtube"))) throw new BrokerError("invalid_provider_config");
      const callback = new URL(config.callbackUrl);
      const callbackPathOK = config.provider === "youtube" ? callback.pathname === "/youtube/oauth/callback" : ["/student/oauth/callback", "/meta/oauth/callback"].includes(callback.pathname);
      if (callback.protocol !== "https:" || callback.username || callback.password || !callbackPathOK || callback.search || callback.hash) throw new BrokerError("invalid_callback_url");
      this.configs.set(config.product, structuredClone(config)); keys.add(config.key);
    }
  }
  static async load(file: string | undefined, callbackUrl: string, env: NodeJS.ProcessEnv): Promise<StudentRegistry> {
    if (!file) return new StudentRegistry([]);
    const records = z.object({ version: z.literal(1), products: z.array(configSchema).max(7) }).strict().parse(JSON.parse(await readFile(file, "utf8")));
    const configs: ProductConfig[] = [];
    for (const entry of records.products) {
      const google = entry.provider === "youtube";
      const idName = google ? entry.googleClientIdEnv! : entry.appIdEnv!;
      const secretName = google ? entry.googleClientSecretEnv! : entry.appSecretEnv!;
      const appId = env[idName], appSecret = env[secretName];
      if (google && Boolean(appId) !== Boolean(appSecret)) throw new BrokerError("invalid_provider_config");
      // Missing credentials are visibly not_configured; never consult legacy Meta or owner-token settings.
      if (!appId || !appSecret) continue;
      const productCallback = google ? env[entry.callbackUrlEnv!] : callbackUrl;
      if (!productCallback) throw new BrokerError("invalid_callback_url");
      configs.push({ ...entry, appId, appSecret, callbackUrl: productCallback, webhookVerifyToken: entry.webhookVerifyTokenEnv ? env[entry.webhookVerifyTokenEnv] : undefined });
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
export function authorizationUrl(c: ProductConfig, state: string, codeChallenge?: string): string {
  if (c.provider === "youtube") {
    if (!codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new BrokerError("google_pkce_challenge_required");
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", c.appId); url.searchParams.set("redirect_uri", c.callbackUrl); url.searchParams.set("response_type", "code"); url.searchParams.set("state", state);
    url.searchParams.set("scope", "openid profile https://www.googleapis.com/auth/youtube.readonly"); url.searchParams.set("access_type", "offline"); url.searchParams.set("prompt", "select_account consent");
    url.searchParams.set("code_challenge", codeChallenge); url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }
  const url = new URL(c.provider === "threads" ? "https://threads.com/oauth/authorize" : c.provider === "instagram_login" ? "https://www.instagram.com/oauth/authorize" : "https://www.facebook.com/dialog/oauth");
  url.searchParams.set("client_id", c.appId); url.searchParams.set("redirect_uri", c.callbackUrl); url.searchParams.set("response_type", "code"); url.searchParams.set("state", state);
  if (c.provider === "threads") url.searchParams.set("scope", "threads_basic,threads_read_replies,threads_manage_insights");
  else if (c.provider === "instagram_login") url.searchParams.set("scope", "instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages,instagram_business_content_publish,instagram_business_manage_insights");
  else { url.searchParams.set("config_id", c.configId!); if (c.provider === "instagram_unified") { url.searchParams.set("display", "popup"); url.searchParams.set("prompt", "login"); url.searchParams.set("override_default_response_type", "true"); } }
  return url.toString();
}
