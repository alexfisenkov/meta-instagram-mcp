#!/usr/bin/env node
import { isAbsolute, join, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { assertPrivateFile } from "../private-fs.js";
import { loadStudentVaultConfig } from "./config.js";
import { BrokerError, sameSubject, type Subject } from "./types.js";
import { StudentVault } from "./vault.js";
import { purgeReadConnections } from "./connections-store.js";
import { purgePublishingSubject, type PublishingPurgeReport } from "./publishing-purge.js";

/** Offline owner operation. The main service lock stays held from preflight through every namespace. */
export async function purgeStudentSubject(directory: string, key: Buffer, subject: Subject): Promise<PublishingPurgeReport> {
  if (subject.tenantId !== "masterskaya" || !/^[A-Za-z0-9_-]{1,128}$/.test(subject.sub)) throw new BrokerError("invalid_purge_subject");
  if (!isAbsolute(directory)) throw new BrokerError("invalid_purge_directory");
  await assertPrivateFile(join(directory, "vault.json")); // A wrong path must not create a pretend successful empty vault.
  const main = await StudentVault.open(directory, key), opened: StudentVault[] = [main];
  let mutationStarted = false;
  try {
    const optional = async (name: string) => {
      const path = join(directory, name);
      try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new BrokerError("vault_integrity_failed"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
      let persisted = true;
      try { await assertPrivateFile(join(path, "vault.json")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") persisted = false; else throw error; }
      const vault = await StudentVault.open(path, key); opened.push(vault);
      await vault.snapshot(); // Decrypt/verify every existing namespace before any records or cache files change.
      return { vault, persisted };
    };
    const youtube = await optional("youtube"), connections = await optional("connections"), publishing = await optional("publishing");
    const totals: PublishingPurgeReport = { connections: 0, grants: 0, events: 0, states: 0, generations: 0 };
    const add = (counts: PublishingPurgeReport) => {
      for (const field of ["connections", "grants", "events", "states", "generations"] as const) totals[field] += counts[field];
      if (counts.deliveries !== undefined) totals.deliveries = (totals.deliveries ?? 0) + counts.deliveries;
      if (counts.mediaCacheFiles !== undefined) totals.mediaCacheFiles = (totals.mediaCacheFiles ?? 0) + counts.mediaCacheFiles;
    };
    if (publishing) {
      // Its standalone helper owns the publication lock; retain the main service lock during this handoff.
      await publishing.vault.close(); opened.splice(opened.indexOf(publishing.vault), 1);
      mutationStarted = true;
      add(await purgePublishingSubject(directory, key, subject));
    }
    mutationStarted = true;
    add(await purgeLegacyVault(main, subject));
    if (youtube?.persisted) add(await purgeLegacyVault(youtube.vault, subject));
    if (connections?.persisted) add(await purgeReadConnections(connections.vault, subject));
    return totals;
  } catch (error) {
    // Independent durable stores are not a distributed transaction. A failed run has no success receipt.
    if (mutationStarted) throw new BrokerError("purge_incomplete");
    throw error;
  } finally {
    let closeFailed = false;
    for (const vault of opened.reverse()) { try { await vault.close(); } catch { closeFailed = true; } }
    if (closeFailed) throw new BrokerError("purge_incomplete");
  }
}
function purgeLegacyVault(vault: StudentVault, subject: Subject) {
  return vault.transaction(db => {
    const ownedConnectionIds = new Set(db.connections.filter(connection => sameSubject(connection, subject)).map(connection => connection.id));
    const counts = { connections: ownedConnectionIds.size, grants: db.grants.filter(grant => sameSubject(grant, subject)).length, events: db.events.filter(event => ownedConnectionIds.has(event.connectionId)).length, states: db.states.filter(state => sameSubject(state, subject)).length, generations: 0 };
    db.connections = db.connections.filter(connection => !sameSubject(connection, subject));
    if (db.replyAttempts) db.replyAttempts = db.replyAttempts.filter(attempt => !sameSubject(attempt, subject));
    db.grants = db.grants.filter(grant => !sameSubject(grant, subject));
    db.events = db.events.filter(event => !ownedConnectionIds.has(event.connectionId));
    db.states = db.states.filter(state => !sameSubject(state, subject));
    db.generations = Object.fromEntries(Object.entries(db.generations).filter(([key]) => {
      let binding; try { binding = JSON.parse(key); } catch { return true; }
      if (Array.isArray(binding) && binding[0] === subject.tenantId && binding[1] === subject.sub) { counts.generations++; return false; } return true;
    }));
    return counts;
  }, { allowUncertain: true });
}

async function run(): Promise<void> {
  let vaultKey: Buffer | undefined;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3 || args[0] !== "--subject" || args[2] !== "--confirm-purge") throw new BrokerError("purge_confirmation_required");
    const config = loadStudentVaultConfig(process.env); vaultKey = config.vaultKey;
    const counts = await purgeStudentSubject(config.directory, vaultKey, { tenantId: "masterskaya", sub: args[1] });
    process.stdout.write(JSON.stringify(counts) + "\n");
  } catch (error) {
    const allowed = ["writer_locked", "purge_confirmation_required", "invalid_purge_subject", "missing_broker_config", "invalid_broker_key", "vault_commit_uncertain", "vault_changed", "purge_incomplete", "invalid_purge_directory"];
    const code = error instanceof BrokerError && allowed.includes(error.code) ? error.code : "purge_failed";
    process.stderr.write(JSON.stringify({ error: code }) + "\n"); process.exitCode = 1;
  } finally { vaultKey?.fill(0); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
