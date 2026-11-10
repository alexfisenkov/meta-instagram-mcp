import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { StudentVault } from '../src/student/vault.js';
import { StudentRegistry, configFingerprint } from '../src/student/registry.js';
import { StudentInboxBroker } from '../src/student/inbox-broker.js';
import { MetaInbox } from '../src/student/inbox-provider.js';
import type { ProductConfig } from '../src/student/types.js';
import type { ProviderAdapter } from '../src/student/provider.js';

it.each(['intent', 'grant', 'window'] as const)('blocks POST when %s expires during the final asynchronous authorization check', async expiring => {
  const start = Date.parse('2026-11-11T10:00:00Z');
  let clock = start, posts = 0;
  const dir = await mkdtemp(join(tmpdir(), 'inbox-expiry-'));
  const vault = await StudentVault.open(dir, randomBytes(32));
  try {
    const subject = {tenantId:'masterskaya', sub:'synthetic-owner'};
    const connectionId = randomUUID(), grantId = randomUUID(), intentId = randomUUID();
    const config:ProductConfig = {product:'messenger', provider:'facebook_business', key:'m', appId:'1', appSecret:'synthetic', configId:'2', apiVersion:'v24.0', callbackUrl:'https://example.test/meta/oauth/callback', admission:'live', testSubjects:[]};
    const binding = {...subject, id:grantId, provider:config.provider};
    await vault.transaction(db => {
      db.grants.push({...binding, configKey:config.key, fingerprint:configFingerprint(config), providerUserId:'system-user', scopes:['pages_messaging'], status:'active', expiresAt:(start + (expiring==='grant'?1000:3600000))/1000, createdAt:new Date(start).toISOString(), credential:vault.seal(binding, {accessToken:'synthetic-system', assetTokens:{page:'synthetic-page'}})});
      db.connections.push({...subject, id:connectionId, grantId, product:'messenger', providerId:'page', label:'Synthetic', capabilities:['account','inbox'], status:'connected', updatedAt:new Date(start).toISOString()});
    });
    const snapshot = vault.snapshot.bind(vault);
    let snapshots = 0;
    vault.snapshot = async () => {
      const db = await snapshot();
      if (++snapshots === 2) clock += 2000; // Last awaited vault proof resolves after the deadline.
      return db;
    };
    const inbox = new MetaInbox(async (url, init) => {
      if(init?.method==='POST'){posts++;return {message_id:'receipt', recipient_id:'peer'};}
      const path=url.pathname.replace('/v24.0','');
      if(path==='/me')return {id:'page'};
      if(path==='/page/conversations')return {data:[{id:'conversation'}]};
      if(path==='/conversation')return {messages:{data:[{id:'message'}]}};
      if(path==='/message')return {id:'message', created_time:new Date(expiring==='window'?start-24*3600000+1000:start-1000).toISOString(), from:{id:'peer'}, to:{data:[{id:'page'}]}};
      throw Error('unexpected synthetic path');
    },()=>clock);
    const adapter:ProviderAdapter = {inbox, exchange:async()=>{throw Error('unused')}, read:async()=>({data:{},coverage:'partial',limitations:[]})};
    const broker = new StudentInboxBroker(vault,new StudentRegistry([config]),adapter,()=>clock);
    const expiresAt=new Date(start+(expiring==='intent'?1000:60000)).toISOString();
    const text='Exact synthetic reply';
    const result=await broker.run(subject,'send',{connectionId, conversationId:'conversation', intentId, text, textHash:createHash('sha256').update(text).digest('hex'), recipientHash:createHash('sha256').update(JSON.stringify(['messenger',connectionId,'conversation','peer'])).digest('hex'), expiresAt});
    expect(posts).toBe(0);
    expect(result).toMatchObject({status:'failed'});
    const stored=(await snapshot()).replyAttempts![0];
    expect(stored.createdAt).toBe(new Date(start).toISOString());
    expect((stored as {expiresAt?:string}).expiresAt).toBe(expiresAt);
  } finally {await vault.close();await rm(dir,{recursive:true,force:true});}
});
