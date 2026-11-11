import { StudentVault } from "./vault.js";
import type { Database, Subject } from "./types.js";
import type { Delivery, PublishProduct } from "./publishing-types.js";
export interface PublishingConnection extends Subject {
    id: string;
    product: Exclude<PublishProduct, "instagram">;
    providerId: string;
    label: string;
    scopes: string[];
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    status: "connected" | "disconnected";
    configFingerprint: string;
}
export interface PublishingOAuthState extends Subject {
    hash: string;
    product: PublishingConnection["product"];
    expiresAt: number;
    codeVerifier: string;
    fingerprint: string;
    generation: number;
    expectedProviderId?: string;
    connectionId?: string;
}
export interface PublishingData {
    deliveries: Delivery[];
    connections: PublishingConnection[];
    states: PublishingOAuthState[];
    generations: Record<string, number>;
}
type StoreDatabase = Database & {
    publishing?: PublishingData;
};
/** A separate encrypted vault directory: legacy vault schema/readers never see new products. */
export class PublishingStore {
    constructor(readonly vault: StudentVault) {
    }
    async snapshot(): Promise<PublishingData> {
        return structuredClone((await this.vault.snapshot() as StoreDatabase).publishing ?? { deliveries: [], connections: [], states: [], generations: {} });
    }
    transaction<T>(change: (data: PublishingData) => T | Promise<T>): Promise<T> {
        return this.vault.transaction(db => {
            const data = db as StoreDatabase;
            data.publishing ??= { deliveries: [], connections: [], states: [], generations: {} };
            return change(data.publishing);
        });
    }
}
