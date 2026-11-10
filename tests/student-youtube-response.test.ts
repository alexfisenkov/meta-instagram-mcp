import { expect, it, vi } from 'vitest';
import { MetaStudentProvider, requestMeta } from '../src/student/meta-provider.js';
import { StudentBroker } from '../src/student/broker.js';
import { StudentRegistry } from '../src/student/registry.js';
import { StudentVault } from '../src/student/vault.js';
import type { CallbackAuditEvent, ProductConfig } from '../src/student/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const config: ProductConfig = { product: 'youtube', key: 'youtube', provider: 'youtube', appId: '123.apps.googleusercontent.com', appSecret: 'synthetic', apiVersion: 'v3', callbackUrl: 'https://example.test/youtube/oauth/callback', admission: 'live', testSubjects: [] };
const row = { id: 'UC-owned', snippet: { title: 'Synthetic channel' } };
const empty = { kind: 'youtube#channelListResponse', pageInfo: { totalResults: 0, resultsPerPage: 50 }, nextPageToken: '' };
function provider(response: () => unknown) { return new MetaStudentProvider(async (url) => { if (url.origin === 'https://oauth2.googleapis.com')
    return { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'openid profile https://www.googleapis.com/auth/youtube.readonly' }; if (url.origin === 'https://openidconnect.googleapis.com')
    return { sub: 'synthetic-subject' }; expect(url.origin + url.pathname).toBe('https://www.googleapis.com/youtube/v3/channels'); expect(url.searchParams.get('mine')).toBe('true'); expect(url.searchParams.has('id')).toBe(false); return response() as any; }); }
const exchange = (p: MetaStudentProvider) => p.exchange(config, 'synthetic-code', 'V'.repeat(43));
it('accepts an omitted optional items field only with exact zero-result response proof', async () => { await expect(exchange(provider(() => empty))).rejects.toMatchObject({ code: 'no_authorized_assets' }); for (const response of [{}, { kind: 'youtube#channelListResponse' }, { kind: 'other', pageInfo: { totalResults: 0 } }, { kind: 'youtube#channelListResponse', pageInfo: { totalResults: 1 } }, { ...empty, items: null }, { ...empty, pageInfo: { totalResults: '0' } }, { ...empty, nextPageToken: 'another-page' }, { ...empty, items: [row] }])
    await expect(exchange(provider(() => response))).rejects.toMatchObject({ code: 'youtube_channels_response_invalid', diagnostic: { stage: 'asset_discovery' } }); });
it.each([
    [{}, 'youtube_channels_response_invalid'],
    [{ items: [{ id: 'private/invalid', snippet: { title: 'PRIVATE-channel-name' } }] }, 'youtube_channel_row_invalid'],
    [{ items: [row], nextPageToken: null }, 'youtube_channels_cursor_invalid'],
] as const)('returns fixed channel parser classification without payload: %s', async (response, code) => { let error: unknown; try {
    await exchange(provider(() => response));
}
catch (e) {
    error = e;
} ; expect(error).toMatchObject({ code, diagnostic: { stage: 'asset_discovery' } }); expect(JSON.stringify(error)).not.toMatch(/PRIVATE|private\/invalid/); });
it('accepts an empty terminal cursor without weakening owned row verification', async () => { expect((await exchange(provider(() => ({ kind: 'youtube#channelListResponse', items: [row], nextPageToken: '' })))).assets).toMatchObject([{ providerId: 'UC-owned' }]); await expect(exchange(provider(() => ({ items: [], nextPageToken: '' })))).rejects.toMatchObject({ code: 'no_authorized_assets' }); await expect(exchange(provider(() => ({ items: [{ id: 'UC-owned' }], nextPageToken: '' })))).rejects.toMatchObject({ code: 'youtube_channel_row_invalid' }); });
it('keeps malformed/cyclic cursors bounded and never follows provider URLs', async () => { await expect(exchange(provider(() => ({ ...empty, nextPageToken: null })))).rejects.toMatchObject({ code: 'youtube_channels_cursor_invalid' }); for (const token of ['bad\ncursor', 'x'.repeat(2049), {}])
    await expect(exchange(provider(() => ({ items: [row], nextPageToken: token })))).rejects.toMatchObject({ code: 'youtube_channels_cursor_invalid' }); let calls = 0; await expect(exchange(provider(() => { calls++; return { items: [row], nextPageToken: 'same-page' }; }))).rejects.toMatchObject({ code: 'youtube_channels_cursor_invalid' }); expect(calls).toBe(2); });
it('classifies only successful YouTube non-object payloads; Meta transport validation stays strict', async () => { const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('[]')); try {
    await expect(requestMeta(new URL('https://www.googleapis.com/youtube/v3/channels?mine=true'))).rejects.toMatchObject({ code: 'youtube_channels_response_invalid' });
    await expect(requestMeta(new URL('https://graph.facebook.com/v24.0/me'))).rejects.toMatchObject({ code: 'provider_response_invalid' });
}
finally {
    fetch.mockRestore();
} });
it.each([
    [{}, 'youtube_channels_response_invalid'],
    [{ items: [{ id: 'bad/row' }] }, 'youtube_channel_row_invalid'],
    [{ items: [row], nextPageToken: null }, 'youtube_channels_cursor_invalid'],
    [empty, 'no_authorized_assets'],
] as const)('audits parser failure/empty proof without retiring an existing channel: %s', async (response, reason) => { const directory = await mkdtemp(join(tmpdir(), 'youtube-response-')); const vault = await StudentVault.open(directory, randomBytes(32)); try {
    let current: unknown = { items: [row] };
    const audit: CallbackAuditEvent[] = [];
    const broker = new StudentBroker(vault, new StudentRegistry([config]), provider(() => current), 'https://platform.example', Date.now, e => audit.push(e));
    const subject = { tenantId: 'masterskaya', sub: 'synthetic-owner' };
    const complete = async () => { const start = await broker.begin(subject, 'youtube'); return broker.callback({ state: new URL(start.authorizationUrl).searchParams.get('state')!, code: 'synthetic-code', issuer: 'https://accounts.google.com', callbackPath: '/youtube/oauth/callback' }); };
    expect(await complete()).toContain('youtube=connected');
    const before = (await vault.snapshot()).grants;
    current = response;
    expect(await complete()).toContain(reason === 'no_authorized_assets' ? 'youtube=no_channel' : 'youtube=error');
    expect(audit.at(-1)).toMatchObject({ product: 'youtube', stage: 'asset_discovery', reason, outcome: 'error' });
    expect(JSON.stringify(audit)).not.toMatch(/synthetic-access|synthetic-refresh|UC-owned/);
    expect((await vault.snapshot()).grants).toEqual(before);
    expect((await broker.youtubeList(subject)).connections).toMatchObject([{ status: 'connected', account: { id: 'UC-owned' } }]);
}
finally {
    await vault.close();
    await rm(directory, { recursive: true, force: true });
} });
