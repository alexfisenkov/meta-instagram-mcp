#!/usr/bin/env node
import { loadStudentConfig } from "./student/config.js";
import { StudentVault } from "./student/vault.js";
import { StudentBroker } from "./student/broker.js";
import { MetaStudentProvider } from "./student/meta-provider.js";
import { startStudentServer } from "./student/http.js";
import { GrantLifecycle } from "./student/grant-lifecycle.js";
import { join } from "node:path";
import type { CallbackAuditEvent, ReadAuditEvent } from "./student/types.js";

try {
  const config = await loadStudentConfig(process.env);
  let vault: StudentVault | undefined, youtubeVault: StudentVault | undefined;
  try {
    vault = await StudentVault.open(config.directory, config.vaultKey);
    if (config.registry.get("youtube")) youtubeVault = await StudentVault.open(join(config.directory, "youtube"), config.vaultKey);
  } catch (error) {
    await Promise.allSettled([youtubeVault?.close(), vault?.close()].filter((value): value is Promise<void> => value !== undefined));
    throw error;
  } finally { config.vaultKey.fill(0); }
  if (!vault) throw new Error("meta_vault_unavailable");
  let lifecycle: GrantLifecycle | undefined, youtubeLifecycle: GrantLifecycle | undefined;
  let server: Awaited<ReturnType<typeof startStudentServer>> | undefined;
  let closing: Promise<void> | undefined;
  const closeResources = async () => {
    try { await server?.close(); } finally {
      try { await lifecycle?.stop(); } finally {
        try { await youtubeLifecycle?.stop(); } finally {
          await Promise.allSettled([youtubeVault?.close(), vault!.close()].filter((value): value is Promise<void> => value !== undefined));
        }
      }
    }
  };
  try {
    const audit = (event: CallbackAuditEvent | ReadAuditEvent) => { process.stderr.write(JSON.stringify(event) + "\n"); };
    const provider = new MetaStudentProvider(); const broker = new StudentBroker(vault, config.registry, provider, config.platformOrigin, Date.now, audit, audit);
    lifecycle = new GrantLifecycle(vault, config.registry, provider); await lifecycle.tick();
    const youtubeBroker = youtubeVault ? new StudentBroker(youtubeVault, config.registry, provider, config.platformOrigin, Date.now, audit, audit) : undefined;
    youtubeLifecycle = youtubeVault ? new GrantLifecycle(youtubeVault, config.registry, provider) : undefined;
    if (youtubeLifecycle) await youtubeLifecycle.tick();
    server = await startStudentServer({ ...config, broker, youtubeBroker, vault }); lifecycle.start(config.refreshIntervalMs); youtubeLifecycle?.start(config.refreshIntervalMs);
    const close = () => closing ??= closeResources();
    process.once("SIGINT", () => { void close(); }); process.once("SIGTERM", () => { void close(); });
    process.stderr.write(JSON.stringify({ event: "student_broker_started", transport: "loopback_http" }) + "\n");
  } catch (error) { try { await closeResources(); } catch { /* Preserve the startup failure while attempting every resource release. */ } throw error; }
} catch { process.stderr.write('{"event":"student_broker_start_failed"}\n'); process.exitCode = 1; }
