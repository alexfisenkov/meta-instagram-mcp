import type { Connection, Credential, Operation, Product, ProductConfig, ReadInput } from "./types.js";
export interface DiscoveredAsset { product: Product; providerId: string; label: string; capabilities: Operation[]; parentId?: string }
export interface ExchangedGrant extends Credential { providerUserId: string; clientBusinessId?: string; scopes: string[]; expiresAt?: number; assets: DiscoveredAsset[] }
export interface ProviderRead { data: unknown; coverage: "partial" | "complete" | "unknown"; limitations: string[] }
export interface ProviderAdapter {
  exchange(config: ProductConfig, code: string, codeVerifier?: string): Promise<ExchangedGrant>;
  read(config: ProductConfig, connection: Connection, credential: Credential, input: ReadInput): Promise<ProviderRead>;
  refresh?(config: ProductConfig, credential: Credential, expectedUserId?: string, expectedScopes?: string[]): Promise<Credential & { expiresAt: number; scopes?: string[] }>;
}
