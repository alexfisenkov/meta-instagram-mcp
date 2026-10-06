import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type UiWriteOperation = "message.send" | "message.react" | "message.unreact" | "comment.reply" |
  "comment.private_reply" | "comment.hide" | "comment.show" | "comment.delete" | "comment.like" | "comment.unlike";

export interface UiApprovalTask {
  id: string; bridgeId: string; kind: "read" | "preview" | "write"; source: "browser" | "phone";
  operation: string; accountBinding: string; targetRefs: Array<Record<string, string>>;
  payload: Readonly<Record<string, unknown>>; expiresAt: string; contextHash?: string;
  requestId?: string; fingerprint?: string;
}

export interface UiApprovalClaims {
  version: 1; taskId: string; bridgeId: string; source: "browser" | "phone"; accountBinding: string;
  operation: UiWriteOperation; target: Record<string, string>; payloadHash: string;
  contextHash: string; requestId: string; fingerprint: string; expiresAt: string;
}

export interface SignedUiApproval { claims: UiApprovalClaims; signature: string }
export interface UiApprovalAuthority { readonly publicKey: string; sign(task: UiApprovalTask): SignedUiApproval }
export interface UiApprovalAuthorityOptions { privateKeyPath: string; projectRoot?: string }
export interface UiApprovalVerifyOptions { bridgeId: string; source: "browser" | "phone"; now?: number }

const WRITE_OPERATIONS = new Set<UiWriteOperation>([
  "message.send", "message.react", "message.unreact", "comment.reply", "comment.private_reply",
  "comment.hide", "comment.show", "comment.delete", "comment.like", "comment.unlike"
]);

/** Loads or creates a private Ed25519 signing key outside the install tree. */
export async function createUiApprovalAuthority(options: UiApprovalAuthorityOptions): Promise<UiApprovalAuthority> {
  const keyPath = resolve(options.privateKeyPath);
  if (!isAbsolute(options.privateKeyPath)) throw new Error("UI approval key path must be absolute");
  const projectRoot = resolve(options.projectRoot ?? defaultProjectRoot());
  const relativePath = relative(projectRoot, keyPath);
  if (relativePath === ".." || !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("UI approval key must be outside the project directory");
  }
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  let record = await readKeyRecord(keyPath);
  if (!record) {
    const pair = generateKeyPairSync("ed25519");
    const generated: KeyRecord = {
      version: 1,
      privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString()
    };
    const handle = await open(keyPath, "wx", 0o600).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      return undefined;
    });
    if (handle) {
      try { await handle.writeFile(`${JSON.stringify(generated)}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await chmod(keyPath, 0o600);
      record = generated;
    } else record = await readKeyRecord(keyPath);
  }
  if (!record) throw new Error("UI approval key could not be initialized");
  const privateKey = record.privateKey;
  return {
    publicKey: record.publicKey,
    sign(task) {
      const claims = claimsFor(task);
      const bytes = Buffer.from(stableStringify(claims), "utf8");
      return { claims, signature: sign(null, bytes, privateKey).toString("base64url") };
    }
  };
}

/** Verifies the signed one-shot approval against the exact task that will reach a UI executor. */
export function verifyUiApproval(task: UiApprovalTask, grant: SignedUiApproval | undefined, publicKey: string,
  options: UiApprovalVerifyOptions): boolean {
  try {
    if (!grant || !publicKey || task.kind !== "write" || task.bridgeId !== options.bridgeId || task.source !== options.source) return false;
    const expected = claimsFor(task);
    if (stableStringify(grant.claims) !== stableStringify(expected)) return false;
    const now = options.now ?? Date.now();
    const expiry = Date.parse(expected.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now || expiry - now > 30_000) return false;
    return verify(null, Buffer.from(stableStringify(expected), "utf8"), publicKey, Buffer.from(grant.signature, "base64url"));
  } catch { return false; }
}

export function approvalPayloadHash(payload: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(stableStringify(payload), "utf8").digest("hex");
}

function claimsFor(task: UiApprovalTask): UiApprovalClaims {
  if (task.kind !== "write" || !WRITE_OPERATIONS.has(task.operation as UiWriteOperation) ||
      !/^[\w-]{16,128}$/.test(task.id) || !/^[\w-]{16,128}$/.test(task.bridgeId) ||
      !/^[a-zA-Z0-9:_-]{1,128}$/.test(task.accountBinding) || !/^[\w-]{16,128}$/.test(task.requestId ?? "") ||
      !/^[a-f0-9]{64}$/i.test(task.fingerprint ?? "") || !/^[a-f0-9]{16,128}$/i.test(task.contextHash ?? "") ||
      !Array.isArray(task.targetRefs) || task.targetRefs.length !== 1) throw new Error("invalid UI approval task");
  const target = task.targetRefs[0]!;
  if (target.accountBinding !== task.accountBinding || Object.keys(target).length < 2 ||
      Object.keys(target).some((key) => !["accountBinding", "nativeId", "instagramUrl", "explicitOwnerRef"].includes(key)) ||
      !Object.values(target).every((value) => typeof value === "string" && value.length <= 512)) throw new Error("invalid UI approval target");
  const expiry = Date.parse(task.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= 0) throw new Error("invalid UI approval expiry");
  return {
    version: 1, taskId: task.id, bridgeId: task.bridgeId, source: task.source,
    accountBinding: task.accountBinding, operation: task.operation as UiWriteOperation,
    target: { ...target }, payloadHash: approvalPayloadHash(task.payload), contextHash: task.contextHash!,
    requestId: task.requestId!, fingerprint: task.fingerprint!, expiresAt: task.expiresAt
  };
}

interface KeyRecord { version: 1; privateKey: string; publicKey: string }

async function readKeyRecord(path: string): Promise<KeyRecord | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("UI approval key must be a private regular file");
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<KeyRecord>;
    if (value.version !== 1 || typeof value.privateKey !== "string" || typeof value.publicKey !== "string") throw new Error("UI approval key is invalid");
    return value as KeyRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function defaultProjectRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), ".."); }
