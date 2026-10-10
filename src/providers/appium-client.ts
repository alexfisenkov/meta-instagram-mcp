import { isLoopbackHost } from "../transport-config.js";

export type PhonePlatform = "iOS" | "Android";
export interface AppiumDeviceConfig {
  serverUrl: string;
  platform: PhonePlatform;
  /** Required: a private operator-selected device identifier. Never returned by this adapter. */
  selectedDevice?: { id: string; name?: string };
  /** A loopback WDA /status endpoint already bound to selectedDevice. Required for iOS. */
  wdaStatusUrl?: string;
  /** A loopback UiAutomator2 /status endpoint already bound to selectedDevice. Required for Android. */
  deviceStatusUrl?: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}
export type AppiumAvailability = "ready" | "offline" | "not_connected" | "needs_selection" | "unsupported";
export interface AppiumReadiness {
  availability: AppiumAvailability;
  capabilities: string[];
  /** Appium plus the configured selected-device endpoint passed transport probes. */
  transportReady: boolean;
  /** The selected device is trusted only after a W3C session reports its exact configured id. */
  selectedDeviceIdentity: "unverified" | "verified";
  reason?: string;
}
export interface AppiumSession { sessionId: string; capabilities: Record<string, unknown> }

export class AppiumClientError extends Error {
  constructor(message: string, readonly outcomeUnknown = false) { super(message); this.name = "AppiumClientError"; }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;

/** Narrow W3C client for one explicitly selected local device and Instagram app. */
export class AppiumClient {
  readonly #serverUrl: URL;
  readonly #statusUrl?: URL;
  readonly #config: AppiumDeviceConfig;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  #session?: AppiumSession;
  #closed = false;

