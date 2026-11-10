import { expect, it } from 'vitest';
import { MetaStudentProvider } from '../src/student/meta-provider.js';
import { BrokerError, type ProductConfig, type Connection } from '../src/student/types.js';

const config: ProductConfig = {
  product: 'ads',
  provider: 'facebook_business',
  key: 'ads',
  appId: '123',
  appSecret: 'synthetic-only',
  configId: '456',
  apiVersion: 'v27.0',
  callbackUrl: 'https://example.test/meta/oauth/callback',
  admission: 'live',
  testSubjects: [],
};

const accounts = [
  { id: 'act_100', account_id: '100', name: 'Selected synthetic account' },
  { id: 'act_200', account_id: '200', name: 'Other synthetic account' },
];

function fixture(
  tokenType: 'SYSTEM_USER' | 'USER',
  options: {
    accounts?: unknown[];
    scopes?: string[];
    granular?: unknown[];
    denied?: boolean;
  } = {},
) {
  const calls: URL[] = [];
  const provider = new MetaStudentProvider(async (url, init) => {
    calls.push(url);
    expect(url.origin).toBe('https://graph.facebook.com');

    if (url.pathname.endsWith('/oauth/access_token')) {
      return {
        access_token: url.searchParams.has('fb_exchange_token')
          ? 'long-user'
          : 'synthetic-token',
      };
    }
    if (url.pathname.endsWith('/debug_token')) {
      return {
        data: {
          app_id: '123',
          is_valid: true,
          type: tokenType,
          user_id: 'verified-subject',
          scopes: options.scopes ?? ['ads_read'],
          ...(options.granular ? { granular_scopes: options.granular } : {}),
        },
      };
    }
    if (url.pathname === '/v27.0/me') {
      return { id: 'verified-subject' };
    }
    if (
      url.pathname ===
      `/v27.0/me/${tokenType === 'SYSTEM_USER' ? 'assigned_ad_accounts' : 'adaccounts'}`
    ) {
      expect(url.searchParams.get('fields')).toBe('id,name,account_id,account_status');
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        tokenType === 'USER' ? 'Bearer long-user' : 'Bearer synthetic-token',
      );
      if (options.denied) {
        throw new BrokerError('permission_unavailable', {
          stage: 'asset_discovery',
          status: 403,
          metaCode: 200,
        });
      }
      return { data: options.accounts ?? accounts };
    }
    throw Error('unexpected Ads route ' + url.pathname);
  });

  return { provider, calls };
}

it.each(['SYSTEM_USER', 'USER'] as const)(
  'uses the exact documented %s discovery route without protocol fallback',
  async (tokenType) => {
    const { provider, calls } = fixture(tokenType);
    const grant = await provider.exchange(config, 'synthetic-code');

    expect(grant.assets.map(asset => asset.providerId)).toEqual(['act_100', 'act_200']);
    expect(
      grant.assets.every(asset => asset.capabilities.join(',') === 'account,metrics'),
    ).toBe(true);
    expect(
      calls.filter(request =>
        request.pathname.endsWith('/adaccounts') ||
        request.pathname.endsWith('/assigned_ad_accounts'),
      ),
    ).toHaveLength(1);
    expect(calls.some(request => request.searchParams.has('fb_exchange_token'))).toBe(
      tokenType === 'USER',
    );
  },
);

it.each(['100', 'act_100'])(
  'binds granular ads targets in exact numeric or act-prefixed form: %s',
  async (target) => {
    const { provider } = fixture('SYSTEM_USER', {
      scopes: ['ads_read'],
      granular: [
        { scope: 'ads_read', target_ids: [target] },
        { scope: 'ads_management', target_ids: ['200'] },
      ],
    });

    expect((await provider.exchange(config, 'code')).assets.map(asset => asset.providerId))
      .toEqual(['act_100']);
  },
);

