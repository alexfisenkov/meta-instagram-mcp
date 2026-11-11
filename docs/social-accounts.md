# Separate read-account connectors

T10 adds an explicitly enabled `social_accounts_*` facade for `twitch`,
`linkedin`, `google_business_profile`, and `x`. The existing `social_connections_*`
video catalog and `PublishProduct` remain Instagram, YouTube, TikTok and Pinterest.
None of the new account connectors publishes, sends messages, modifies profiles,
or manages ads. Their transport rejects provider mutations except OAuth token
exchange/refresh POSTs.

## Enablement and owned-client setup

Without `META_BROKER_CONNECTIONS_CONFIG_FILE`, no new MCP tools, capability marker,
vault or provider calls are added. Copy `student-connections.config.example.json`
to the broker's private configuration, populate only environment reference names
and leave each admission `disabled` until its existing owned client is checked.
`test` admission allows only the configured synthetic LMS subject IDs; it is not
proof of provider test-mode eligibility. Actual client inventory, review, scopes,
quota, billing and external approvals are **unverified** by this implementation.
No real client, credential, account or API request was used in its tests.

Register exact HTTPS callbacks on the owned clients, using the existing broker
callback origin and one path per product:

- `/social/accounts/oauth/twitch/callback`
- `/social/accounts/oauth/linkedin/callback`
- `/social/accounts/oauth/google_business_profile/callback`
- `/social/accounts/oauth/x/callback`

Use a shared application client for LMS users, not per-user developer keys.
Check existing owned applications before registering another. Google Business
Profile can reference the existing Google Web OAuth client's environment names,
as the example demonstrates; enable the required GBP APIs and register the new
callback on that client. This reuse does not transfer scopes or grants between
the separate YouTube, publication and read-account vaults.

