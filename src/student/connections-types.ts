import { z } from "zod";
import type { Subject } from "./types.js";
export const connectionProducts = ["twitch", "linkedin", "google_business_profile", "x"] as const;
export type ConnectionProduct = typeof connectionProducts[number];
export const connectionReadSchema = z.object({ connectionId: z.string().uuid(), operation: z.enum(["account", "posts", "metrics"]), limit: z.number().int().min(1).max(50).default(20) }).strict();
export type ConnectionRead = z.infer<typeof connectionReadSchema>;
export type ConnectionCapability = ConnectionRead["operation"];
export interface ConnectionConfig {
  product: ConnectionProduct; clientId: string; clientSecret: string; callbackUrl: string;
  admission: "disabled" | "test" | "live"; testSubjects: string[]; scopes: string[];
  apiVersion?: string; billingApproved: boolean;
}
export interface ConnectionGrant extends Subject {
  id: string; product: ConnectionProduct; actorId: string; accessToken: string; refreshToken?: string;
  scopes: string[]; expiresAt: number; refreshExpiresAt?: number; fingerprint: string;
  status: "active" | "reauth_required" | "disconnected"; validatedAt: number;
}
export interface ConnectionResource extends Subject {
  id: string; grantId: string; product: ConnectionProduct; providerId: string; parentId?: string;
  kind: "account" | "person" | "organization" | "location"; label: string;
  capabilities: ConnectionCapability[]; status: "connected" | "reauth_required" | "disconnected";
  lastSuccessAt?: string; reason?: string; blockedOperations?: ConnectionCapability[];
}
export interface ConnectionState extends Subject {
  hash: string; product: ConnectionProduct; expiresAt: number; codeVerifier: string; fingerprint: string;
  generation: number; expectedActorId?: string; expectedProviderId?: string; connectionId?: string;
}
export interface ConnectionsData { grants: ConnectionGrant[]; resources: ConnectionResource[]; states: ConnectionState[]; generations: Record<string, number> }
export interface DiscoveredResource { providerId: string; parentId?: string; kind: ConnectionResource["kind"]; label: string; capabilities: ConnectionCapability[] }
export interface ConnectionIdentity { actorId: string; resources: DiscoveredResource[]; validatedScopes?: string[]; expiresIn?: number }
