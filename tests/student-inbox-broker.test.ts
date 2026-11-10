import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import { StudentVault } from '../src/student/vault.js';
import { StudentBroker } from '../src/student/broker.js';
import { StudentRegistry, configFingerprint } from '../src/student/registry.js';
import { MetaInbox } from '../src/student/inbox-provider.js';
import { BrokerError, type ProductConfig, type Subject } from '../src/student/types.js';
import type { ProviderAdapter } from '../src/student/provider.js';
const now = Date.parse('2026-11-11T10:00:00Z');
const subject: Subject = { tenantId: 'masterskaya', sub: 'synthetic-a' };
const config: ProductConfig = { product: 'messenger', provider: 'facebook_business', key: 'm', appId: '1', appSecret: 'synthetic', configId: '2', apiVersion: 'v24.0', callbackUrl: 'https://example.test/meta/oauth/callback', admission: 'live', testSubjects: [] };
async function fixture(run: (f: {
    vault: StudentVault;
    broker: StudentBroker;
    connectionId: string;
    calls: () => number;
    key: Buffer;
    dir: string;
}) => Promise<void>, options: {
    timeout?: boolean;
    scopes?: string[];
    beforePost?: () => Promise<void>;
} = {}) { const key = randomBytes(32), dir = await mkdtemp(join(tmpdir(), 'student-inbox-')); let vault = await StudentVault.open(dir, key); try {
    const connectionId = randomUUID(), grantId = randomUUID();
    const binding = { ...subject, id: grantId, provider: config.provider };
    await vault.transaction(db => { db.grants.push({ ...binding, configKey: config.key, fingerprint: configFingerprint(config), providerUserId: 'system-user', scopes: options.scopes ?? ['pages_messaging'], status: 'active', credential: vault.seal(binding, { accessToken: 'synthetic-system', assetTokens: { page: 'synthetic-page' } }), createdAt: new Date(now).toISOString() }); db.connections.push({ ...subject, id: connectionId, grantId, product: 'messenger', providerId: 'page', label: 'Page', capabilities: ['account', 'inbox'], status: 'connected', updatedAt: new Date(now).toISOString() }); });
    let calls = 0;
    const inbox = new MetaInbox(async (url, init) => { if (init?.method === 'POST') {
        calls++;
        await options.beforePost?.();
        if (options.timeout)
            throw new BrokerError('provider_unavailable');
        return { message_id: 'synthetic-receipt', recipient_id: 'peer' };
    } const path = url.pathname.replace('/v24.0', ''); if (path === '/me')
        return { id: 'page' }; if (path === '/page/conversations')
        return { data: [{ id: 'conversation' }] }; if (path === '/conversation')
        return { messages: { data: [{ id: 'message' }] } }; if (path === '/message')
        return { id: 'message', created_time: new Date(now - 1000).toISOString(), from: { id: 'peer', name: 'Ирина' }, to: { data: [{ id: 'page' }] } }; throw Error('unexpected fixture path'); }, () => now);
    const adapter: ProviderAdapter = { inbox, exchange: async () => { throw Error('unused'); }, read: async () => ({ data: {}, coverage: 'partial', limitations: [] }) };
    const broker = new StudentBroker(vault, new StudentRegistry([config]), adapter, 'https://platform.example', () => now);
    await run({ vault, broker, connectionId, calls: () => calls, key, dir });
}
finally {
    await vault.close();
    await rm(dir, { recursive: true, force: true });
} }
it('durably guards concurrent and repeated sending, isolates receipts without storing bodies or contacts', async () => { await fixture(async ({ vault, broker, connectionId, calls }) => { const context = await broker.inbox(subject, 'context', { connectionId, conversationId: 'conversation' }) as {
    recipientHash: string;
}; const text = ' Точный синтетический ответ '; const input = { connectionId, conversationId: 'conversation', intentId: randomUUID(), text, textHash: createHash('sha256').update(text).digest('hex'), recipientHash: context.recipientHash, expiresAt: new Date(now + 60000).toISOString() }; const results = await Promise.all([broker.inbox(subject, 'send', input), broker.inbox(subject, 'send', input)]); expect(results).toContainEqual({ status: 'sent', providerMessageId: 'synthetic-receipt' }); expect(calls()).toBe(1); expect(await broker.inbox(subject, 'send', input)).toEqual({ status: 'sent', providerMessageId: 'synthetic-receipt' }); await expect(broker.inbox({ ...subject, sub: 'other' }, 'receipt', input)).rejects.toThrow('not_found'); await expect(broker.inbox({ ...subject, tenantId: 'other' }, 'send', input)).rejects.toThrow('not_found'); expect(JSON.stringify((await vault.snapshot()).replyAttempts)).not.toContain(text); expect(JSON.stringify((await vault.snapshot()).replyAttempts)).not.toContain('Ирина'); await expect(broker.inbox(subject, 'send', { ...input, text: 'Изменённый', textHash: createHash('sha256').update('Изменённый').digest('hex') })).rejects.toThrow('intent_conflict'); expect(calls()).toBe(1); }); });
it('keeps timeout result unknown across broker reuse with no automatic resend', async () => { await fixture(async ({ broker, connectionId, calls }) => { const context = await broker.inbox(subject, 'context', { connectionId, conversationId: 'conversation' }) as {
    recipientHash: string;
}; const text = 'Ответ'; const input = { connectionId, conversationId: 'conversation', intentId: randomUUID(), text, textHash: createHash('sha256').update(text).digest('hex'), recipientHash: context.recipientHash, expiresAt: new Date(now + 60000).toISOString() }; expect(await broker.inbox(subject, 'send', input)).toMatchObject({ status: 'unknown' }); expect(await broker.inbox(subject, 'send', input)).toMatchObject({ status: 'unknown' }); expect(calls()).toBe(1); }, { timeout: true }); });
it('requires actual messaging scope even with a stale claimed capability', async () => { await fixture(async ({ broker, connectionId, calls }) => { await expect(broker.inbox(subject, 'history', { connectionId, conversationId: 'conversation' })).rejects.toThrow('permission_unavailable'); expect(calls()).toBe(0); }, { scopes: ['pages_read_engagement'] }); });
it('sweeps expired reply receipts and retains fresh receipt from another subject',async()=>{const {sweepStudentEvents}=await import('../src/student/retention.js');await fixture(async({vault,connectionId})=>{await vault.transaction(db=>{db.replyAttempts=[{...subject,intentId:randomUUID(),connectionId,grantId:'grant',conversationId:'dialog-old',textHash:'a'.repeat(64),recipientHash:'b'.repeat(64),status:'unknown',createdAt:new Date(now-31*86400000).toISOString(),updatedAt:new Date(now-31*86400000).toISOString()},{...subject,sub:'other-subject',intentId:randomUUID(),connectionId:'other-connection',grantId:'other-grant',conversationId:'dialog-current',textHash:'a'.repeat(64),recipientHash:'b'.repeat(64),status:'sent',createdAt:new Date(now-1000).toISOString(),updatedAt:new Date(now-1000).toISOString(),providerMessageId:'current-receipt'}]});await sweepStudentEvents(vault,now);expect((await vault.snapshot()).replyAttempts).toMatchObject([{sub:'other-subject',providerMessageId:'current-receipt'}]);const revision=(await vault.snapshot()).revision;await sweepStudentEvents(vault,now);expect((await vault.snapshot()).revision).toBe(revision);});});

it('does not disclose an expired receipt before the scheduled sweep',async()=>{await fixture(async({vault,broker,connectionId})=>{const intentId=randomUUID();await vault.transaction(db=>{db.replyAttempts=[{...subject,intentId,connectionId,grantId:'grant',conversationId:'dialog-old',textHash:'a'.repeat(64),recipientHash:'b'.repeat(64),status:'sent',createdAt:new Date(now-30*86400000).toISOString(),updatedAt:new Date(now-30*86400000).toISOString(),providerMessageId:'expired-receipt'}]});await expect(broker.inbox(subject,'receipt',{connectionId,intentId})).rejects.toThrow('not_found');});});
