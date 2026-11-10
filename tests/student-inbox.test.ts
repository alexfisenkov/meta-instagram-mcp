import { describe, it, expect } from 'vitest';
import { MetaInbox, validReplyText } from '../src/student/inbox-provider.js';
import { BrokerError, type Connection, type ProductConfig } from '../src/student/types.js';
const now = Date.parse('2026-11-11T10:00:00Z');
const config: ProductConfig = { product: 'messenger', key: 'm', provider: 'facebook_business', appId: '1', appSecret: 'synthetic', apiVersion: 'v24.0', callbackUrl: 'https://example.test/callback', admission: 'live', testSubjects: [] };
const connection: Connection = { tenantId: 't', sub: 's', id: 'connection', grantId: 'grant', product: 'messenger', providerId: 'page', label: 'Page', capabilities: ['account', 'inbox'], status: 'connected', updatedAt: new Date(now).toISOString() };
const credential = { accessToken: 'synthetic-master', assetTokens: { page: 'synthetic-page' } };
function fixture(options: {
    foreign?: boolean;
    old?: boolean;
    malformed?: boolean;
    error?: number;
} = {}) {
    const calls: {
        url: URL;
        init?: RequestInit;
    }[] = [];
    const provider = new MetaInbox(async (url, init) => {
        calls.push({ url, init });
        const path = url.pathname.replace('/v24.0', '');
        expect(url.origin).toBe('https://graph.facebook.com');
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-page');
        if (init?.method === 'POST') {
            if (options.error)
                throw new BrokerError('provider_unavailable', { stage: 'api_request', status: options.error });
            return options.malformed ? {} : { message_id: 'receipt', recipient_id: 'peer' };
        }
        if (path === '/me')
            return { id: 'page' };
        if (path === '/page/conversations')
            return { data: [{ id: options.foreign ? 'other' : 'conversation', updated_time: new Date(now).toISOString() }] };
        if (path === '/conversation')
            return { messages: { data: [{ id: 'message', created_time: new Date(now - 1000).toISOString() }] } };
        if (path === '/message')
            return { id: 'message', created_time: new Date(now - (options.old ? 25 * 3600000 : 1000)).toISOString(), from: { id: 'peer', name: 'Ирина' }, to: { data: [{ id: 'page', name: 'Page' }] }, message: 'Привет', access_token: 'SHOULD_NOT_ESCAPE' };
        throw Error('unexpected path ' + path);
    }, () => now);
    return { provider, calls };
}
describe('verified selected-account inbox', () => {
    it('proves ownership before projecting bodies, derives peer and bounded history', async () => { const { provider } = fixture(); const r = await provider.history(config, connection, credential, { conversationId: 'conversation', limit: 20 }); expect(r.items).toEqual([{ id: 'message', kind: 'text', text: 'Привет', createdAt: new Date(now - 1000).toISOString(), direction: 'inbound', senderLabel: 'Ирина' }]); expect(r.replyPolicy.canReply).toBe(true); expect(r.replyPolicy.recipientLabel).toBe('Ирина'); expect(JSON.stringify(r)).not.toContain('SHOULD_NOT_ESCAPE'); expect(JSON.stringify(r)).not.toContain('synthetic-page'); });
    it('never fetches foreign conversation or body', async () => { const { provider, calls } = fixture({ foreign: true }); await expect(provider.history(config, connection, credential, { conversationId: 'conversation' })).rejects.toThrow('not_found'); expect(calls.some(c => c.url.pathname.endsWith('/message'))).toBe(false); });
    it('rejects URL identifiers before request', async () => { const { provider, calls } = fixture(); await expect(provider.history(config, connection, credential, { conversationId: 'https://evil.test/a' })).rejects.toThrow('invalid_request'); expect(calls).toHaveLength(0); });
    it('proves standard window and does not send to changed target', async () => { const { provider, calls } = fixture(); await expect(provider.send(config, connection, credential, { conversationId: 'conversation', text: 'Точный ответ', recipientHash: 'a'.repeat(64) })).rejects.toThrow('recipient_changed'); expect(calls.some(c => c.init?.method === 'POST')).toBe(false); });
    it('uses exact Page token, verified recipient and exact text once', async () => { const { provider, calls } = fixture(); const context = await provider.context(config, connection, credential, { conversationId: 'conversation' }); expect(await provider.send(config, connection, credential, { conversationId: 'conversation', text: ' Ответ ', recipientHash: context.recipientHash! })).toEqual({ status: 'sent', providerMessageId: 'receipt' }); const post = calls.find(c => c.init?.method === 'POST')!; expect(JSON.parse(post.init!.body as string)).toEqual({ recipient: { id: 'peer' }, messaging_type: 'RESPONSE', message: { text: ' Ответ ' } }); });
    it.each([{}, { error: 500 }, { error: 408 }])('keeps ambiguous delivery unknown %j', async (options) => { const { provider } = fixture({ ...options, malformed: !('error' in options) }); const context = await provider.context(config, connection, credential, { conversationId: 'conversation' }); expect((await provider.send(config, connection, credential, { conversationId: 'conversation', text: 'Ответ', recipientHash: context.recipientHash! })).status).toBe('unknown'); });
    it('marks definite rejection failed; old/unverified windows never send', async () => { const rejected = fixture({ error: 400 }); const ctx = await rejected.provider.context(config, connection, credential, { conversationId: 'conversation' }); expect((await rejected.provider.send(config, connection, credential, { conversationId: 'conversation', text: 'Ответ', recipientHash: ctx.recipientHash! })).status).toBe('failed'); const old = fixture({ old: true }); expect((await old.provider.context(config, connection, credential, { conversationId: 'conversation' })).replyPolicy.reason).toBe('window_closed'); expect(old.calls.some(c => c.init?.method === 'POST')).toBe(false); });
    it('enforces UTF8 byte limit before network', async () => { expect(validReplyText('instagram', 'я'.repeat(500))).toBe(true); expect(validReplyText('instagram', 'я'.repeat(501))).toBe(false); expect(validReplyText('messenger', 'я'.repeat(2000))).toBe(true); expect(validReplyText('messenger', 'я'.repeat(2001))).toBe(false); });
});
it('recognizes exact Instagram app-scoped and professional aliases and never treats own account as recipient', async()=>{
 const cfg={...config,product:'instagram' as const,provider:'instagram_login' as const};const c={...connection,product:'instagram' as const,providerId:'17841400000000001'};let posts=0;
 const p=new MetaInbox(async(url,init)=>{expect(url.origin).toBe('https://graph.instagram.com');if(init?.method==='POST'){posts++;expect(JSON.parse(init.body as string).recipient.id).toBe('peer');return {message_id:'receipt',recipient_id:'peer'}};const path=url.pathname.replace('/v24.0','');if(path==='/me')return {data:[{id:'111',user_id:'17841400000000001'}]};if(path==='/17841400000000001/conversations')return {data:[{id:'conversation'}]};if(path==='/conversation')return {messages:{data:[{id:'message'}]}};if(path==='/message')return {id:'message',created_time:new Date(now-1000).toISOString(),from:{id:'peer',username:'verified_peer'},to:{data:[{id:'111'}]},message:'я'.repeat(4100),access_token:'PRIVATE'};throw Error('unexpected path')},()=>now);
 const h=await p.history(cfg,c,credential,{conversationId:'conversation'});expect(h.items[0].text).toHaveLength(4000);expect(h.items[0].truncated).toBe(true);expect(h.replyPolicy).toMatchObject({canReply:true,maxTextBytes:1000,recipientLabel:'verified_peer'});expect(JSON.stringify(h)).not.toContain('PRIVATE');await p.send(cfg,c,credential,{conversationId:'conversation',recipientHash:h.recipientHash!,text:'я'.repeat(500)});expect(posts).toBe(1);
});
it('fails identity before conversation lookup and refuses unsupported account families',async()=>{
 let calls=0;const p=new MetaInbox(async()=>{calls++;return {id:'other-page'}},()=>now);await expect(p.history(config,connection,credential,{conversationId:'conversation'})).rejects.toThrow('grant_verification_failed');expect(calls).toBe(1);await expect(p.history({...config,provider:'instagram_unified'}, {...connection,product:'instagram'},credential,{conversationId:'conversation'})).rejects.toThrow('operation_unavailable');expect(calls).toBe(1);
});
it('never follows provider URLs and stops cyclic owned-conversation discovery',async()=>{const hosts:string[]=[];const p=new MetaInbox(async url=>{hosts.push(url.host);if(url.pathname.endsWith('/me'))return {id:'page'};return {data:[],paging:{next:'https://evil.test/private',cursors:{after:'same_cursor'}}}},()=>now);await expect(p.history(config,connection,credential,{conversationId:'foreign'})).rejects.toThrow('provider_paging_cycle');expect(hosts).toEqual(['graph.facebook.com','graph.facebook.com','graph.facebook.com']);});
it('rejects group or unrelated message envelope for replies',async()=>{const p=new MetaInbox(async url=>{const path=url.pathname.replace('/v24.0','');if(path==='/me')return{id:'page'};if(path==='/page/conversations')return{data:[{id:'conversation'}]};if(path==='/conversation')return{messages:{data:[{id:'message'}]}};return{id:'message',created_time:new Date(now-1000).toISOString(),from:{id:'peer-a'},to:{data:[{id:'page'},{id:'peer-b'}]}}},()=>now);expect((await p.context(config,connection,credential,{conversationId:'conversation'})).replyPolicy).toMatchObject({canReply:false,reason:'recipient_unverified'});});
it.each([undefined,'foreign-peer'])('never claims sent without exact verified receipt recipient %s',async recipient=>{const {provider}=fixture();const request=(provider as any).request;(provider as any).request=async(url:URL,init?:RequestInit)=>init?.method==='POST'?{message_id:'receipt',...(recipient?{recipient_id:recipient}:{})}:request(url,init);const ctx=await provider.context(config,connection,credential,{conversationId:'conversation'});expect(await provider.send(config,connection,credential,{conversationId:'conversation',text:'Ответ',recipientHash:ctx.recipientHash!})).toMatchObject({status:'unknown',failureCode:'receipt_unverified'});});
it.each(['missing','forbidden','timeout'])('keeps verified conversations when optional participant label is %s',async failure=>{const {provider}=fixture();const request=(provider as any).request;(provider as any).request=async(url:URL,init?:RequestInit)=>{if(url.pathname.endsWith('/message'))throw new BrokerError(failure==='forbidden'?'permission_unavailable':'provider_unavailable',{stage:'api_request',...(failure==='missing'?{status:404}:{})});return request(url,init)};expect(await provider.conversations(config,connection,credential,{limit:20})).toMatchObject({items:[{id:'conversation'}],limitations:expect.arrayContaining(['participant_labels_partial'])});});
it('keeps revoked authorization strict during optional label enrichment',async()=>{const {provider}=fixture();const request=(provider as any).request;(provider as any).request=async(url:URL,init?:RequestInit)=>{if(url.pathname.endsWith('/message'))throw new BrokerError('reauth_required',{stage:'api_request',status:400,metaCode:190});return request(url,init)};await expect(provider.conversations(config,connection,credential,{limit:20})).rejects.toThrow('reauth_required');});

