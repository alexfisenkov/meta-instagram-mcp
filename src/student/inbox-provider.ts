import { createHash } from 'node:crypto';
import { BrokerError, type Connection, type Credential, type ProductConfig } from './types.js';
import type { MetaRequest } from './meta-provider.js';
export interface InboxInput {
    conversationId: string;
    limit?: number;
    cursor?: string;
}
export interface ReplyPolicy {
    canReply: boolean;
    reason?: 'permission_unavailable' | 'recipient_unverified' | 'window_unverified' | 'window_closed';
    windowEndsAt?: string;
    recipientLabel?: string;
    maxTextBytes?: number;
    maxTextCharacters?: number;
}
export interface InboxMessage {
    id: string;
    kind: 'text' | 'unsupported';
    text?: string;
    createdAt?: string;
    direction: 'inbound' | 'outbound' | 'unknown';
    senderLabel?: string;
    truncated?: boolean;
}
export interface InboxContext {
    conversationId: string;
    replyPolicy: ReplyPolicy;
    recipientHash?: string;
    readThrough?: {
        messageId: string;
        createdAt: string;
    };
}
export interface Delivery {
    status: 'sent' | 'failed' | 'unknown';
    providerMessageId?: string;
    failureCode?: string;
}
type Row = Record<string, unknown>;
const record = (x: unknown): x is Row => !!x && typeof x === 'object' && !Array.isArray(x);
export function inboxId(x: unknown): string { if (typeof x !== 'string' || !/^[A-Za-z0-9_.:$+=\/-]{1,1024}$/.test(x) || x.includes('://') || x === '.' || x === '..')
    throw new BrokerError('invalid_request'); return x; }
function providerId(x: unknown): string { try {
    return inboxId(x);
}
catch {
    throw new BrokerError('provider_response_invalid');
} }
function accountId(x: unknown): string { if (typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(x)) throw new BrokerError('provider_response_invalid'); return x; }
function segment(x: string): string { return encodeURIComponent(inboxId(x)); }
const label = (x: unknown): string | undefined => typeof x === 'string' && x.trim() ? Array.from(x.replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, 160).join('') : undefined;
function date(x: unknown): string | undefined { if (typeof x !== 'string')
    return; const n = Date.parse(x); if (Number.isFinite(n))
    return new Date(n).toISOString(); }
function rows(x: unknown): Row[] { if (!record(x) || !Array.isArray(x.data) || x.data.length > 100 || x.data.some(v => !record(v)))
    throw new BrokerError('provider_response_invalid'); return x.data as Row[]; }
function cursor(x: unknown): string | undefined { if (!record(x) || !record(x.paging) || !record(x.paging.cursors))
    return; const c = x.paging.cursors.after; return typeof c === 'string' && /^[A-Za-z0-9_=-]{1,2048}$/.test(c) ? c : undefined; }
