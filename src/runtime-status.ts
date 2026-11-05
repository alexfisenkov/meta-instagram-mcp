import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimeStatus {
  packageVersion: string;
  sourceRevision: string;
  revisionSource: "installer_stamp" | "server_version" | "unknown";
  capturedAt: string;
  integrity: "not_verified";
}

/** Startup identity from local release markers, not a claim that the working tree is pristine. */
export function captureRuntimeStatus(root = dirname(dirname(fileURLToPath(import.meta.url)))): Readonly<RuntimeStatus> {
  let packageVersion = "unknown";
  let sourceRevision = "unknown";
  let revisionSource: RuntimeStatus["revisionSource"] = "unknown";
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (isRecord(pkg) && typeof pkg.version === "string" && /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(pkg.version)) packageVersion = pkg.version;
    if (packageVersion !== "unknown") {
      const stampPath = join(root, ".meta-instagram-mcp-install.json");
      const serverPath = join(root, ".VERSION");
      const serverRevision = existsSync(serverPath) ? readFileSync(serverPath, "utf8").trim() : undefined;
      if (existsSync(stampPath)) {
        const stamp: unknown = JSON.parse(readFileSync(stampPath, "utf8"));
        if (isRecord(stamp) && stamp.version === packageVersion && isRevision(stamp.revision)
          && validInstalledAt(stamp.installedAt)
          && (serverRevision === undefined || (isRevision(serverRevision) && serverRevision.toLowerCase() === stamp.revision.toLowerCase()))) {
          sourceRevision = stamp.revision.toLowerCase(); revisionSource = "installer_stamp";
        }
      } else if (isRevision(serverRevision)) {
        sourceRevision = serverRevision.toLowerCase(); revisionSource = "server_version";
      }
    }
  } catch { /* Unknown or incompatible provenance stays unknown without leaking local paths. */ }
  return Object.freeze({ packageVersion, sourceRevision, revisionSource, capturedAt: new Date().toISOString(), integrity: "not_verified" });
}

function isRevision(value: unknown): value is string { return typeof value === "string" && /^[a-f\d]{40}$/i.test(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validInstalledAt(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(?:\d{3}|\d{7})Z$/.test(value)) return false;
  const milliseconds = value.replace(/(\.\d{3})\d{4}Z$/, "$1Z");
  return Number.isFinite(Date.parse(milliseconds)) && new Date(milliseconds).toISOString() === milliseconds;
}
