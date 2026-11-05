import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { assertPrivateFile } from "./private-fs.js";

export interface OperationalContext {
  status: "configured" | "unknown";
  verification: "configuration_only";
  privacyPolicyUrl?: string;
  dataDeletionUrl?: string;
  deletionWorkflow: "manual" | "unknown";
}

/** Strict public projection; unknown keys and any read/parse failure are never returned. */
export async function readOperationalContext(tokenStorePath: string): Promise<OperationalContext> {
  const result: OperationalContext = { status: "unknown", verification: "configuration_only", deletionWorkflow: "unknown" };
  try {
    const path = join(dirname(tokenStorePath), "operational-context.json");
    await assertPrivateFile(path);
    if ((await stat(path)).size > 16_384) return result;
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    return projectOperationalContext(raw);
  } catch { /* External configuration is optional, private and never a live verification. */ }
  return result;
}

/** Also used by the operator doctor when projecting a remote status response. */
export function projectOperationalContext(raw: unknown): OperationalContext {
  const result: OperationalContext = { status: "unknown", verification: "configuration_only", deletionWorkflow: "unknown" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return result;
  const context = raw as Record<string, unknown>;
  const privacy = publicLegalUrl(context.privacyPolicyUrl, "privacy");
  const deletion = publicLegalUrl(context.dataDeletionUrl, "deletion");
  if (privacy) result.privacyPolicyUrl = privacy;
  if (deletion) result.dataDeletionUrl = deletion;
  if (context.deletionWorkflow === "manual") result.deletionWorkflow = "manual";
  if (privacy || deletion || result.deletionWorkflow === "manual") result.status = "configured";
  return result;
}

function publicLegalUrl(value: unknown, purpose: "privacy" | "deletion"): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || /[\s\\%?#@]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port
      || isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") || !/^[a-z\d.-]+$/.test(host)
      || /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|onion)$/.test(host)
      || /(?:^|\.)(?:accounts?|admin|dashboard|developers?|business|console)\./.test(host)) return undefined;
    const path = url.pathname.toLowerCase();
    if (!/^[a-z\d/_-]+$/.test(path) || /(?:^|\/)(?:accounts?|admin|dashboard|console|settings|oauth|login|auth|profiles?|users?|contact)(?:\/|$)/.test(path)) return undefined;
    const legalPath = purpose === "privacy" ? /(?:^|[\/_-])privacy(?:[-_]policy)?(?:\/|$)/ : /(?:^|[\/_-])(?:data[-_]deletion(?:[-_]instructions)?|delete[-_]data|deletion)(?:\/|$)/;
    return legalPath.test(path) ? url.toString() : undefined;
  } catch { return undefined; }
}