export function validReplyText(product: string, text: unknown): text is string { return typeof text === 'string' && !!text.trim() && !/[\u0000]/.test(text) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text) && (product === 'instagram' ? Buffer.byteLength(text, 'utf8') <= 1000 : Array.from(text).length <= 2000); }
/** Each operation constructs its own fixed-host budget. No provider next URLs, retries or owner credentials. */
export class MetaInbox {
    constructor(private request: MetaRequest, private now = Date.now) { }
    private session(config: ProductConfig, c: Connection, credential: Credential) {
        if (!['instagram', 'messenger'].includes(c.product) || !c.capabilities.includes('inbox') || c.product === 'instagram' && config.provider !== 'instagram_login' || c.product === 'messenger' && config.provider !== 'facebook_business')
            throw new BrokerError('operation_unavailable');
        const token = c.product === 'messenger' ? credential.assetTokens[c.providerId] : credential.accessToken;
        if (typeof token !== 'string' || !token || token.length > 8192 || c.product === 'messenger' && token === credential.accessToken)
            throw new BrokerError('permission_unavailable');
        const deadline = this.now() + 30000;
        let remaining = 32;
        const call = async (path: string, query: Record<string, string> = {}, body?: unknown, optionalTimeoutMs?: number) => {
            if (--remaining < 0 || this.now() >= deadline)
                throw new BrokerError('provider_budget_exceeded');
            if (!/^v[0-9]+\.[0-9]+$/.test(config.apiVersion) || !/^\/[A-Za-z0-9_%./-]+$/.test(path) || /\/\.\.?(?:\/|$)/.test(path))
                throw new BrokerError('provider_path_rejected');
            const url = new URL(`https://${c.product === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com'}/${config.apiVersion}${path}`);
            for (const [k, v] of Object.entries(query))
                url.searchParams.set(k, v);
            return this.request(url, { headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(Math.max(1, Math.min(deadline - this.now(), optionalTimeoutMs ?? 30000))) });
        };
        return { call, own: async () => {
                const r = await call('/me', { fields: c.product === 'instagram' ? 'id,user_id' : 'id' });
                let p = r;
                if (c.product === 'instagram' && Array.isArray(r.data)) {
                    if (r.data.length !== 1 || !record(r.data[0]) || Object.hasOwn(r, 'id') || Object.hasOwn(r, 'user_id'))
                        throw new BrokerError('grant_verification_failed');
                    p = r.data[0];
                }
                const primary = accountId(c.product === 'instagram' ? p.user_id : p.id);
                if (primary !== c.providerId)
                    throw new BrokerError('grant_verification_failed');
                return new Set([primary, ...(c.product === 'instagram' && p.id !== undefined ? [accountId(p.id)] : [])]);
            } };
    }
    private validate(input: InboxInput) { inboxId(input.conversationId); if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20) || input.cursor !== undefined && !/^[A-Za-z0-9_=-]{1,2048}$/.test(input.cursor))
        throw new BrokerError('invalid_request'); }
    private async owned(call: ReturnType<MetaInbox['session']>['call'], c: Connection, id: string) {
        let after: string | undefined;
        const seen = new Set<string>();
        for (let page = 0; page < 10; page++) {
            const r = await call(`/${segment(c.providerId)}/conversations`, { fields: 'id,updated_time', platform: c.product, limit: '100', ...(after ? { after } : {}) });
            if (rows(r).some(v => providerId(v.id) === id))
                return;
            after = cursor(r);
            if (!after)
                throw new BrokerError('not_found');
            if (seen.has(after))
                throw new BrokerError('provider_paging_cycle');
            seen.add(after);
        }
        throw new BrokerError('discovery_exceeds_limit');
    }
    private async messages(call: ReturnType<MetaInbox['session']>['call'], input: InboxInput, bodies: boolean) {
        // Documented conversation node messages edge; Graph field expansion bounds and pages the nested edge.
        const r = await call(`/${segment(input.conversationId)}`, { fields: `messages.limit(${input.limit ?? 20})${input.cursor ? `.after(${input.cursor})` : ''}{id,created_time}` });
        const list = rows(r.messages);
        if (list.length > (input.limit ?? 20))
            throw new BrokerError('provider_response_invalid');
        const output: Row[] = [];
        const seen = new Set<string>();
        for (const m of list) {
            const id = providerId(m.id);
            if (seen.has(id))
                throw new BrokerError('provider_response_invalid');
            seen.add(id);
            const value = await call(`/${segment(id)}`, { fields: `id,created_time,from,to${bodies ? ',message' : ''}` });
            if (providerId(value.id) !== id)
                throw new BrokerError('provider_response_invalid');
            output.push(value);
        }
        return { rows: output, nextCursor: cursor(r.messages) };
    }
    private project(c: Connection, conversationId: string, own: Set<string>, raw: Row[], bodies: boolean) {
        let peer: string | undefined, peerLabel: string | undefined, ambiguous = false, lastInbound = 0;
        const items: InboxMessage[] = [];
        let readThrough: InboxContext['readThrough'];
        for (const m of raw) {
            const id = providerId(m.id), createdAt = date(m.created_time);
            const from = record(m.from) ? m.from : undefined;
            const to = record(m.to) ? rows(m.to) : [];
            const fromId = from ? accountId(from.id) : undefined;
            const toIds = to.map(v => accountId(v.id));
            const all = [...(fromId ? [fromId] : []), ...toIds];
            const others = [...new Set(all.filter(v => !own.has(v)))];
            const linked = all.some(v => own.has(v));
            if (!linked || others.length !== 1)
                ambiguous = true;
            const candidate = linked && others.length === 1 ? others[0] : undefined;
            if (candidate) {
                if (peer && peer !== candidate)
                    ambiguous = true;
                peer = candidate;
                const participant = fromId === candidate ? from : to.find(v => v.id === candidate);
                peerLabel = label(participant?.name) ?? label(participant?.username) ?? peerLabel;
            }
            const direction = linked && candidate && fromId === candidate && toIds.some(v => own.has(v)) ? 'inbound' : linked && fromId && own.has(fromId) && toIds.includes(candidate!) ? 'outbound' : 'unknown';
            if (direction === 'inbound' && createdAt) {
                const time = Date.parse(createdAt);
                if (time <= this.now() && time > lastInbound)
                    lastInbound = time;
            }
            if (createdAt && Date.parse(createdAt) <= this.now() && (!readThrough || createdAt > readThrough.createdAt))
                readThrough = { messageId: id, createdAt };
            const text = bodies && typeof m.message === 'string' ? Array.from(m.message).slice(0, 4000).join('') : undefined;
            items.push({ id, kind: text !== undefined ? 'text' : 'unsupported', ...(text !== undefined ? { text, ...(text.length < (m.message as string).length ? { truncated: true } : {}) } : {}), ...(createdAt ? { createdAt } : {}), direction, ...(label(from?.name) ?? label(from?.username) ? { senderLabel: label(from?.name) ?? label(from?.username) } : {}) });
        }
        const limits = c.product === 'instagram' ? { maxTextBytes: 1000 } : { maxTextCharacters: 2000 };
        const windowEnd = lastInbound ? lastInbound + 24 * 3600000 : 0;
        const replyPolicy: ReplyPolicy = { canReply: !!peer && !ambiguous && windowEnd > this.now(), ...limits, ...(peerLabel ? { recipientLabel: peerLabel } : {}), ...(!peer || ambiguous ? { reason: 'recipient_unverified' as const } : !lastInbound ? { reason: 'window_unverified' as const } : windowEnd <= this.now() ? { reason: 'window_closed' as const } : {}), ...(windowEnd ? { windowEndsAt: new Date(windowEnd).toISOString() } : {}) };
        const recipientHash = peer && !ambiguous ? createHash('sha256').update(JSON.stringify([c.product, c.id, conversationId, peer])).digest('hex') : undefined;
        return { items, replyPolicy, recipientHash, peer, readThrough };
    }
    async conversations(config: ProductConfig, c: Connection, credential: Credential, input: {
        limit?: number;
        cursor?: string;
    }) {
        this.validate({ conversationId: 'list', ...input });
        const s = this.session(config, c, credential);
        const own = await s.own();
        const result = await s.call(`/${segment(c.providerId)}/conversations`, { fields: 'id,updated_time', platform: c.product, limit: String(input.limit ?? 20), ...(input.cursor ? { after: input.cursor } : {}) });
        const data = rows(result);
        if (data.length > (input.limit ?? 20))
            throw new BrokerError('provider_response_invalid');
        const items = [];
        const optionalDeadline = this.now() + 1000;
        let labelsPartial = false;
        const optionalCall: typeof s.call = (path, query, body) => s.call(path, query, body, Math.max(1, optionalDeadline - this.now()));
        for (const [index, r] of data.entries()) {
            const id = providerId(r.id);
            let peerLabel: string | undefined;
            if (index < 10 && this.now() < optionalDeadline) {
                try {
                    const m = await this.messages(optionalCall, { conversationId: id, limit: 1 }, false);
                    const proof = this.project(c, id, own, m.rows, false);
                    if (proof.peer && !proof.replyPolicy.reason?.includes('recipient')) peerLabel = proof.replyPolicy.recipientLabel;
                } catch (error) {
                    // Optional labels must not erase a verified basic list. Revoked auth/identity remain strict.
                    if (error instanceof BrokerError && ['reauth_required', 'grant_verification_failed'].includes(error.code)) throw error;
                    labelsPartial = true;
                }
            } else labelsPartial = true;
            items.push({ id, ...(date(r.updated_time) ? { updatedAt: date(r.updated_time) } : {}), ...(peerLabel ? { peerLabel } : {}) });
        }
        return { items, ...(cursor(result) ? { nextCursor: cursor(result) } : {}), coverage: 'partial' as const, source: 'meta_graph_api' as const, fetchedAt: new Date(this.now()).toISOString(), limitations: ['bounded_provider_history', 'not_provider_read_receipt', ...(labelsPartial ? ['participant_labels_partial'] : [])] };
    }

    private async read(config: ProductConfig, c: Connection, credential: Credential, input: InboxInput, bodies: boolean) { this.validate(input); const s = this.session(config, c, credential); const own = await s.own(); await this.owned(s.call, c, input.conversationId); const m = await this.messages(s.call, input, bodies); const p = this.project(c, input.conversationId, own, m.rows, bodies); return { session: s, projection: p, nextCursor: m.nextCursor }; }
    async history(config: ProductConfig, c: Connection, credential: Credential, input: InboxInput) { const r = await this.read(config, c, credential, input, true); const { peer: _, ...p } = r.projection; return { conversationId: input.conversationId, ...p, ...(r.nextCursor ? { nextCursor: r.nextCursor } : {}), coverage: 'partial' as const, source: 'meta_graph_api' as const, fetchedAt: new Date(this.now()).toISOString(), limitations: ['bounded_provider_history', 'standard_24h_window_only', 'not_provider_read_receipt'] }; }
    async context(config: ProductConfig, c: Connection, credential: Credential, input: InboxInput): Promise<InboxContext> { const r = await this.read(config, c, credential, { ...input, limit: 10, cursor: undefined }, false); const { items: _, peer: __, ...p } = r.projection; return { conversationId: input.conversationId, ...p }; }
    async markProof(config: ProductConfig, c: Connection, credential: Credential, input: InboxInput & {
        messageId: string;
    }) { this.validate(input); inboxId(input.messageId); const s = this.session(config, c, credential); await s.own(); await this.owned(s.call, c, input.conversationId); const m = await this.messages(s.call, { conversationId: input.conversationId, limit: 20 }, false); const message = m.rows.find(v => v.id === input.messageId); const createdAt = message && date(message.created_time); if (!createdAt || Date.parse(createdAt) > this.now())
        throw new BrokerError('not_found'); return { messageId: input.messageId, createdAt }; }
    async send(config: ProductConfig, c: Connection, credential: Credential, input: InboxInput & {
        text: string;
        recipientHash: string;
    }, beforeSend?: () => Promise<void | (() => void)>): Promise<Delivery> {
        this.validate(input);
        if (!validReplyText(c.product, input.text) || !/^[a-f0-9]{64}$/.test(input.recipientHash))
            throw new BrokerError('invalid_request');
        const r = await this.read(config, c, credential, { conversationId: input.conversationId, limit: 10 }, false);
        const p = r.projection;
        if (p.recipientHash !== input.recipientHash)
            throw new BrokerError('recipient_changed');
        if (!p.replyPolicy.canReply || !p.peer)
            throw new BrokerError('reply_unavailable');
        const finalAuthorization = await beforeSend?.();
        // All asynchronous proof is complete. Recheck the fixed window and authorization
        // deadlines synchronously; slow preflight must never extend an allowed send.
        finalAuthorization?.();
        const windowEnd = Date.parse(p.replyPolicy.windowEndsAt ?? '');
        if (!Number.isFinite(windowEnd) || windowEnd <= this.now()) throw new BrokerError('reply_unavailable');
        try {
            const receipt = await r.session.call(`/${segment(c.providerId)}/messages`, {}, { recipient: { id: p.peer }, ...(c.product === 'messenger' ? { messaging_type: 'RESPONSE' } : {}), message: { text: input.text } });
            const id = receipt.message_id;
            if (typeof id !== 'string' || !/^[A-Za-z0-9_.:$+=\/-]{1,1024}$/.test(id) || id.includes('://') || receipt.recipient_id !== p.peer)
                return { status: 'unknown', failureCode: 'receipt_unverified' };
            return { status: 'sent', providerMessageId: id };
        }
        catch (e) {
            const status = e instanceof BrokerError ? e.diagnostic?.status : undefined;
            return status && status >= 400 && status < 500 && status !== 408 ? { status: 'failed', failureCode: e instanceof BrokerError && e.code === 'reauth_required' ? 'authorization_revoked' : e instanceof BrokerError && e.code === 'permission_unavailable' ? 'permission_unavailable' : 'provider_rejected' } : { status: 'unknown', failureCode: 'delivery_unconfirmed' };
        }
    }
}
