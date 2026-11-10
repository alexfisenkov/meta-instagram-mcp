export const META_PRODUCTS = ["instagram", "facebook", "messenger", "threads", "ads", "whatsapp"] as const;
export const PRODUCTS = [...META_PRODUCTS, "youtube"] as const;
export const STUDENT_BROKER_CAPABILITIES = ["youtube_oauth_readonly_v1"] as const;
export type Product = typeof PRODUCTS[number];
export type Provider = "instagram_unified" | "instagram_login" | "facebook_business" | "threads" | "youtube";
export type Operation = "account" | "posts" | "metrics" | "comments" | "inbox";
export interface Subject { tenantId: string; sub: string }
export interface Sealed { iv: string; tag: string; ciphertext: string }
export interface Grant extends Subject { id: string; provider: Provider; configKey: string; fingerprint: string; clientBusinessId?: string; providerUserId: string; scopes: string[]; expiresAt?: number; refreshedAt?: number; status: "active" | "revoked" | "reauth_required"; credential: Sealed; createdAt: string }
export interface Credential { accessToken: string; assetTokens: Record<string, string>; refreshToken?: string }
export interface Connection extends Subject { id: string; grantId: string; product: Product; providerId: string; label: string; capabilities: Operation[]; status: "connected" | "reauth_required" | "disconnected" | "error"; updatedAt: string; reason?: string; parentId?: string }
export interface OAuthState extends Subject { hash: string; product: Product; provider: Provider; configKey: string; fingerprint: string; expiresAt: number; returnTarget: string; generation: number; codeVerifier?: string }
export interface StoredEvent { connectionId: string; eventId: string; receivedAt: string; data: Record<string, unknown> }
export interface Database { version: 1; revision: number; grants: Grant[]; connections: Connection[]; states: OAuthState[]; events: StoredEvent[]; generations: Record<string, number> }
export interface ProductConfig { product: Product; key: string; provider: Provider; appId: string; appSecret: string; configId?: string; apiVersion: string; callbackUrl: string; admission: "disabled" | "test" | "live"; testSubjects: string[]; webhookVerifyToken?: string }
export interface ReadInput { connectionId: string; operation: Operation; limit?: number; cursor?: string; mediaId?: string }
export type CallbackAuditStage = "state_validation" | "callback_validation" | "token_exchange" | "token_short_exchange" | "token_long_exchange" | "app_token_exchange" | "token_refresh" | "token_inspection" | "account_identity" | "asset_discovery" | "api_request" | "grant_validation" | "grant_persist";
export interface ProviderDiagnostic { stage: CallbackAuditStage; status?: number; metaCode?: number; metaSubcode?: number }
export interface CallbackAuditEvent { event: "student_oauth_callback"; stage: CallbackAuditStage; product: Product; outcome: "connected" | "cancelled" | "error"; reason: string; hasCode: boolean; hasProviderError: boolean; status?: number; metaCode?: number; metaSubcode?: number }
export type CallbackAuditSink = (event: CallbackAuditEvent) => void;
export interface ReadAuditEvent { event: "student_connection_read_error"; product: Product; operation: Operation; reason: string; status?: number; metaCode?: number; metaSubcode?: number }
export type ReadAuditSink = (event: ReadAuditEvent) => void;
export class BrokerError extends Error {
  constructor(public readonly code: string, public readonly diagnostic?: ProviderDiagnostic) { super(code); this.name = "BrokerError"; }
}
export function sameSubject(a: Subject, b: Subject): boolean { return a.tenantId === b.tenantId && a.sub === b.sub; }
