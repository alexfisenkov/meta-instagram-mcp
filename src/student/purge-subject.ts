#!/usr/bin/env node
import { join, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { assertPrivateFile } from "../private-fs.js";
import { loadStudentVaultConfig } from "./config.js";
import { BrokerError, sameSubject, type Subject } from "./types.js";
import { StudentVault } from "./vault.js";
import { purgeReadConnections } from "./connections-store.js";

/** Offline owner operation. Acquires the same exclusive process lock as the service. */
export async function purgeStudentSubject(directory: string, key: Buffer, subject: Subject) {
  if (subject.tenantId !== "masterskaya" || !/^[A-Za-z0-9_-]{1,128}$/.test(subject.sub)) throw new BrokerError("invalid_purge_subject");
  await assertPrivateFile(join(directory, "vault.json")); // A wrong path must not create a pretend successful empty vault.
  let youtubeDirectory: string | undefined;
  try { const info = await lstat(join(directory, "youtube")); if (!info.isDirectory() || info.isSymbolicLink()) throw new BrokerError("vault_integrity_failed"); youtubeDirectory = join(directory, "youtube"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (youtubeDirectory) await assertPrivateFile(join(youtubeDirectory, "vault.json"));
  let connectionsDirectory: string | undefined;
  try {
    const path = join(directory, "connections"), info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new BrokerError("vault_integrity_failed");
    await assertPrivateFile(join(path, "vault.json")); connectionsDirectory = path;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const purgeVault = async (vaultDirectory: string) => {
    const vault = await StudentVault.open(vaultDirectory, key);
    try { return await vault.transaction((db) => {
      const ownedConnectionIds = new Set(db.connections.filter((connection) => sameSubject(connection, subject)).map((connection) => connection.id));
      const counts = { connections: ownedConnectionIds.size, grants: db.grants.filter((grant) => sameSubject(grant, subject)).length, events: db.events.filter((event) => ownedConnectionIds.has(event.connectionId)).length, states: db.states.filter((state) => sameSubject(state, subject)).length, generations: 0 };
      db.connections = db.connections.filter((connection) => !sameSubject(connection, subject));
      if (db.replyAttempts) db.replyAttempts = db.replyAttempts.filter((attempt) => !sameSubject(attempt, subject));
      db.grants = db.grants.filter((grant) => !sameSubject(grant, subject));
      db.events = db.events.filter((event) => !ownedConnectionIds.has(event.connectionId));
      db.states = db.states.filter((state) => !sameSubject(state, subject));
      db.generations = Object.fromEntries(Object.entries(db.generations).filter(([key]) => {
        let binding; try { binding = JSON.parse(key); } catch { return true; }
        if (Array.isArray(binding) && binding[0] === subject.tenantId && binding[1] === subject.sub) { counts.generations++; return false; } return true;
      }));
      return counts;
    }, { allowUncertain: true });
    } finally { await vault.close(); }
  };
  const totals = await purgeVault(directory);
  if (youtubeDirectory) {
    const youtube = await purgeVault(youtubeDirectory);
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += youtube[key];
  }
  if (connectionsDirectory) {
    const connections = await StudentVault.open(connectionsDirectory, key);
    try {
      const counts = await purgeReadConnections(connections, subject);
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += counts[key];
    } finally { await connections.close(); }
  }
  return totals;
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
    const allowed = ["writer_locked", "purge_confirmation_required", "invalid_purge_subject", "missing_broker_config", "invalid_broker_key", "vault_commit_uncertain", "vault_changed"];
    const code = error instanceof BrokerError && allowed.includes(error.code) ? error.code : "purge_failed";
    process.stderr.write(JSON.stringify({ error: code }) + "\n"); process.exitCode = 1;
  } finally { vaultKey?.fill(0); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await run();