it('requires actual ads scope before discovery and does not guess a replacement edge after403', async () => {
  const missingScope = fixture('SYSTEM_USER', { scopes: ['business_management'] });
  await expect(missingScope.provider.exchange(config, 'code')).rejects.toMatchObject({
    code: 'permission_unavailable',
    diagnostic: { stage: 'grant_validation' },
  });
  expect(
    missingScope.calls.some(request =>
      request.pathname.endsWith('/assigned_ad_accounts') ||
      request.pathname.endsWith('/adaccounts'),
    ),
  ).toBe(false);

  const deniedDiscovery = fixture('SYSTEM_USER', { denied: true });
  await expect(deniedDiscovery.provider.exchange(config, 'code')).rejects.toMatchObject({
    code: 'permission_unavailable',
    diagnostic: { status: 403, metaCode: 200 },
  });
  expect(
    deniedDiscovery.calls.filter(request =>
      request.pathname.endsWith('/assigned_ad_accounts') ||
      request.pathname.endsWith('/adaccounts'),
    ),
  ).toHaveLength(1);
});

it('keeps empty, unassigned granular, and unrelated permissions without invented assets', async () => {
  for (const options of [
    { accounts: [] },
    { granular: [{ scope: 'ads_read', target_ids: [] }] },
    { granular: [{ scope: 'ads_read', target_ids: ['300'] }] },
  ]) {
    const { provider } = fixture('SYSTEM_USER', options);
    await expect(provider.exchange(config, 'code')).rejects.toMatchObject({
      code: 'no_authorized_assets',
    });
  }
});

it('preserves high-precision string account identity and rejects inconsistent or lossy id pairs', async () => {
  const exactAccountId = '9007199254740993';
  const validAccount = fixture('SYSTEM_USER', {
    accounts: [{ id: 'act_' + exactAccountId, account_id: exactAccountId }],
    granular: [{ scope: 'ads_read', target_ids: [exactAccountId] }],
  });
  expect((await validAccount.provider.exchange(config, 'code')).assets[0].providerId)
    .toBe('act_' + exactAccountId);

  for (const account of [
    { id: 'act_100', account_id: '200' },
    { id: 'act_100' },
    { id: '100', account_id: '100' },
    { id: 'act_9007199254740993', account_id: 9007199254740993 },
  ]) {
    const { provider } = fixture('SYSTEM_USER', { accounts: [account] });
    await expect(provider.exchange(config, 'code')).rejects.toBeInstanceOf(BrokerError);
  }
});

const selected: Connection = {
  id: 'connection',
  tenantId: 'masterskaya',
  sub: 'subject',
  grantId: 'grant',
  product: 'ads',
  providerId: 'act_100',
  label: 'Synthetic',
  status: 'connected',
  capabilities: ['account', 'metrics'],
  updatedAt: 'now',
};

it('verifies the selected Ads account id/account_id pair before profile disclosure', async () => {
  const provider = new MetaStudentProvider(async (url) => {
    expect(url.pathname).toBe('/v27.0/act_100');
    return { id: 'act_100', account_id: '200', name: 'PRIVATE-other-account' };
  });

  await expect(provider.read(
    config,
    selected,
    { accessToken: 'synthetic', assetTokens: {} },
    { connectionId: selected.id, operation: 'account' },
  )).rejects.toMatchObject({ code: 'grant_verification_failed' });
});

it('never discloses insights for a different numeric account_id', async () => {
  const provider = new MetaStudentProvider(async (url) => {
    expect(url.pathname).toBe('/v27.0/act_100/insights');
    return {
      data: [{ account_id: '200', account_name: 'PRIVATE-other-account', spend: '99' }],
    };
  });

  await expect(provider.read(
    config,
    selected,
    { accessToken: 'synthetic', assetTokens: {} },
    { connectionId: selected.id, operation: 'metrics' },
  )).rejects.toMatchObject({ code: 'grant_verification_failed' });
});

it('admits a granted account while skipping an assigned but ungranted metadata-poor account', async () => {
  const { provider } = fixture('SYSTEM_USER', {
    accounts: [accounts[0], { id: 'act_200', name: 'PRIVATE-ungranted' }],
    scopes: ['ads_read'],
    granular: [{ scope: 'ads_read', target_ids: ['100'] }],
  });
  const grant = await provider.exchange(config, 'code');

  expect(grant.assets).toMatchObject([{ providerId: 'act_100' }]);
  expect(JSON.stringify(grant.assets)).not.toContain('PRIVATE-ungranted');
});