  constructor(config: AppiumDeviceConfig) {
    this.#config = config;
    this.#serverUrl = localHttpUrl(config.serverUrl, "Appium server URL", true);
    const probe = config.platform === "iOS" ? config.wdaStatusUrl : config.deviceStatusUrl;
    if (probe) this.#statusUrl = localHttpUrl(probe, "device status URL", false);
    this.#timeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 250 || this.#timeoutMs > 30_000) throw new Error("invalid Appium request timeout");
    if (!Number.isInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1_024 || this.#maxResponseBytes > 8_388_608) throw new Error("invalid Appium response limit");
    if (config.platform !== "iOS" && config.platform !== "Android") throw new Error("unsupported phone platform");
    this.#fetch = config.fetchImpl ?? fetch;
    if (config.selectedDevice && (!validDeviceId(config.selectedDevice.id) || (config.selectedDevice.name !== undefined && !validDeviceName(config.selectedDevice.name)))) throw new Error("invalid selected-device configuration");
  }

  async readiness(): Promise<AppiumReadiness> {
    if (this.#closed) return { availability: "offline", capabilities: [], transportReady: false, selectedDeviceIdentity: "unverified", reason: "companion is closed" };
    if (!this.#config.selectedDevice?.id) return { availability: "needs_selection", capabilities: [], transportReady: false, selectedDeviceIdentity: "unverified", reason: "a device must be selected explicitly" };
    if (!this.#statusUrl) return { availability: "not_connected", capabilities: [], transportReady: false, selectedDeviceIdentity: "unverified", reason: "selected-device automation status URL is not configured" };
    try {
      const appium = await this.#request(new URL("status", ensureSlash(this.#serverUrl)));
      if (!appium.ok || !readyFlag(appium.body)) return { availability: "offline", capabilities: [], transportReady: false, selectedDeviceIdentity: "unverified", reason: "Appium server is not ready" };
    } catch { return { availability: "offline", capabilities: [], transportReady: false, selectedDeviceIdentity: "unverified", reason: "Appium server is unavailable" }; }
    try {
      const device = await this.#request(this.#statusUrl);
      if (!device.ok || !readyFlag(device.body)) return { availability: "not_connected", capabilities: [], transportReady: false, selectedDeviceIdentity: "unverified", reason: "selected-device automation endpoint is not ready" };
    } catch { return { availability: "not_connected", capabilities: [], transportReady: false, selectedDeviceIdentity: "unverified", reason: "selected-device automation endpoint is unavailable" }; }
    if (!this.#session) return { availability: "not_connected", capabilities: [], transportReady: true, selectedDeviceIdentity: "unverified", reason: "transport is ready; selected-device identity awaits a pinned W3C session" };
    return { availability: "ready", capabilities: [], transportReady: true, selectedDeviceIdentity: "verified" };
  }

  async createSession(): Promise<AppiumSession> {
    if (this.#closed) throw new AppiumClientError("Appium client is closed");
    if (this.#session) return this.#session;
    const ready = await this.readiness();
    if (!ready.transportReady) throw new AppiumClientError(`phone is ${ready.availability}: ${ready.reason ?? "readiness check failed"}`);
    const device = this.#config.selectedDevice!;
    const ios = this.#config.platform === "iOS";
    const alwaysMatch: Record<string, unknown> = {
      platformName: this.#config.platform,
      "appium:automationName": ios ? "XCUITest" : "UiAutomator2",
      "appium:udid": device.id,
      "appium:deviceName": device.name ?? device.id,
      "appium:noReset": true,
      "appium:autoAcceptAlerts": false,
      ...(ios ? { "appium:bundleId": "com.burbn.instagram", "appium:useNewWDA": false } : { "appium:appPackage": "com.instagram.android", "appium:appActivity": "com.instagram.mainactivity.InstagramMainActivity" })
    };
    let result: { ok: boolean; body: unknown };
    try {
      result = await this.#request(new URL("session", ensureSlash(this.#serverUrl)), {
        method: "POST",
        body: { capabilities: { alwaysMatch, firstMatch: [{}] } }
      });
    } catch (error) {
      throw new AppiumClientError("Appium session creation outcome is unknown; do not retry automatically", true);
    }
    const parsed = sessionFrom(result.body);
    if (!result.ok || !parsed) throw new AppiumClientError("Appium did not return a valid W3C session");
    this.#session = parsed;
    const returnedDevice = parsed.capabilities.udid ?? parsed.capabilities["appium:udid"];
    if (typeof returnedDevice !== "string" || returnedDevice !== device.id) {
      await this.closeSession();
      throw new AppiumClientError("Appium session did not prove the selected device identity");
    }
    return parsed;
  }

  async getSource(): Promise<string> {
    const session = this.requireSession();
    const result = await this.#request(this.sessionUrl(session.sessionId, "source"));
    if (!result.ok || typeof unwrap(result.body) !== "string") throw new AppiumClientError("Appium source request failed");
    return unwrap(result.body) as string;
  }

  /** Fixed semantic controls only; row labels must come from a fresh unique UI observation. */
  async clickSemantic(control: "profile_tab" | "home_tab" | "inbox_tab" | "insights_menu" | "insights_entry" | "selected_row" | "comment_like" | "comment_unlike", observedLabel?: string): Promise<void> {
    const id = control === "profile_tab" || control === "home_tab" || control === "inbox_tab" ? observedLabel
      : control === "insights_menu" ? "more-options-button"
        : control === "comment_like" ? "Like"
          : control === "comment_unlike" ? "Unlike"
            : control === "insights_entry" ? observedLabel
              : observedLabel;
    if (!id || (control === "profile_tab" && id !== "Profile") || (control === "home_tab" && id !== "Home") ||
        (control === "insights_entry" && !["View insights", "Insights"].includes(id)) ||
        (control === "inbox_tab" && !["Messages", "Inbox"].includes(id))) throw new AppiumClientError("unsupported semantic control");
    if ((control === "profile_tab" || control === "home_tab" || control === "selected_row" || control === "insights_entry" || control === "inbox_tab") && !validObservedLabel(id)) throw new AppiumClientError("invalid observed semantic label");
    const session = this.requireSession();
    const found = await this.#request(this.sessionUrl(session.sessionId, "elements"), {
      method: "POST", body: { using: "accessibility id", value: id }
    });
    const elementIds = elementIdsFrom(found.body);
    if (!found.ok || elementIds.length !== 1 || !elementIds[0]) throw new AppiumClientError("semantic control is missing or ambiguous");
    const elementId = elementIds[0]!;
    const clicked = await this.#request(this.sessionUrl(session.sessionId, `element/${encodeURIComponent(elementId)}/click`), { method: "POST", body: {} });
    if (!clicked.ok) throw new AppiumClientError("semantic control click failed", true);
  }

  async closeSession(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    if (!session || this.#closed) return;
    try { await this.#request(this.sessionUrl(session.sessionId, ""), { method: "DELETE" }); }
    catch { /* session cleanup is best-effort and is never retried */ }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.closeSession();
    this.#closed = true;
  }

  private requireSession(): AppiumSession {
    if (!this.#session || this.#closed) throw new AppiumClientError("no active Appium session");
    return this.#session;
  }

  private sessionUrl(sessionId: string, path: string): URL {
    if (!/^[A-Za-z0-9._-]{1,256}$/.test(sessionId)) throw new AppiumClientError("invalid Appium session id");
    return new URL(`session/${encodeURIComponent(sessionId)}/${path}`, ensureSlash(this.#serverUrl));
  }

  async #request(url: URL, input: { method?: string; body?: unknown } = {}): Promise<{ ok: boolean; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method: input.method ?? "GET", redirect: "error", signal: controller.signal,
        headers: input.body === undefined ? undefined : { "content-type": "application/json" },
        body: input.body === undefined ? undefined : JSON.stringify(input.body)
      });
      const lengthHeader = response.headers.get("content-length");
      const length = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : 0;
      if (length > this.#maxResponseBytes) {
        controller.abort();
        await response.body?.cancel().catch(() => {});
        throw new AppiumClientError("Appium response exceeds limit");
      }
      const text = await readBoundedText(response, this.#maxResponseBytes, controller);
      let body: unknown;
      try { body = text ? JSON.parse(text) : null; } catch { throw new AppiumClientError("Appium returned invalid JSON"); }
      return { ok: response.ok, body };
    } catch (error) {
      if (error instanceof AppiumClientError) throw error;
      throw new AppiumClientError("Appium request failed", input.method === "POST" && url.pathname.endsWith("/session"));
    } finally { clearTimeout(timer); }
  }
}

async function readBoundedText(response: Response, maxBytes: number, controller: AbortController): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        controller.abort();
        await reader.cancel().catch(() => {});
        throw new AppiumClientError("Appium response exceeds limit");
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes));
  } finally {
    reader.releaseLock();
  }
}

export function createAppiumClient(config: AppiumDeviceConfig): AppiumClient { return new AppiumClient(config); }

function localHttpUrl(value: string, label: string, allowBasePath: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`invalid ${label}`); }
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || url.username || url.password || url.search || url.hash || (!allowBasePath && url.pathname !== "/status")) throw new Error(`${label} must use a configured loopback HTTP endpoint`);
  if (allowBasePath && !/^\/(?:wd\/hub)?\/?$/.test(url.pathname)) throw new Error("Appium URL may only include the standard /wd/hub base path");
  return url;
}
function ensureSlash(url: URL): URL { const copy = new URL(url); if (!copy.pathname.endsWith("/")) copy.pathname += "/"; return copy; }
function readyFlag(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const value = (body as Record<string, unknown>).value;
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).ready === true);
}
function unwrap(body: unknown): unknown { return body && typeof body === "object" && "value" in body ? (body as { value: unknown }).value : undefined; }
function sessionFrom(body: unknown): AppiumSession | undefined {
  if (!body || typeof body !== "object") return undefined;
  const row = body as Record<string, unknown>;
  const value = row.value && typeof row.value === "object" ? row.value as Record<string, unknown> : row;
  const sessionId = value.sessionId ?? row.sessionId;
  const capabilities = value.capabilities ?? row.capabilities;
  return typeof sessionId === "string" && capabilities && typeof capabilities === "object"
    ? { sessionId, capabilities: capabilities as Record<string, unknown> } : undefined;
}
function elementIdsFrom(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const row = body as Record<string, unknown>;
  if (!Array.isArray(row.value)) return [];
  return row.value.map((item) => {
    if (!item || typeof item !== "object") return "";
    const value = item as Record<string, unknown>;
    const id = value["element-6066-11e4-a52e-4f735466cecf"] ?? value.ELEMENT;
    return typeof id === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(id) ? id : "";
  });
}
function validDeviceId(value: string): boolean { return typeof value === "string" && value.length <= 256 && value.trim() === value && /^[\w:.-]+$/.test(value); }
function validDeviceName(value: string): boolean { return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value); }
function validObservedLabel(value: string): boolean { return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f]/.test(value); }
