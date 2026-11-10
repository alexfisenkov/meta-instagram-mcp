# Student Inbox: bounded history and explicit replies

This increment extends only the authenticated private student broker. Legacy owner/browser tools, Meta connection OAuth behavior and the isolated YouTube vault are unchanged. Student admission remains an independent rollout decision.

## Authorization and ownership

Only direct Instagram Login and Messenger Facebook Business connections are supported. A current subject-bound active grant must have the actual messaging scope and the connection's `inbox` capability. Messenger requires the independently verified Page access token from that connection; the system/user grant is never sent to Conversations or Send API. Every operation freshly proves `/me` identity, including exact Instagram professional/app-scoped aliases. It enumerates the selected account's conversations before reading a caller-selected conversation or its messages. Message details are requested only for IDs returned by that owned conversation.

The provider host and versioned paths are constructed by the adapter. No caller or provider URL is followed, redirects and retries are disabled. Ownership discovery stops at 10 pages of 100 conversations. Conversation and message IDs are opaque bounded strings (up to 1024 bytes), distinct from strict account identities. Each dynamic ID is encoded as one URL path segment after exact membership proof; base64 and `mid.$` characters are preserved. History contains at most 20 message projections, at most 4000 Unicode characters each; attachments and raw payloads are omitted. An operation has 32 requests / 30 seconds maximum. Optional list labels use at most 10 conversations and an additional 1-second presentation budget; missing/deleted/forbidden message details do not erase a verified basic list. Identity failures and revoked authorization still fail closed. Empty/partial history does not establish full access or App Review.

## Exact explicit text and delivery

The platform binds an expiring recipient reference to tenant, subject, connection, conversation and a hash of the freshly verified peer. Preparing an intent performs no send. One explicit Send click can prepare and send sequentially after preserving the visible account/recipient/exact-text snapshot. The API persists an immutable body hash, recipient hash and idempotency key, atomically claims `prepared -> sending`, then invokes the broker once. The broker independently reserves a durable encrypted delivery receipt before any outbound attempt, reproves ownership/recipient/window, and rechecks the active connection immediately before POST. After the last asynchronous proof, synchronous guards recheck the immutable intent deadline, both original/current grant expiry and the fixed 24-hour window. The encrypted receipt retains the original deadline; preflight latency never extends it.

Only a proven inbound peer message within 24 hours permits a standard reply. No message tags, outside-window privileges, attachments, campaigns or scheduled delivery are implemented. Direct Instagram text is limited to 1000 UTF-8 bytes by Meta's current documentation; Messenger's 2000 Unicode-character bound is an explicit pilot assumption, not a verified current Meta maximum. Both are returned in `replyPolicy`; accepted text is preserved exactly.

`sent` requires a valid message ID **and** `recipient_id` exactly matching the server-derived peer. Definite provider rejection is `failed`. Timeout, malformed/mismatched acceptance or 5xx is `unknown`. Repeating an intent retrieves its state and never replays the POST. Read-only receipt reconciliation may resolve unknown to sent/failed. A crash after broker reservation remains unknown, not a permission to retry.

## Stored data, retention and deletion

Bodies and participant names are transient projections and are never persisted by this path. The encrypted Meta vault stores at most 10000 reply receipts containing subject/connection/conversation IDs, hashes, state, timestamps and a confirmed provider message ID. Existing lifecycle retention removes receipts after 30 days. The platform's durable immutable intent registry continues to prevent a resend after broker-receipt expiry; expired intents cannot be claimed. New sends require a new explicit intention. Capacity exhaustion fails closed.

The existing offline `purgeStudentSubject` removes this exact tenant/subject's reply receipts alongside grants, connections, states and events, including rollback-isolated vaults; other subjects remain. Logs and errors contain no message bodies, contacts, identifiers, request URLs or credentials. The platform DB separately stores cabinet read marks, immutable intent bindings and transition events, without bodies/contact labels. Its metadata lifecycle/deletion policy must be included in platform data erasure before public/student rollout; this increment does not claim a deployed data-erasure workflow.

## Primary sources and acceptance boundary

- [Instagram Conversations](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/conversations-api/)
- [Instagram Messaging: UTF-8 byte limit and standard reply](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/)
- [Messenger Conversations and required Page token](https://developers.facebook.com/docs/messenger-platform/conversations/)
- [Messenger Send API](https://developers.facebook.com/docs/messenger-platform/send-messages/)

All history/send tests in this increment use synthetic adapters and local vaults/databases. No real message body or send was requested by the implementer. App Review, advanced access, actual message visibility, real recipient acceptance, mobile/desktop UI acceptance and production delivery remain unverified. Existing live inbox metadata200 alone does not prove these surfaces.
