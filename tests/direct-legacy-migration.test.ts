import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyDirectInstagramToken, verifyOAuthAccountIdentity } from "../src/oauth-account-identity.js";
import { createToolHandlers } from "../src/tools.js";
import { createOAuthCallbackService } from "../src/callback-server.js";
import { createOAuthStateStore } from "../src/oauth-state.js";
import { requestJsonHttp } from "../src/http-json.js";
import { jsonHttpResponse } from "./helpers/json-http.js";
import type { StoredInstagramToken } from "../src/token-store.js";

vi.mock("../src/http-json.js", () => ({ requestJsonHttp: vi.fn() }));
const dirs: string[] = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(dirs.splice(0).map(p => rm(p,{recursive:true,force:true}))); });
const config = { authMode:"instagram" as const, graphApiVersion:"v27.0", tokenStorePath:"/sample/token.json", publishLogPath:"/sample/log.jsonl" };
const legacy = { authMode:"instagram" as const, accessToken:"sample-old-token", userId:"app-user" };
const { accessToken } = legacy;
const profile = { id:"app-user", user_id:"professional-user", username:"sample_owner" };

describe("verified direct legacy identity migration", () => {
  it("accepts an explicitly legacy pin but never treats app-scoped id as canonical", async () => {
    vi.mocked(requestJsonHttp).mockResolvedValue(jsonHttpResponse(profile));
    expect(await verifyDirectInstagramToken(config,"sample-token",{expectedLegacyAccountId:"app-user"})).toMatchObject({userId:"professional-user",legacyAccountId:"app-user"});
    await expect(verifyDirectInstagramToken(config,"sample-token",{expectedAccountId:"app-user"})).rejects.toThrow("OAUTH_IDENTITY_MISMATCH");
  });

  it("migrates the same active Dashboard token with fresh id/user_id proof and CAS", async () => {
    vi.mocked(requestJsonHttp).mockResolvedValue(jsonHttpResponse(profile));
    let stored: StoredInstagramToken = {...legacy};
    const save = vi.fn(async (next:StoredInstagramToken) => {stored=next;});
    const handlers=createToolHandlers({config:{...config,accessToken},tokenStore:{load:async()=>stored,save}});
    await handlers.resolveInstagramAccount();
    expect(stored).toMatchObject({accessToken,userId:"professional-user",identityKind:"instagram_professional_user_id"});
    await handlers.resolveInstagramAccount();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("does not migrate to a profile whose old app-scoped id fails verification", async () => {
    vi.mocked(requestJsonHttp).mockResolvedValue(jsonHttpResponse({...profile,id:"another-app-user"}));
    const save=vi.fn();
    const handlers=createToolHandlers({config:{...config,accessToken},tokenStore:{load:async()=>({...legacy}),save}});
    await expect(handlers.resolveInstagramAccount()).rejects.toThrow("OAUTH_IDENTITY_MISMATCH"); expect(save).not.toHaveBeenCalled();
  });

  it.each([undefined,"professional-user"])("reauthorizes a legacy store with a fresh proof even when the old token expired (explicit pin: %s)", async (expectedAccountId) => {
    const dir=await mkdtemp(join(tmpdir(),"sample-legacy-oauth-"));dirs.push(dir);
    vi.mocked(requestJsonHttp).mockResolvedValue(jsonHttpResponse(profile));
    const commitToken=vi.fn();
    const service=createOAuthCallbackService({binding:{authMode:"instagram",accountBinding:"sample:instagram",redirectUri:"https://example.test/callback",...(expectedAccountId?{expectedAccountId}:{})},
      stateStore:createOAuthStateStore({directory:dir}),readCurrentToken:async()=>({...legacy}),
      exchangeCode:async()=>({authMode:"instagram",accessToken:"sample-new-token",userId:"app-user"}),
      verifyAccount:(token,expected,verification)=>verifyOAuthAccountIdentity(config,token,expected,undefined,verification),commitToken});
    const state=await service.issueState();
    expect((await service.handleCallback({url:`https://example.test/callback?code=sample-code&state=${state}`})).status).toBe("success");
    expect(commitToken).toHaveBeenCalledWith(legacy,expect.objectContaining({userId:"professional-user",identityKind:"instagram_professional_user_id"}));
    expect(vi.mocked(requestJsonHttp).mock.calls.every(([url])=>url.searchParams.get("access_token")!==legacy.accessToken)).toBe(true);
  });

  it("keeps canonical pins strict even when a fresh app-scoped id has the same text", async () => {
    vi.mocked(requestJsonHttp).mockResolvedValue(jsonHttpResponse(profile));
    const save=vi.fn();
    const handlers=createToolHandlers({config:{...config,accessToken},tokenStore:{load:async()=>({...legacy,identityKind:"instagram_professional_user_id"}),save}});
    await expect(handlers.resolveInstagramAccount()).rejects.toThrow("OAUTH_IDENTITY_MISMATCH"); expect(save).not.toHaveBeenCalled();
  });
});