it('keeps valid selected profile/insights projection and does not expose extra provider fields', async () => {
  for (const operation of ['account', 'metrics'] as const) {
    const provider = new MetaStudentProvider(async (url) => {
      expect(url.pathname).toBe(
        '/v27.0/act_100' + (operation === 'metrics' ? '/insights' : ''),
      );
      const profile = {
        id: 'act_100',
        account_id: '100',
        name: 'Selected',
        currency: 'USD',
        access_token: 'PRIVATE-token',
      };
      return operation === 'account' ? profile : {
        data: [{
          account_id: '100',
          account_name: 'Selected',
          spend: '1.23',
          access_token: 'PRIVATE-token',
        }],
      };
    });
    const result = await provider.read(
      config,
      selected,
      { accessToken: 'synthetic', assetTokens: {} },
      { connectionId: selected.id, operation },
    );

    expect(JSON.stringify(result)).not.toContain('PRIVATE-token');
    expect(JSON.stringify(result)).toContain('100');
  }
});

it('does not replace an existing subject-bound Ads grant when the next assigned discovery is empty', async () => {
  const [
    { StudentVault },
    { StudentBroker },
    { StudentRegistry },
    { mkdtemp, rm },
    { randomBytes },
    { tmpdir },
    { join },
  ] = await Promise.all([
    import('../src/student/vault.js'),
    import('../src/student/broker.js'),
    import('../src/student/registry.js'),
    import('node:fs/promises'),
    import('node:crypto'),
    import('node:os'),
    import('node:path'),
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'ads-assigned-'));
  const vault = await StudentVault.open(directory, randomBytes(32));

  try {
    let assignedAccounts: unknown[] = accounts;
    const provider = new MetaStudentProvider(async (url) => {
      if (url.pathname.endsWith('/oauth/access_token')) {
        return { access_token: 'synthetic' };
      }
      if (url.pathname.endsWith('/debug_token')) {
        return {
          data: {
            app_id: '123',
            is_valid: true,
            type: 'SYSTEM_USER',
            user_id: 'verified',
            scopes: ['ads_read'],
            granular_scopes: [{ scope: 'ads_read', target_ids: ['100'] }],
          },
        };
      }
      if (url.pathname === '/v27.0/me') {
        return { id: 'verified' };
      }
      expect(url.pathname).toBe('/v27.0/me/assigned_ad_accounts');
      return { data: assignedAccounts };
    });
    const broker = new StudentBroker(
      vault,
      new StudentRegistry([config]),
      provider,
      'https://platform.example',
    );
    const subject = { tenantId: 'masterskaya', sub: 'subject' };
    const completeOAuth = async () => {
      const begin = await broker.begin(subject, 'ads');
      return broker.callback({
        state: new URL(begin.authorizationUrl).searchParams.get('state')!,
        code: 'synthetic-code',
      });
    };

    expect(await completeOAuth()).toContain('meta=connected');
    const previousGrants = (await vault.snapshot()).grants;
    const connections = (await broker.list(subject)).connections;
    expect(connections).toMatchObject([{
      product: 'ads',
      account: { id: 'act_100' },
      status: 'connected',
    }]);
    expect((await broker.list({ ...subject, sub: 'other' })).connections).toEqual([]);
    await expect(broker.read(
      { ...subject, sub: 'other' },
      { connectionId: connections[0].id, operation: 'account' },
    )).rejects.toThrow('connection_not_found');

    assignedAccounts = [];
    expect(await completeOAuth()).toContain('meta=error');
    expect((await vault.snapshot()).grants).toEqual(previousGrants);
    expect((await broker.list(subject)).connections).toMatchObject([{
      product: 'ads',
      account: { id: 'act_100' },
      status: 'connected',
    }]);
  } finally {
    await vault.close();
    await rm(directory, { recursive: true, force: true });
  }
});