Twitch needs a confidential registered application and authorization-code flow.
It requests no email or privileged channel scope for the implemented basic reads.
[Official flow](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/),
[application registration](https://dev.twitch.tv/docs/authentication/register-app/).

LinkedIn's base configuration needs the Sign In with LinkedIn using OpenID Connect
product and `openid profile`. Its OIDC `sub` is stored as an account identity;
it is never converted into a Person URN. Optional partner reads need an explicitly
configured currently supported `apiVersion` and `linkedinReadScopes` drawn from
`r_liteprofile`, `r_member_social`, `r_organization_admin`,
`r_organization_social`. Request only permissions actually provisioned for the
owned application. The implementation obtains a native Person ID from `/v2/me`
when `r_liteprofile` is actually granted; approved matching administrator ACLs
then establish organization access. Refusal of an optional `/me` or ACL endpoint
retains the confirmed OIDC profile and does not invent person/page access.
[OIDC](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2),
[native profile](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/profile-api),
[organization ACLs](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role),
[posts permissions](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api).

GBP requests `openid profile https://www.googleapis.com/auth/business.manage`.
This broad provider permission is used only for reads in this facade. OIDC
identifies the authorizing Google account; accounts discovery and location
discovery establish each owned resource. Provider IDs stay `locations/ID`, with
`accounts/ID` retained as the native parent for v4 local-post paths. Full bounded
pagination is followed during discovery; excessive or repeating pages fail rather
than producing a pretend complete result.
[Accounts](https://developers.google.com/my-business/reference/accountmanagement/rest/v1/accounts/list),
[locations](https://developers.google.com/my-business/reference/businessinformation/rest/v1/accounts.locations/list),
[local posts](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts/list).

X uses a confidential OAuth 2 client, S256 PKCE and
`tweet.read users.read offline.access`; both read scopes are mandatory for the
implemented authenticated-user endpoint. Refresh is available only when a refresh
token was issued. `billingApproved: false` is the default and blocks begin,
callback, read and refresh before any upstream call. Change it only after the
operator verifies access, billing and authorization for the owned app; doing so
is outside this code-only implementation. No X API requests were made here.
[OAuth/PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code),
[authenticated user](https://docs.x.com/x-api/users/get-my-user),
[user posts](https://docs.x.com/x-api/users/get-posts).

## Implemented capabilities

| Resource | Read operations | Limits |
| --- | --- | --- |
| Twitch user | account, posts, metrics | VOD page only; metrics are documented per-video lifetime `view_count`, never channel totals |
| LinkedIn OIDC profile | account | No assumed native person/page permissions |
| LinkedIn native person | account, posts if `r_member_social` was granted | Native ID required; partner access remains an external gate |
| LinkedIn approved administrator organization | account, posts if `r_organization_social` was granted | Fresh matching actor ACL verification before reads |
| GBP location | account, posts, metrics | Native account/location paths; seven bounded Performance daily series |
| X account | account, posts, metrics | Billing gate; `public_metrics` snapshot only |

No connector grants `publish`, inbox, comments, ads or unsupported metrics.
[Twitch user](https://dev.twitch.tv/docs/api/reference/users),
[Twitch videos](https://dev.twitch.tv/docs/api/reference/videos).

## Fixed MCP contract

- `social_accounts_catalog({})` returns four product readiness rows; configuration
  readiness is not provider approval or a real connection.
- `social_accounts_list({})` returns own connections with UUID `id`, `product`,
  `status`, `account:{id,label,kind,parentId?}`, actual `capabilities`,
  `lastSuccessAt?`, `expiresAt?`, `refreshAvailable?`, `reason?`, and `nextAction`.
- `social_accounts_begin({product,connectionId?})` returns only an official
  authorization URL and state expiry. Exact reconnection binds both actor and
  resource; it preserves disconnected sibling resources.
- `social_accounts_read({connectionId,operation,limit?})` accepts `account`,
  `posts`, `metrics`, limit 1–50 (default 20). Output contains `product`,
  `operation`, `accountId`, `observedAt`, `source`, fixed projected `account`,
  `items` or `metrics` and, where relevant, `truncated`, `window`, `timezone`,
  `definition`. Read pages are bounded and do not promise complete history.
  Missing count fields remain absent. GBP alone follows its documented omitted-zero representation for a present dated point; absent dates or series remain unknown.
- `social_accounts_refresh({connectionId})` rechecks identity/resources and returns
  the safe connection projection. It never exposes tokens.
- `social_accounts_disconnect({connectionId})` disables that resource locally,
  clears tokens once no sibling is connected, and explicitly reports
  `providerRevocation:"not_attempted"`. External revocation is performed in the
  provider's own connection settings and may affect every resource of that grant.

The callback consumes a hashed one-time state, verifies provider/configuration,
expiry, optional issuer, generation and exact reconnection identity before
committing. Cancellation keeps previously stored connections. A pending callback
cannot resurrect resources disconnected after that attempt began. Only Google
and X receive PKCE parameters here; Twitch and LinkedIn use their documented
confidential authorization-code exchanges.

## GBP daily metrics schema

For `operation:"metrics"`, GBP reads seven daily date labels ending on the previous
UTC date. `limit` affects posts, not this fixed seven-day range. The output adds
`source:"google_business_profile_performance_v1"`, `window:"daily_range"`,
`range:{startDate,endDate,inclusive:true,selectionTimezone:"UTC"}` and
`timezone:"provider_unspecified"`. The date-selection convention is UTC; the
Performance response does not specify the aggregation timezone, so it is not
represented as UTC or inferred from the business address.

`metrics` contains `series:[{metric,definition,points:[{date,value}]}]`,
`missingMetrics:string[]`, and `coverage:"empty"|"partial"|"complete"`.
Dates are `YYYY-MM-DD`. Values are nonnegative decimal int64 strings, preserving
integers above JavaScript's safe numeric limit. The seven requested series are
the four desktop/mobile Maps/Search impression metrics,
`BUSINESS_DIRECTION_REQUESTS`, `CALL_CLICKS`, `WEBSITE_CLICKS`. Each series carries
its own definition. Impression deduplication is per person/day within that
series, not across series; click counts do not prove completed calls or visits.
No combined total is synthesized. `complete` means only that all requested date
points/series were returned, not that late provider data cannot change.

A missing series or date stays unknown. Google's explicit `DatedValue` with no
`value` means zero by documented protobuf representation; only this case becomes
`"0"`. An empty response produces `coverage:"empty"`, empty series and missing
metric IDs, without fabricated seven-day zeros. Duplicate/out-of-range dates,
unknown metrics, unsupported breakdowns and malformed values fail explicitly.
A metrics-only permission refusal removes that operation while retaining profile
and posts. Explicit refresh/reconnect rechecks the optional operation.

The Performance API must be enabled and approved on the existing Google project;
a zero quota can require requesting access. Its eligibility is unverified here.
[Performance endpoint/schema](https://developers.google.com/my-business/reference/performance/rest/v1/locations/fetchMultiDailyMetricsTimeSeries),
[metric definitions](https://developers.google.com/my-business/reference/performance/rest/v1/DailyMetric),
[dated zero representation](https://developers.google.com/my-business/reference/performance/rest/v1/TimeSeries),
[inclusive date range](https://developers.google.com/my-business/reference/performance/rest/v1/DailyRange),
[official REST discovery metadata](https://businessprofileperformance.googleapis.com/$discovery/rest?version=v1).
The discovery schema confirms the `dailyRange.startDate.*`/`endDate.*` camelCase
query names even though the prose example uses legacy snake-case names.

Current X source schemas use `post.fields` and `public_metrics.post_count`;
response projection follows those documented fields, with no missing-value
fallback to a synthetic zero. X requests remain billing-gated.

## Recovery, storage and rollback

`<broker-directory>/connections` is a separate StudentVault directory protected by
the existing single-writer lock, encryption, private-file handling and CAS writes.
Legacy and publishing schemas/readers see no new products. The unified offline `purgeStudentSubject` procedure visits Meta, YouTube,
read-account and publishing vaults and removes only the exact subject's records.
Its root service writer lock remains held through all namespace mutations.
Every existing vault is opened/decrypted before mutation, so a busy namespace or
wrong separate key fails before records/cache are changed. Publishing cleanup
removes only attributable working copies and delivery checkpoints; it does not
remove original platform assets or remote publications. Read responses are not persisted.
Before replacing encrypted storage, stop the process, preserve the private vault
and its key by the operator's backup procedure, and keep their paths out of git.

Removing the optional config environment variable and restarting removes the new
surface while leaving older facades intact; it does not delete or revoke the
separate grants. Preserve that directory for rollback or use the verified offline
subject purge. Do not roll its data into the older Meta/YouTube schemas.

Access and refresh always verify the actor and owned resources against the
provider. Twitch also validates at startup and every 45 minutes while idle,
including client ID, user ID, actual scopes and expiry.
[Required Twitch validation](https://dev.twitch.tv/docs/authentication/validate-tokens/),
[refresh](https://dev.twitch.tv/docs/authentication/refresh-tokens/).
LinkedIn commonly supplies no refresh token for ordinary OIDC access; manual
refresh then returns `refresh_unavailable` while unexpired access remains usable.
After expiry, the connection needs a new login. Partner-issued refresh tokens
retain their own expiry and are never treated as renewable indefinitely.
[LinkedIn refresh eligibility](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens).

Diagnostic codes are fixed and contain neither upstream bodies nor credentials:
`not_configured`, `review_required`, `billing_unverified` → operator setup;
`state_rejected`, `callback_rejected`, `oauth_cancelled` → start a fresh login;
`reauth_required`, `grant_verification_failed`, `resource_access_lost` → reconnect
the same account/resource; `permission_unavailable`, `operation_unavailable` →
check actual provider permissions/capabilities; `rate_limited` → retry later;
`billing_required` → operator billing; `provider_configuration_rejected` → owned client configuration; `provider_unavailable` → retry after service
recovery; `discovery_limit_exceeded`, `provider_response_invalid`,
`provider_response_partial` → operator investigation. An uncertain or failed read
is never reported as an empty successful dataset.

## Unified offline deletion result

The existing owner CLI remains `--subject <verified-subject> --confirm-purge`.
It emits only aggregate `connections`, `grants`, `events`, `states`, `generations`
on success, adding `deliveries` and `mediaCacheFiles` when the publishing
namespace exists. Inline publishing credentials are counted with connections,
not as separate read grants. A missing optional namespace is not created.

The primary writer lock is acquired first and released last. Other stores are
preflighted under their own locks before mutation. The publishing helper gets
its own lock after preflight while the primary lock continues to exclude the
normal service startup. Stop the service before running the operation and keep
it stopped until the outcome is reviewed.

Independent encrypted files and cache unlinking are not a distributed
transaction. A failure after cleanup starts returns only `purge_incomplete`,
without a successful count receipt, even if some deletion already committed.
Do not interpret that error as rollback: inspect the stopped stores and rerun
the same verified subject; the helper retains ownership records until its cache
cleanup succeeds. No additional media retention scheduler or original-asset
delete was added by this integration.

## Evidence and remaining gates

Local synthetic tests cover signed HTTP/MCP composition, exact default catalog
compatibility, actual callback routing, state replay/product/issuer/expiry,
subject/tenant isolation, native resource ownership, partial grants, token
rotation, wrong actor, shared-grant disconnect, missing refresh, safe projections,
transport write rejection, source/window metadata and offline subject purge.
Two recovery regressions and the optional LinkedIn profile refusal were observed
red before their fixes. The initial implementation tests were added after the
initial modules; this is not a claim of test-first development for the whole wave.

Live OAuth, app review, real refresh, provider quota/cost and owner acceptance
remain unverified. The full shared repository suite and release are orchestrator
checks; local PASS here establishes no deployed or externally approved result.
