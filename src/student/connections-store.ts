import { StudentVault } from "./vault.js";
import type { Database } from "./types.js";
import type { ConnectionsData } from "./connections-types.js";
type ConnectionsDatabase = Database & { readConnections?: ConnectionsData };
/** Open in a separate `connections` directory. Older readers never see these products. */
export class ConnectionsStore {
  constructor(readonly vault: StudentVault) {}
  async snapshot(): Promise<ConnectionsData> { return structuredClone((await this.vault.snapshot() as ConnectionsDatabase).readConnections ?? { grants: [], resources: [], states: [], generations: {} }); }
  transaction<T>(change: (data: ConnectionsData) => T | Promise<T>): Promise<T> {
    return this.vault.transaction(db => {
      const data = db as ConnectionsDatabase;
      data.readConnections ??= { grants: [], resources: [], states: [], generations: {} };
      return change(data.readConnections);
    });
  }
}
/** Offline privacy operation, under the same exclusive vault lock. No provider revocation. */
export function purgeReadConnections(vault: StudentVault, subject: import("./types.js").Subject) {
  return vault.transaction(db => {
    const data = (db as ConnectionsDatabase).readConnections;
    const counts = { connections: 0, grants: 0, states: 0, generations: 0, events: 0 };
    if (!data) return counts;
    const owned = (row: import("./types.js").Subject) => row.tenantId === subject.tenantId && row.sub === subject.sub;
    counts.connections = data.resources.filter(owned).length; counts.grants = data.grants.filter(owned).length; counts.states = data.states.filter(owned).length;
    data.resources = data.resources.filter(row => !owned(row)); data.grants = data.grants.filter(row => !owned(row)); data.states = data.states.filter(row => !owned(row));
    data.generations = Object.fromEntries(Object.entries(data.generations).filter(([key]) => {
      let parts: unknown; try { parts = JSON.parse(key); } catch { return true; }
      if (Array.isArray(parts) && parts[0] === subject.tenantId && parts[1] === subject.sub) { counts.generations++; return false; } return true;
    }));
    return counts;
  }, { allowUncertain: true });
}
