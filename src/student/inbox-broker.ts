import { createHash } from 'node:crypto';
import { configFingerprint, StudentRegistry } from './registry.js';
import { BrokerError, sameSubject, type Subject, type ReplyAttempt } from './types.js';
import { StudentVault } from './vault.js';
import type { ProviderAdapter } from './provider.js';
import { inboxId, validReplyText } from './inbox-provider.js';
import { invalidateGrant } from './grant-lifecycle.js';
export type InboxAction = 'conversations' | 'history' | 'context' | 'markProof' | 'send' | 'receipt';
export interface BrokerInboxInput {
    connectionId: string;
    conversationId?: string;
    limit?: number;
    cursor?: string;
    messageId?: string;
    intentId?: string;
    text?: string;
    textHash?: string;
    recipientHash?: string;
    expiresAt?: string;
}
/** Narrow subject-bound inbox path; body/contact-free durable delivery receipts remain in the encrypted vault. */
export class StudentInboxBroker {
    constructor(private vault: StudentVault, private registry: StudentRegistry, private provider: ProviderAdapter, private now = Date.now) { }
    async run(subject: Subject, action: InboxAction, input: BrokerInboxInput): Promise<unknown> {
        const db = await this.vault.snapshot();
        const c = db.connections.find(c => sameSubject(c, subject) && c.id === input.connectionId && ['instagram', 'messenger'].includes(c.product));
        if (!c)
            throw new BrokerError('not_found');
        if (action === 'receipt') {
            const attempt = db.replyAttempts?.find(a => sameSubject(a, subject) && a.connectionId === c.id && a.intentId === input.intentId);
            if (!attempt)
                throw new BrokerError('not_found');
            return this.receipt(attempt);
        }
        const grant = db.grants.find(g => g.id === c.grantId && sameSubject(g, subject));
        const config = this.registry.get(c.product);
        const provider = this.provider.inbox;
        if (!provider || c.status !== 'connected' || !c.capabilities.includes('inbox') || !grant || grant.status !== 'active' || !config || this.registry.status(c.product, subject) !== 'ready' || grant.fingerprint !== configFingerprint(config) || (grant.expiresAt !== undefined && grant.expiresAt <= this.now() / 1000))
            throw new BrokerError('connection_unavailable');
        if (!grant.scopes.includes(c.product === 'instagram' ? 'instagram_business_manage_messages' : 'pages_messaging'))
            throw new BrokerError('permission_unavailable');
        const credential = this.vault.credential(grant);
        const unchanged = async () => {
            const current = await this.vault.snapshot();
            const selected = current.connections.find(v => v.id === c.id && sameSubject(v, subject));
            const active = current.grants.find(v => v.id === grant.id && sameSubject(v, subject));
            if (!selected || selected.status !== 'connected' || selected.grantId !== grant.id || !selected.capabilities.includes('inbox') || !active || active.status !== 'active' || JSON.stringify(active.credential) !== JSON.stringify(grant.credential))
                throw new BrokerError('connection_unavailable');
        };
        const reduceInbox = async () => this.vault.transaction(data => {
            const selected = data.connections.find(v => v.id === c.id && sameSubject(v, subject));
            const active = data.grants.find(v => v.id === grant.id && sameSubject(v, subject));
            if (selected?.status === 'connected' && selected.grantId === grant.id && active?.status === 'active' && JSON.stringify(active.credential) === JSON.stringify(grant.credential)) {
                selected.capabilities = selected.capabilities.filter(v => v !== 'inbox');
                selected.reason = 'operation_permission_unavailable';
                selected.updatedAt = new Date(this.now()).toISOString();
            }
        });
        const conversationId = action === 'conversations' ? undefined : inboxId(input.conversationId);
        try {
            let result: unknown;
            if (action === 'conversations')
                result = await provider.conversations(config, c, credential, input);
            else if (action === 'history')
                result = await provider.history(config, c, credential, { ...input, conversationId: conversationId! });
            else if (action === 'context')
                result = await provider.context(config, c, credential, { conversationId: conversationId! });
            else if (action === 'markProof')
                result = await provider.markProof(config, c, credential, { conversationId: conversationId!, messageId: inboxId(input.messageId) });
            else if (action === 'send') {
                const { intentId, text, textHash, recipientHash, expiresAt } = input;
                const deadline = Date.parse(expiresAt ?? '');
                if (typeof intentId !== 'string' || !/^[a-f0-9-]{36}$/.test(intentId) || !validReplyText(c.product, text) || !textHash || createHash('sha256').update(text).digest('hex') !== textHash || !recipientHash || !/^[a-f0-9]{64}$/.test(recipientHash) || !Number.isFinite(deadline) || deadline <= this.now() || deadline > this.now() + 600000)
                    throw new BrokerError('invalid_request');
                const existing = await this.vault.transaction(data => {
                    data.replyAttempts ??= [];
                    const previous = data.replyAttempts.find(a => sameSubject(a, subject) && a.intentId === intentId);
                    if (previous) {
                        if (previous.connectionId !== c.id || previous.conversationId !== conversationId || previous.textHash !== textHash || previous.recipientHash !== recipientHash)
                            throw new BrokerError('intent_conflict');
                        return previous;
                    }
                    if (data.replyAttempts.length >= 10000)
                        throw new BrokerError('vault_capacity_exceeded');
                    const current = data.connections.find(v => v.id === c.id && sameSubject(v, subject));
                    const active = data.grants.find(v => v.id === grant.id);
                    if (!current || current.status !== 'connected' || current.grantId !== grant.id || !active || active.status !== 'active')
                        throw new BrokerError('connection_unavailable');
                    const timestamp = new Date(this.now()).toISOString();
                    data.replyAttempts.push({ ...subject, intentId, connectionId: c.id, grantId: grant.id, conversationId: conversationId!, textHash, recipientHash, status: 'sending', createdAt: timestamp, updatedAt: timestamp });
                    return undefined;
                });
                if (existing)
                    return this.receipt(existing);
                let outcome: {
                    status: 'sent' | 'failed' | 'unknown';
                    providerMessageId?: string;
                    failureCode?: string;
                };
                try {
                    outcome = await provider.send(config, c, credential, { conversationId: conversationId!, text, recipientHash }, unchanged);
                }
                catch (error) {
                    if (error instanceof BrokerError && ['reauth_required', 'grant_verification_failed'].includes(error.code))
                        await invalidateGrant(this.vault, grant, 'provider_authorization_revoked');
                    outcome = { status: 'failed', failureCode: 'preflight_rejected' };
                }
                if (outcome.failureCode === 'authorization_revoked')
                    await invalidateGrant(this.vault, grant, 'provider_authorization_revoked');
                if (outcome.failureCode === 'permission_unavailable')
                    await reduceInbox();
                const attempt = await this.vault.transaction(data => {
                    const a = data.replyAttempts!.find(a => sameSubject(a, subject) && a.intentId === intentId)!;
                    if (a.status === 'sending')
                        Object.assign(a, outcome, { updatedAt: new Date(this.now()).toISOString() });
                    return a;
                });
                return this.receipt(attempt);
            }
            else
                throw new BrokerError('invalid_request');
            await unchanged();
            return result;
        }
        catch (error) {
            if (error instanceof BrokerError && error.code === 'permission_unavailable')
                await reduceInbox();
            if (error instanceof BrokerError && ['reauth_required', 'grant_verification_failed'].includes(error.code))
                await invalidateGrant(this.vault, grant, 'provider_authorization_revoked');
            throw error;
        }
    }
    private receipt(a: ReplyAttempt) { return { status: a.status === 'sending' ? 'unknown' : a.status, ...(a.providerMessageId ? { providerMessageId: a.providerMessageId } : {}), ...(a.failureCode ? { failureCode: a.failureCode } : a.status === 'sending' ? { failureCode: 'delivery_unconfirmed' } : {}) }; }
}
