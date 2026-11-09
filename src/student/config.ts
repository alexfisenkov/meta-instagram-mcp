import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import { assertOutsideDirectory } from "../private-fs.js";
import { StudentRegistry } from "./registry.js";
import { BrokerError } from "./types.js";
import { validateLegal } from "./legal.js";
function key(value: string | undefined, exact = false): Buffer {
  if (!value || value.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new BrokerError("missing_broker_config");
  const decoded = Buffer.from(value, "base64"); if ((exact ? decoded.length !== 32 : decoded.length < 32) || decoded.toString("base64") !== value) throw new BrokerError("invalid_broker_key"); return decoded;
}
export function loadStudentVaultConfig(env: NodeJS.ProcessEnv) {
  const directory = env.META_BROKER_STATE_DIR;
  if (!directory || !isAbsolute(directory)) throw new BrokerError("missing_broker_config");
  assertOutsideDirectory(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), directory, "broker_state_must_be_external");
  return { directory, vaultKey: key(env.META_BROKER_VAULT_KEY, true) };
}
export async function loadStudentConfig(env: NodeJS.ProcessEnv) {
  const serviceKey = env.META_BROKER_SERVICE_TOKEN, platformOrigin = env.META_BROKER_PLATFORM_ORIGIN, callbackUrl = env.META_BROKER_CALLBACK_URL;
  if (!serviceKey || serviceKey.length < 32 || !platformOrigin || !callbackUrl) throw new BrokerError("missing_broker_config");
  const { directory, vaultKey } = loadStudentVaultConfig(env), subjectKey = key(env.META_BROKER_SUBJECT_KEY);
  if (subjectKey.equals(vaultKey) || serviceKey === env.META_BROKER_SUBJECT_KEY || serviceKey === env.META_BROKER_VAULT_KEY) throw new BrokerError("broker_keys_must_differ");
  const port = Number(env.META_BROKER_PORT ?? "8788"); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BrokerError("invalid_broker_port");
  const refreshIntervalMs = Number(env.META_BROKER_REFRESH_INTERVAL_MS ?? "60000"); if (!Number.isInteger(refreshIntervalMs) || refreshIntervalMs < 1000 || refreshIntervalMs > 3_600_000) throw new BrokerError("invalid_refresh_interval");
  const registry = await StudentRegistry.load(env.META_BROKER_CONFIG_FILE, callbackUrl, env);
  const legal = env.META_BROKER_OPERATOR_NAME && env.META_BROKER_PRIVACY_CONTACT ? validateLegal({ operatorName: env.META_BROKER_OPERATOR_NAME, privacyContact: env.META_BROKER_PRIVACY_CONTACT }) : undefined;
  return { auth: { serviceToken: serviceKey, subjectKey }, vaultKey, directory, platformOrigin, registry, port, refreshIntervalMs, legal };
}
