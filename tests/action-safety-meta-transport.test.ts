import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonHttpNetworkError, requestJsonHttp } from "../src/http-json.js";
import { MutationSafety, type MutationExecutor } from "../src/action-safety.js";
import type { MutationIntent } from "../src/domain-types.js";
import { MetaClient, MetaTransportError } from "../src/meta-client.js";
import { metaErrorResponse } from "./helpers/json-http.js";

vi.mock("../src/http-json.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/http-json.js")>();
  return { ...actual, requestJsonHttp: vi.fn() };
});

const httpMock = vi.mocked(requestJsonHttp);
const tempDirs: string[] = [];
afterEach(async () => {
  httpMock.mockReset();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const intent: MutationIntent = {
  source: "api", accountBinding: "ig-account-1", action: "message.send",
  payload: { kind: "message.send", text: "private reply" },
  target: { accountBinding: "ig-account-1", nativeId: "thread-1" }, contextHash: "fresh-context-hash"
};

describe("MutationSafety over the real MetaClient transport boundary", () => {
  it.each(["json-http-network", "connection-reset", "timeout"] as const)(
    "%s is durable OUTCOME_UNKNOWN and is not dispatched again after restart",
    async (failureKind) => {
      const dir = await mkdtemp(join(tmpdir(), "meta-safety-transport-"));
      tempDirs.push(dir);
      const auditPath = join(dir, "audit.jsonl");
      const transportFailure = (url: URL): Error => {
        if (failureKind === "json-http-network") {
          return new JsonHttpNetworkError(url, [{ route: "system-dns", ok: false, error: "socket closed" }]);
        }
        if (failureKind === "connection-reset") {
          return Object.assign(new Error("socket closed access_token=private-token"), { code: "ECONNRESET" });
        }
        return Object.assign(new Error("timeout access_token=private-token"), { name: "TimeoutError" });
      };
      httpMock.mockImplementation(async (url) => {
        const journal = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        expect(journal).toHaveLength(1);
        expect(journal[0].status).toBe("ATTEMPT");
        throw transportFailure(url);
      });

      const client = new MetaClient({ accessToken: "private-token", apiVersion: "v25.0", baseUrl: "https://graph.instagram.com" });
      const execute = vi.fn<MutationExecutor["execute"]>(async () => {
        await client.postJson("/me/messages", { recipient: { id: "peer-1" }, message: { text: "private reply" } });
        return { status: "ACK" };
      });
      const executor: MutationExecutor = {
        source: "api", refreshContext: async () => ({ target: intent.target, contextHash: intent.contextHash }), execute
      };
      const safety = new MutationSafety({ executors: [executor], auditPath, writeEnabled: true });
      const preview = await safety.handle(intent);
      const approval = {
        dryRun: false, confirm: true, expectedFingerprint: preview.fingerprint, requestId: preview.requestId
      } as const;

      const first = await safety.handle(intent, approval);
      const afterRestart = new MutationSafety({ executors: [executor], auditPath, writeEnabled: true });
      const replay = await afterRestart.handle(intent, approval);
      expect(first).toMatchObject({ status: "OUTCOME_UNKNOWN" });
      expect(replay).toMatchObject({ status: "OUTCOME_UNKNOWN" });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(httpMock).toHaveBeenCalledTimes(1);
      const audit = await readFile(auditPath, "utf8");
      expect(audit).not.toContain("private reply");
      expect(audit).not.toContain("private-token");
    }
  );

  it("classifies an explicit Meta 4xx rejection as FAILED", async () => {
    const dir = await mkdtemp(join(tmpdir(), "meta-safety-4xx-"));
    tempDirs.push(dir);
    httpMock.mockResolvedValueOnce(metaErrorResponse("Invalid request", { status: 400, code: 100 }));
    const client = new MetaClient({ accessToken: "private-token", apiVersion: "v25.0", baseUrl: "https://graph.instagram.com" });
    const executor: MutationExecutor = {
      source: "api", refreshContext: async () => ({ target: intent.target, contextHash: intent.contextHash }),
      execute: async () => {
        await client.postJson("/me/messages", { recipient: { id: "peer-1" }, message: { text: "private reply" } });
        return { status: "ACK" };
      }
    };
    const safety = new MutationSafety({ executors: [executor], auditPath: join(dir, "audit.jsonl"), writeEnabled: true });
    const preview = await safety.handle(intent);
    const result = await safety.handle(intent, {
      dryRun: false, confirm: true, expectedFingerprint: preview.fingerprint, requestId: preview.requestId
    });
    expect(result).toMatchObject({ status: "FAILED" });
    expect(httpMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a Meta 5xx response OUTCOME_UNKNOWN on replay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "meta-safety-5xx-"));
    tempDirs.push(dir);
    httpMock.mockResolvedValueOnce(metaErrorResponse("upstream failure", { status: 503, code: 1 }));
    const client = new MetaClient({ accessToken: "private-token", apiVersion: "v25.0", baseUrl: "https://graph.instagram.com" });
    const execute = vi.fn<MutationExecutor["execute"]>(async () => {
      await client.postJson("/me/messages", { recipient: { id: "peer-1" }, message: { text: "private reply" } });
      return { status: "ACK" };
    });
    const executor: MutationExecutor = {
      source: "api", refreshContext: async () => ({ target: intent.target, contextHash: intent.contextHash }), execute
    };
    const auditPath = join(dir, "audit.jsonl");
    const safety = new MutationSafety({ executors: [executor], auditPath, writeEnabled: true });
    const preview = await safety.handle(intent);
    const approval = {
      dryRun: false, confirm: true, expectedFingerprint: preview.fingerprint, requestId: preview.requestId
    } as const;
    const result = await safety.handle(intent, approval);
    const replay = await new MutationSafety({ executors: [executor], auditPath, writeEnabled: true }).handle(intent, approval);
    expect(result).toMatchObject({ status: "OUTCOME_UNKNOWN" });
    expect(replay).toMatchObject({ status: "OUTCOME_UNKNOWN" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(httpMock).toHaveBeenCalledTimes(1);
  });

  it("keeps only safe transport classification when redacting an error", async () => {
    httpMock.mockRejectedValueOnce(Object.assign(
      new Error("socket closed access_token=private-token"), {
        name: "TimeoutError", cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })
      }
    ));
    const client = new MetaClient({ accessToken: "private-token", apiVersion: "v25.0", baseUrl: "https://graph.instagram.com" });
    const error = await client.get("/me").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(MetaTransportError);
    expect(error).toMatchObject({ name: "MetaTransportError", outcome: "unknown", transportName: "TimeoutError", transportCode: "ETIMEDOUT" });
    expect(error).not.toHaveProperty("cause");
    expect((error as Error).message).not.toContain("private-token");
    expect((error as Error).message).toContain("[redacted-secret]");
  });
});
