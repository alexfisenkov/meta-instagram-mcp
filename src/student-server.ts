#!/usr/bin/env node
import { loadStudentConfig } from "./student/config.js";
import { StudentVault } from "./student/vault.js";
import { StudentBroker } from "./student/broker.js";
import { MetaStudentProvider } from "./student/meta-provider.js";
import { startStudentServer } from "./student/http.js";
import { GrantLifecycle } from "./student/grant-lifecycle.js";
import { join } from "node:path";

try {
  const config = await loadStudentConfig(process.env); const vault = await StudentVault.open(config.directory, config.vaultKey);
  const youtubeVault = config.registry.get("youtube") ? await StudentVault.open(join(config.directory, "youtube"), config.vaultKey) : undefined;
  config.vaultKey.fill(0);
  try {
    const provider = new MetaStudentProvider(); const broker = new StudentBroker(vault, config.registry, provider, config.platformOrigin, Date.now, (event) => process.stderr.write(JSON.stringify(event) + "\n"));
    const lifecycle = new GrantLifecycle(vault, config.registry, provider); await lifecycle.tick();
    const youtubeBroker = youtubeVault ? new StudentBroker(youtubeVault, config.registry, provider, config.platformOrigin, Date.now, (event) => process.stderr.write(JSON.stringify(event) + "\n")) : undefined;
    const youtubeLifecycle = youtubeVault ? new GrantLifecycle(youtubeVault, config.registry, provider) : undefined;
    if (youtubeLifecycle) await youtubeLifecycle.tick();
    const server = await startStudentServer({ ...config, broker, youtubeBroker, vault }); lifecycle.start(config.refreshIntervalMs); youtubeLifecycle?.start(config.refreshIntervalMs);
    let closing: Promise<void> | undefined;
    const close = () => closing ??= server.close().then(() => lifecycle.stop()).then(() => youtubeLifecycle?.stop()).then(async () => { await youtubeVault?.close(); await vault.close(); });
    process.once("SIGINT", () => { void close(); }); process.once("SIGTERM", () => { void close(); });
    process.stderr.write(JSON.stringify({ event: "student_broker_started", transport: "loopback_http" }) + "\n");
  } catch (error) { await youtubeVault?.close(); await vault.close(); throw error; }
} catch { process.stderr.write('{"event":"student_broker_start_failed"}\n'); process.exitCode = 1; }