it('roundtrips long opaque conversation/message IDs as encoded path segments',async()=>{const conversation='aWdf'+ 'Z'.repeat(180) + '/+=.$:thread';const message='mid.$'+ 'X'.repeat(180) + '/+=:message';const seen:URL[]=[];const p=new MetaInbox(async(url)=>{seen.push(url);const path=url.pathname.replace('/v24.0','');if(path==='/me')return {id:'page'};if(path==='/page/conversations')return {data:[{id:conversation}]};if(path==='/'+encodeURIComponent(conversation))return {messages:{data:[{id:message}]}};if(path==='/'+encodeURIComponent(message))return {id:message,created_time:new Date(now-1000).toISOString(),from:{id:'peer'},to:{data:[{id:'page'}]},message:'Synthetic'};throw Error('unencoded or unexpected path')},()=>now);const h=await p.history(config,connection,credential,{conversationId:conversation});expect(h.conversationId).toBe(conversation);expect(h.items[0].id).toBe(message);expect(seen.every(url=>url.host==='graph.facebook.com'&&url.pathname.startsWith('/v24.0/'))).toBe(true);expect(seen.some(url=>url.pathname.includes('%2F%2B%3D.%24%3A'))).toBe(true);});
it.each(['..','.','https://evil.test/a','abc?fields=access_token','abc#fragment','abc%2Fme','abc\\me','a'.repeat(1025)])('rejects unsafe/oversized opaque IDs %s',async id=>{const{provider,calls}=fixture();await expect(provider.history(config,connection,credential,{conversationId:id})).rejects.toThrow('invalid_request');expect(calls).toHaveLength(0)});
