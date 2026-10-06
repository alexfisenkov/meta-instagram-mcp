import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, isAbsolute } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createNoRedirectFetch, isLoopbackHost } from "./transport-config.js";
import type { BridgeMode, BridgeSource, BridgeTask } from "./companion-hub.js";

export interface BridgeClientConfig {
  baseUrl: string;
  bearerToken: string;
  mode: BridgeMode;
  source: BridgeSource;
  accountBinding: string;
  capabilities: string[];
  bridgeId?: string;
  bridgeToken?: string;
  trustedApprovalPublicKey?: string;
  allowLoopbackHttpForTests?: boolean;
}
export interface BridgeClientOptions extends BridgeClientConfig {
  credentialsPath: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export class OutboundBridgeClient {
  private bridgeId?: string;
  private bridgeToken?: string;
  private trustedApprovalPublicKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: BridgeClientOptions) {
    validateConfig(options);
    this.bridgeId = options.bridgeId;
    this.bridgeToken = options.bridgeToken;
    this.trustedApprovalPublicKey = options.trustedApprovalPublicKey;
    this.fetchImpl = createNoRedirectFetch(options.fetchImpl ?? fetch);
  }

  get approvalPublicKey(): string | undefined { return this.trustedApprovalPublicKey; }

  async register(capabilities: readonly string[] = this.options.capabilities): Promise<{ bridgeId: string; approvalPublicKey?: string }> {
    if (!Array.isArray(capabilities) || capabilities.length > 64 || capabilities.some((item) => !this.options.capabilities.includes(item))) {
      throw new Error("registered runtime capabilities must be a subset of the configured allowlist");
    }
    const result = await this.request<{ bridgeId: string; bridgeToken: string; approvalPublicKey?: string }>("/bridge/register", {
      method: "POST", body: { mode: this.options.mode, source: this.options.source, accountBinding: this.options.accountBinding, capabilities: [...new Set(capabilities)] }
    });
    if (result.approvalPublicKey !== undefined && !validPublicKey(result.approvalPublicKey)) throw new Error("bridge returned an invalid approval public key");
    if (this.trustedApprovalPublicKey && result.approvalPublicKey && this.trustedApprovalPublicKey !== result.approvalPublicKey) throw new Error("bridge approval key changed; explicit re-pinning is required");
    this.trustedApprovalPublicKey ??= result.approvalPublicKey;
    this.bridgeId = result.bridgeId;
    this.bridgeToken = result.bridgeToken;
    await saveBridgeCredentials(this.options.credentialsPath, { bridgeId: result.bridgeId, bridgeToken: result.bridgeToken,
      ...(this.trustedApprovalPublicKey ? { trustedApprovalPublicKey: this.trustedApprovalPublicKey } : {}) });
    return { bridgeId: result.bridgeId, ...(this.trustedApprovalPublicKey ? { approvalPublicKey: this.trustedApprovalPublicKey } : {}) };
  }

  async heartbeat(bridgeId = this.requiredBridgeId(), status: unknown = { online: true }): Promise<void> {
    const body = { bridgeId, bridgeToken: this.requiredBridgeToken(), status };
    try { await this.request("/bridge/heartbeat", { method: "POST", body }); }
    catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await this.request("/bridge/heartbeat", { method: "POST", body });
    }
  }

  async poll(bridgeId = this.requiredBridgeId(), maxTasks: number): Promise<BridgeTask[]> {
    const result = await this.request<{ tasks: BridgeTask[] }>("/bridge/poll", { method: "POST", body: { bridgeId, bridgeToken: this.requiredBridgeToken(), maxTasks } });
    return result.tasks;
  }

  async submit(bridgeId: string, taskId: string, result: unknown, contextHash?: string): Promise<void> {
    await this.request("/bridge/result", { method: "POST", body: { bridgeId, bridgeToken: this.requiredBridgeToken(), taskId, result, contextHash } });
  }

  private requiredBridgeId(): string { if (!this.bridgeId) throw new Error("bridge is not registered"); return this.bridgeId; }
  private requiredBridgeToken(): string { if (!this.bridgeToken) throw new Error("bridge is not registered"); return this.bridgeToken; }

  private async request<T = void>(path: string, input: { method: "POST"; body: unknown }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 15_000);
    try {
      const response = await this.fetchImpl(new URL(path, this.options.baseUrl), {
        method: input.method,
        headers: {
          authorization: `Bearer ${this.options.bearerToken}`,
          "content-type": "application/json",
          "x-api-protocol-version": "1",
          "x-bridge-source": this.options.source
        },
        body: JSON.stringify(input.body),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`bridge request rejected (${response.status})`);
      if (response.status === 204) return undefined as T;
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > 65_536) throw new Error("bridge response exceeds size limit");
      const text = await response.text();
      if (Buffer.byteLength(text) > 65_536) throw new Error("bridge response exceeds size limit");
      return JSON.parse(text) as T;
    } finally { clearTimeout(timer); }
  }
}

export async function loadBridgeClientConfig(path: string): Promise<BridgeClientConfig> {
  assertExternalConfigPath(path);
  const info = await import("node:fs/promises").then(({ stat }) => stat(path));
  if ((info.mode & 0o077) !== 0) throw new Error("bridge config must have private file permissions");
  const value = JSON.parse(await readFile(path, "utf8")) as BridgeClientConfig;
  validateConfig(value);
  return value;
}

export async function saveBridgeCredentials(path: string, credentials: { bridgeId: string; bridgeToken: string; trustedApprovalPublicKey?: string }): Promise<void> {
  assertExternalConfigPath(path);
  let config: BridgeClientConfig;
  try { config = JSON.parse(await readFile(path, "utf8")) as BridgeClientConfig; }
  catch { throw new Error("bridge config is unavailable"); }
  const temp = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temp, JSON.stringify({ ...config, ...credentials }), { flag: "wx", mode: 0o600 });
  await chmod(temp, 0o600);
  const { rename } = await import("node:fs/promises");
  await rename(temp, path);
  await chmod(path, 0o600);
}

function validPublicKey(value: string): boolean { return value.length <= 4_096 && value.startsWith("-----BEGIN PUBLIC KEY-----") && value.includes("-----END PUBLIC KEY-----"); }

function validateConfig(config: BridgeClientConfig): void {
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { throw new Error("invalid bridge URL"); }
  const localTestHttp = config.allowLoopbackHttpForTests === true && url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !localTestHttp) throw new Error("bridge URL must use HTTPS");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("bridge URL must be an origin only");
  if (typeof config.bearerToken !== "string" || Buffer.byteLength(config.bearerToken) < 32) throw new Error("invalid bridge bearer token");
  if (!["browser_native_host", "phone_standalone"].includes(config.mode) || !["browser", "phone"].includes(config.source)) throw new Error("invalid bridge mode/source");
  if ((config.mode === "browser_native_host") !== (config.source === "browser")) throw new Error("bridge mode/source mismatch");
  if (typeof config.accountBinding !== "string" || !/^[a-zA-Z0-9:_-]{1,128}$/.test(config.accountBinding)) throw new Error("invalid account binding");
  if (!Array.isArray(config.capabilities) || config.capabilities.length > 64 || config.capabilities.some((item) => typeof item !== "string" || item.length > 64)) throw new Error("invalid capabilities");
}

function assertExternalConfigPath(path: string): void {
  if (!isAbsolute(path)) throw new Error("bridge config path must be absolute");
  const target = resolve(path);
  const cwd = resolve(process.cwd());
  const rel = relative(cwd, target);
  if (!rel.startsWith("..") && rel !== "..") throw new Error("bridge config must be outside the project directory");
}
