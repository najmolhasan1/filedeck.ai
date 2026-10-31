# Telegram Cloud Drive
## Product Requirements Document and Implementation Blueprint

**Working name:** CloudNest, subject to brand and domain checks  
**Owner:** Najmol Hasan  
**Version:** 1.0, 31 October 2026  
**Status:** Build specification; provider feasibility gates required before production  
**Document language:** English for direct use in Codex, Claude Code, or an engineering team. Bangla UI is required alongside English.

## 1. Product intent

Build a personal file manager that uses the user's own Telegram account to store files, presents files as a familiar cloud drive, and later adds native mobile photo backup. Users must retain access to ordinary uploaded files through Telegram even if this product stops operating.

This is an independent product inspired by observable workflows. Do not copy Telefy source, branding, text, or assets. Telefy's backend and native apps were not inspected. Its promotional statements are not validated requirements or proof of feasibility.

The first release is a dependable web drive. Android backup follows once transfer and recovery work reliably. iOS follows with explicitly documented operating-system constraints. macOS initially uses the responsive web/PWA app, with a native desktop client considered later.

**Core promise:** Organize and access the files you store in your Telegram account. Do not market guaranteed unlimited storage, permanent retention, zero server access, end-to-end encryption, or continuous background backup.

## 2. Assumptions and decisions

| Decision | Default for this specification | Consequence |
|---|---|---|
| Audience | Bangladesh-first personal users, then global | Bangla/English, low-bandwidth UX, BDT pricing if introduced |
| Account model | One product user linked to one Telegram account | Multi-account switching deferred |
| Storage | Telegram ordinary cloud messages in user-owned private storage chats | Subject to Telegram policies, limits and account lifecycle |
| Web Telegram connection | Server-side TDLib account adapter, after feasibility validation | Server can access the linked session; explain this clearly |
| Android connection | Native TDLib client on device | Backup bytes go directly to Telegram; backend session not required for Android-only users |
| Metadata | App database for folders, tags, mappings, transfer records | Backups and exports required; Telegram alone does not preserve the complete app catalog |
| Folder model | Virtual folders in database over a small set of storage chats | Avoid creating one Telegram group per folder |
| Deletion | App trash first; Telegram deletion only through explicit separate action | Reduced accidental permanent loss |
| Encryption | TLS, encrypted disks and encrypted session storage | Ordinary cloud messages are not Secret Chats; no E2EE claim |
| Delivery | Web MVP, Android backup, iOS, then paid features | Full parity is not a first-release assumption |

These are proposed product decisions, not facts inferred from the competitor. Change them through an architecture decision record before implementation if necessary.

## 3. Personas and problems

1. Student: needs documents, lecture videos and photos accessible from phone and laptop without losing originals to image compression.
2. Creator or marketer: needs folders, tags and preview for media and campaign assets; needs original file downloads.
3. Mobile user: wants camera backup and clear feedback about what is safely uploaded before removing local copies.

Primary problems: file discovery in long chat histories, interrupted large uploads, duplicate media, unclear backup status, and unsafe deletion assumptions.

## 4. Scope and priorities

| Capability | Web MVP | Android release | iOS / later |
|---|---|---|---|
| Telegram phone/code/2FA login | Required | Native required | Native required |
| Original file upload/download | Required | Required | Required |
| Virtual folders, rename, move, favorites | Required | Required | Required |
| Search by filename/type/date, grid/list | Required | Required | Required |
| Image/PDF preview, supported video playback | Required | Required | Required |
| Durable queue, retries, cancellation | Required | Required | Required |
| Recovery scan and metadata export | Required | Required | Required |
| Camera backup | Not promised in web | Required | Photo-library backup with OS limits |
| WhatsApp media backup | Not promised | Only user-accessible selected locations | Do not promise access to WhatsApp's private storage |
| Link existing groups/channels | Deferred | Phase 3 | Only explicitly selected chats and actual permissions |
| Public file links | Deferred | Deferred | Phase 4 with revocation and abuse controls |
| Local space cleanup | Deferred | Phase 3 with per-item verification | Separate platform-specific design |
| Billing / Pro | Deferred | After reliability gates | Provider/store billing rules reviewed |
| E2EE vault | Excluded | Excluded | Separate future product mode |

Excluded from initial scope: document editing, team drives, general messaging UI, scraping other users' accounts, bypassing provider limits, forced ads in login, upload splitting to evade file limits, biometric identity collection, AI training on user files.

## 5. Product screens

**Public:** landing, how storage works, security and session access, supported platforms/limits, help, privacy policy, terms.

**Account:** connect Telegram, code verification, 2FA, connecting/syncing, session expired, linked device management, account deletion.

**Drive:** all files, folders, photos, videos, documents, audio, favorites, recent, trash, transfers, storage settings.

**Viewer:** filename, size, date, original download, playback/preview when supported, file details and source chat reference. Unsupported formats show an explanatory fallback.

**Mobile:** backup onboarding, source selection, permission status, Wi-Fi/cellular policy, charging option, recent backup, failed items, upload queue and restore/download.

**Operations:** anonymized service health, queue failures, account connection state and provider error counts. No admin file browser, session export, or impersonation action.

UI requirements: keyboard navigation, readable contrast, screen-reader labels, mobile touch targets, Bangla font support, locale-safe dates, visible upload states, no false “backed up” badge, no exposed credentials in errors.

## 6. Main journeys and acceptance criteria

### AUTH-01: Connect Telegram

User sees disclosure that this is a third-party Telegram client and that enabling web access gives this service an account session whose technical scope is broader than selected storage chats. App-level chat allowlists constrain our behavior but are not a Telegram-scoped permission boundary.

User submits phone number; backend/native TDLib requests login. Provider authorization state determines whether a code, QR flow if later supported, password or another step is required. Do not assume codes always arrive by SMS. Ask for 2FA password only if Telegram requests it. Never store raw login codes or passwords, or send them to analytics.

Acceptance: correct login creates product identity using Telegram user ID, rejects wrong/expired codes clearly, honors provider retry delays, and supports 2FA. Another product user cannot adopt the session. New login never silently reconnects to a previous user's chat catalog. Rate-limit requests by account, IP and device with shared counters. Logout revokes the relevant Telegram authorization when reachable and destroys local session material. Provider outages show pending revocation honestly.

### SETUP-01: Choose storage

User selects Saved Messages or a supported private chat that the user controls. A dedicated private storage channel is preferred only if the feasibility spike proves creation, permissions and recovery reliable. Never auto-add people or create dozens of groups. Creation is user-initiated and explained.

Acceptance: inspect actual chat permissions, persist peer identity, record ownership, reject read-only destinations, and never post files to an unrelated conversation. Storage is append-only by default. Nested virtual folders do not create nested Telegram groups.

### FILE-01: Upload originals

Select or drag multiple files, choose folder, and see individual queue entries. Preserve original bytes and filename; use document/file upload semantics for fidelity. Native camera uploads likewise default to originals. Telegram-generated media previews must not silently replace originals.

MVP product cap: 500 MiB per file until large-file staging tests pass. Later cap is the smaller of a configured product limit and verified Telegram account capability. Telegram FAQ currently describes 2 GB for standard accounts and 4 GB for Premium; prove these through the selected adapter before enabling them in UI. Never trust client-declared Premium status.

Acceptance: each transfer has stable ID, byte counters, retry information and cancel action. Success means a confirmed Telegram message with a valid remote attachment reference, not merely completion of browser-to-server upload. Record size and SHA-256 when computed locally. If a definitive result is unknown, show “verifying upload”, not success or automatic blind resend.

### FILE-02: Organize and search

Create nested virtual folders; rename, move, favorite and tag. Filename rename is an app display-name change; it does not promise to rename the Telegram attachment. Folder rename/move changes catalog metadata only. Maximum depth 10 by default. Prevent cycles. Bulk operations return per-item outcomes.

Acceptance: moves preserve remote message references, duplicate names are handled predictably, file size uses exact byte count, and cursor pagination prevents missing/repeating entries. Search respects user boundary. No file-content indexing in MVP.

### FILE-03: Preview and restore

Open images and PDFs where supported. Stream compatible video through authorized range requests. Unsupported codecs offer original download; do not promise universal streaming. Range requests return correct 206/416 behavior and enforce ownership on every request.

Acceptance: download bytes match uploaded originals on representative fixtures. MIME/content sniffing, attachment headers, sandboxed document previews and an isolated media origin prevent uploaded HTML/SVG from executing in the application origin. Expired remote references are refreshed through the adapter before failing visibly.

### DELETE-01: Trash and deletion

Move to app trash hides the file from normal drive views but leaves its Telegram message intact. Restore changes app metadata. Default retention is 30 days as a UI reminder, not an automatic Telegram deletion deadline.

“Remove from app” deletes/tombstones catalog visibility only. “Delete from Telegram” is a separate explicit destructive action with item count, destination and permanence warning. It is available only where actual permissions allow it. Folder deletion asks whether to move files to root or trash; never deletes the storage chat.

Acceptance: accidental trash is reversible. Permanent deletion marks an operation pending, performs provider action, reconciles uncertain responses, and reports partial failures. A user deleting messages directly in Telegram eventually sees missing/unavailable status. Do not display fake restore options for provider-deleted files.

### SYNC-01: Existing files and reconciliation

Only index storage chats and other chats explicitly selected by the user. Page through history with saved checkpoints and show progress. Listen for updates and periodically reconcile missed changes. Support rebuilding a file catalog from allowed chat history after database loss; app folders/tags require metadata backup or export.

Acceptance: restart continues a scan, imports do not create duplicate catalog rows, external deletion is reflected, and revoked chat access becomes unavailable rather than deleting the user's remaining metadata. Flood-wait stops provider work until allowed; no account/proxy rotation to evade it.

### BACKUP-01: Android photo backup

User grants appropriate media access and chooses camera albums or user-accessible sources. Respect limited access. Scan accessible media using platform APIs, record a source cursor, and queue new assets. Use WorkManager for deferrable work, with the appropriate user-visible transfer mechanism for long transfers according to the targeted Android version. Background execution is best effort and device dependent.

Default: Wi-Fi only, preserve originals, do not include existing library until user selects it. Explain initial library size before starting. Display last completed backup, pending count and actionable failures.

Acceptance: process death, reboot, network switch and battery restriction never incorrectly mark success. Changed content at the same path creates a new version. A partially accessible album is not labelled fully backed up. If a local original disappears before upload, mark source unavailable. Do not scan private app data or bypass scoped-storage restrictions.

### BACKUP-02: iOS photo backup

Use PhotoKit with selected-library authorization where applicable. BackgroundTasks provides opportunities, not an always-running service. Persistent native queues catch up when the app opens. Validate whether the native Telegram transfer mechanism can finish under iOS constraints; do not assume URLSession background HTTP behavior applies to TDLib transfers.

Acceptance: limited Photos permission works, cloud-only photos show download/preparation status, and interrupted work resumes safely when the OS permits. No arbitrary WhatsApp-folder promise. Release copy explicitly explains that opening the app may be required to complete backup.

### ACCOUNT-01: Disconnect and delete account

Distinguish “sign out this device”, “disconnect server Telegram session”, and “delete product account”. Product deletion does not delete Telegram messages. Product account deletion revokes owned sessions where possible, stops jobs, deletes primary metadata within 7 days and expires encrypted backup copies within 30 days as proposed retention policy. Inform users about the backup retention window. These deadlines must be implemented and reflected in privacy copy before release.

## 7. Architecture

### 7.1 Components

- Web: Next.js with TypeScript, responsive UI and optional PWA install. No claim that PWA installation enables camera background backup.
- Backend: NestJS with TypeScript, OpenAPI contracts, server-sent transfer events, authentication and authorization middleware.
- Telegram service: isolated TDLib workers behind an internal RPC interface. Each account has an encrypted TDLib database directory and a single active worker lease. Validate a maintained binding or build a small native wrapper during the spike; do not couple domain code to an unverified package.
- Durable metadata: PostgreSQL. Durable transfer state is in Postgres, not only Redis.
- Queue: Redis/BullMQ for dispatch, plus transactional outbox and replay/reconciliation.
- Web staging: resumable upload service using tus-compatible protocol and encrypted temporary disk/object storage. No permanent duplicate file store by default.
- Android: Kotlin, Jetpack Compose, Room, TDLib native bridge and platform background APIs.
- iOS: Swift/SwiftUI, local persistent queue and TDLib native bridge after spike.
- Infrastructure: Docker-based long-running services for API, transfer gateway and workers; managed PostgreSQL, Redis, encrypted staging and KMS. Stateless frontend hosting is fine. Do not place TDLib sessions or multi-GB uploads in short-lived serverless functions.

### 7.2 Data paths

**Web upload:** browser → resumable staging → server TDLib worker → Telegram → confirmed message → catalog commit → staged bytes scheduled for deletion.

**Android upload:** accessible device asset → native TDLib → Telegram → confirmed message → metadata registration API → web catalog. Backend independently verifies the registered remote reference using a connected session when available. Without that session, label metadata device-reported and keep it account-isolated until validated.

**Web download:** authenticated request → file ownership and allowed-chat check → server TDLib fetch → bounded streaming gateway → browser. No public raw session or permanent provider URL is returned.

**Cross-device organization:** all clients use product API for folders/tags. Direct Telegram updates are eventually reconciled. Last-write-wins for ordinary display metadata uses row versions to detect concurrent edits; deletion has tombstone priority until restored.

### 7.3 Session and device identity

Web and mobile Telegram authorizations are separate, even for one account. Never copy session databases between devices. Mobile proves account identity to the backend using a server-issued short-lived challenge, with proof independently validated through an authenticated Telegram mechanism established in the spike. A claimed Telegram ID or unvalidated device assertion is insufficient.

If secure native identity binding is not solved, require an existing web session to approve a one-time pairing code and bind the device public key. Expiring, single-use pairing requires explicit confirmation in the web app. Android-only onboarding must wait for a verified identity design rather than ship an insecure shortcut.

## 8. Telegram adapter contract

Domain interface, not a promise of exact TDLib method names:

```
startAuthorization(accountKey, input) -> authorizationState
submitAuthorizationStep(accountKey, step) -> authorizationState
getAccountCapabilities(accountKey) -> limitsAndAccountStatus
listAllowedChats(accountKey, cursor) -> chatPage
listAttachments(accountKey, chatRef, cursor) -> attachmentPage
sendOriginalFile(accountKey, source, chatRef, operationId) -> sendState
lookupSendResult(accountKey, operationId) -> confirmed | pending | unknown
fetchOriginal(accountKey, attachmentRef, byteRange) -> bounded stream
refreshReference(accountKey, chatRef, messageRef) -> attachmentRef
removeMessages(accountKey, chatRef, messageRefs) -> perItemResult
revokeAuthorization(accountKey) -> confirmed | pending
```

Keep TDLib-local message/file IDs separate from stable remote identities. Do not assume a file identifier is portable between TDLib databases. A durable attachment key includes Telegram account, remote peer, message identity and attachment position, plus metadata needed to resolve it again. Store Telegram IDs as Postgres bigint and JSON strings to avoid JavaScript precision loss.

## 9. Data model

All timestamps UTC, all external IDs serialized as strings. Every user-owned table includes user_id and enforces tenant ownership in queries and database policies where practical.

| Table | Key fields and constraints |
|---|---|
| users | id UUID, telegram_user_id unique, locale, status, created_at |
| devices | id, user_id, public_key, platform, last_seen, revoked_at |
| product_sessions | id, user_id, device_id, hashed_refresh_token, expires_at, revoked_at |
| telegram_sessions | id, user_id, runtime_kind, encrypted_state_ref, kms_key_version, state, lease_owner, lease_expiry |
| storage_chats | id, user_id, remote_peer_id, type, verified_permissions, selected_at, status; unique user/peer |
| folders | id, user_id, parent_id nullable, name, version, trashed_at; enforce acyclic ownership |
| files | id, user_id, folder_id, storage_chat_id, remote_message_id, attachment_index, display_name, original_name, mime, bytes, sha256 nullable, origin, availability, version, trashed_at |
| file_tags | user_id, file_id, tag_id; ownership-safe composite constraints |
| transfers | id, user_id, device_id, operation_id unique per user, state, stage_bytes, provider_bytes, expected_bytes, retry_after, error_code, remote_result, updated_at |
| upload_chunks | upload_id, offset, length, checksum, state; enforce sequential/validated offsets |
| backup_sources | id, user_id, device_id, local_source_identifier, policy, permission_state, cursor |
| backup_items | id, source_id, stable_asset_id, content_version, size, hash, state, transfer_id, file_id; unique source/asset/version |
| sync_checkpoints | user_id, storage_chat_id, history_cursor, update_cursor, last_reconciled_at |
| catalog_tombstones | user_id, remote_attachment_key, reason, created_at; prevents unwanted re-import |
| idempotency_keys | user_id, route_scope, key, request_digest, response_ref, expiry |
| outbox_events | id, user_id, event_type, payload_ref, delivered_at |
| audit_events | user_id, action, opaque_resource_id, outcome, timestamp; no filenames or secrets |

Unique index: user_id + storage_chat_id + remote_message_id + attachment_index. Favorite, MIME, folder, timestamp and filename indexes support cursor filtering. Use explicit file versions when content changes; no automatic destructive overwrite.

## 10. API specification

Prefix `/v1`. REST responses use stable error codes, request_id and retry_after where applicable. Require ownership checks even when a resource UUID is known. Mutating requests accept an Idempotency-Key. Upload bytes bypass JSON body parsing.

| Method and route | Purpose |
|---|---|
| POST /auth/telegram/start | Begin phone login and create short-lived login transaction |
| POST /auth/telegram/step | Submit code/2FA step for that transaction, never log body |
| GET /auth/telegram/state | Poll provider authorization state |
| POST /auth/refresh | Rotate app refresh credential, detect reuse |
| POST /auth/logout | Revoke selected app/device session |
| GET /me and GET /me/devices | Identity, capabilities and connected devices |
| POST /devices/pair and POST /devices/pair/approve | Secure challenge-based native pairing |
| DELETE /me/telegram-session | Disconnect web Telegram authorization |
| DELETE /me | Product deletion workflow; never implicit Telegram content deletion |
| GET /storage-chats | Selected storage and actual connection status |
| POST /storage-chats | Select/validate supported storage chat |
| POST /sync-jobs and GET /sync-jobs/:id | Start and observe selected-chat sync |
| GET /files | Cursor list/filter/search, excluding trash by default |
| GET /files/:id | Details and availability |
| PATCH /files/:id | Rename/move/favorite using If-Match version |
| POST /files/bulk | Bulk metadata operations with per-item results |
| POST /files/:id/trash and POST /files/:id/restore | Reversible app trash actions |
| DELETE /files/:id/catalog | Remove from catalog and write tombstone |
| POST /files/:id/delete-remote | Explicit provider deletion operation |
| GET /files/:id/content | Authorized download/range stream |
| GET /files/:id/preview | Safe preview or unsupported status |
| GET/POST /folders, PATCH/DELETE /folders/:id | Virtual folder operations |
| POST /uploads | Initialize resumable upload, reserve staging budget |
| HEAD/PATCH /uploads/:id | Read offset and append verified chunk |
| POST /uploads/:id/commit | Finalize staging and queue Telegram transfer |
| GET /transfers and GET /transfers/:id | Durable state and progress |
| POST /transfers/:id/cancel or /retry | User transfer controls |
| GET /events | Authenticated SSE status events with reconnect cursor |
| POST /native-uploads/register | Account-bound completed native transfer registration |
| GET/POST/PATCH /backup-sources | Device-scoped source policies and status |
| GET /exports/catalog | JSON export with schema version and remote references |

Example error:

```json
{"error":{"code":"PROVIDER_WAIT","message":"Telegram asked us to wait before continuing.","retry_after_seconds":120},"request_id":"opaque-id"}
```

Other codes: AUTH_EXPIRED, TWO_FACTOR_REQUIRED, PERMISSION_DENIED, FILE_TOO_LARGE, SOURCE_UNAVAILABLE, STAGING_QUOTA_EXCEEDED, REMOTE_FILE_MISSING, UNSUPPORTED_PREVIEW, UPLOAD_UNCERTAIN, VERSION_CONFLICT. Do not expose provider debug payloads or phone numbers in errors.

## 11. Transfer reliability and recovery

State machine:

```
CREATED → STAGING → STAGED → QUEUED → SENDING → VERIFYING → COMPLETED
                              ↘ WAITING_PROVIDER / WAITING_NETWORK
Any active state → CANCEL_REQUESTED → CANCELLED
Recoverable error → RETRY_SCHEDULED
Uncertain send → RECONCILING → COMPLETED or NEEDS_ATTENTION
Definitive failure → FAILED
```

Persist state before dispatch through an outbox transaction. One account worker lease prevents concurrent session database access. Expired leases allow another worker to recover. Queue delivery is at least once; sending effects must be reconciled.

An operation ID is stable across retries. Reuse provider-level deduplication mechanisms where exposed and proven by the adapter. Local idempotency keys alone cannot guarantee exactly-once Telegram sends after a lost acknowledgement. After uncertain outcomes, search/reconcile known pending messages before resending; unresolved cases remain visible. Cancellation may arrive after a message has been sent; disclose that and offer explicit remote removal instead of pretending cancellation undid it.

Default concurrency: one active provider upload per account and two web staging streams per account, configurable after load tests. Read retry_after/flood-wait from provider. Exponential backoff with jitter only for eligible errors. Store attempt count and max retry budget. Never retry permanent permission or authorization failures indefinitely.

Staging bytes expire after 24 hours of inactivity; cancel deletes them promptly. Confirmed uploads are queued for cleanup within one hour. An idempotent sweeper enforces this and alerts on stale files. Bound per-user and global staging usage; reject new reservations before disk exhaustion. Recovered staging metadata must correspond to real verified chunks.

## 12. Duplicate policy

Do not deduplicate different users' data. Exact duplicate detection uses SHA-256 and size within the same user and backup policy. Fast candidate matching by local asset ID/size/modified time reduces hashing but is not proof of identical content. Compute hash incrementally where possible.

Manual duplicate uploads ask whether to keep another copy or reuse an existing remote attachment in a second catalog entry. Backup duplicates are skipped only after a previously confirmed matching upload. Similar photos remain separate. A false duplicate must never suppress a changed asset.

## 13. Security, privacy and provider compliance

- Use developer-owned Telegram api_id/api_hash obtained through the official process. Keep secrets out of source, client logs and build artifacts. Validate distribution requirements for native clients against official guidance.
- Session access can expose account data beyond product-selected chats. Explain it before web connection. Encrypt TDLib databases and session volumes at rest with per-account keys wrapped by KMS; restrict decrypt access to assigned workers. A compromised live worker can still access its account, so encrypted disks alone are insufficient.
- Worker network/access boundaries, non-root containers, short-lived service credentials, patching and no interactive support access to sessions.
- Secure/HttpOnly/SameSite cookies for web, CSRF protection, strict CORS/CSP, no tokens in localStorage, platform secure storage for mobile secrets.
- Authorize every file/chunk/range request against user and selected chat. Rate-limit signed URLs and keep them short lived if introduced.
- Never store or log OTPs, 2FA passwords, phone numbers in analytics, raw Telegram session state, file contents or filenames. Redact error tracking and request bodies on auth/upload routes.
- Cloud messages are not end-to-end encrypted Secret Chats. Avoid “only you can ever read files” claims. E2EE vault would require client-side encryption, key recovery and different streaming/preview behavior.
- Product access revocation immediately stops jobs and invalidates product tokens. Provider revocation failures are queued and surfaced.
- Review Telegram API Terms and relevant store policies before beta and each major distribution change. The fact that Telegram supports files is not proof that every storage-only business model or client design is permitted. Do not work around a policy rejection.
- No public sharing in MVP. A later sharing feature needs expiring/revocable access, request limits, abuse reporting, content handling procedures and a separate security review.

## 14. Nonfunctional targets

These are engineering acceptance targets, not provider guarantees.

| Area | Target and measurement |
|---|---|
| Catalog response | p95 under 800 ms for a 50-item page at 100,000 indexed items/user in staging |
| UI progress | Updates normally within 2 seconds of new local/provider progress |
| Transfer memory | Bounded buffers; file size must not determine application heap consumption |
| Reliability | At least 98% eventual completion of eligible transfers within 24h during a 14-day beta, excluding explicit cancellations; report provider/network failures separately |
| Tenant isolation | Zero cross-user reads/writes in automated authorization tests |
| Product API uptime | Initial internal SLO 99.5% monthly, external provider incidents separately visible |
| Metadata recovery | Proposed RPO 24h, RTO 8h; verify by restore drill |
| Accessibility | Core connect/upload/find/download journeys keyboard and screen-reader usable |
| Large-file support | Product cap only raised after tests near standard/Premium boundaries with the actual deployed proxy and adapter |

Beta planning load, not a verified capacity claim: 100 active accounts, 20 simultaneous web transfers, 10,000 catalog records/account. Account session memory and storage growth must be benchmarked; do not extrapolate from bot-client benchmarks to authenticated user accounts.

## 15. Analytics and operations

Events: signup_started, account_connected, storage_selected, upload_started, upload_confirmed, upload_failed, download_started, preview_unsupported, backup_enabled, backup_item_confirmed, session_revoked, catalog_exported. Use opaque internal IDs; no phone, filename, chat title or file content.

Activation: account connected plus first confirmed upload within 24h. Track time to first upload, 7/30-day repeat usage, eventual completion, duplicate suppression accuracy, queue age, uncertain send count and backup freshness. Product analytics is optional where consent is required.

Operational dashboards: worker lease health, memory/account, flood-wait frequency, staging bytes, orphan temp files, transfer failure codes, download range failures, expired authorization and reconciliation lag. Alerts must exclude personal content.

Runbooks: provider outage, account restriction, compromised session, full staging disk, queue loss, worker crash, missing Telegram message, database restore, data deletion request. Support sees only opaque IDs/status and never requests OTPs or session exports.

## 16. Cost model and monetization

Telegram storage does not remove our costs. Model monthly expenses as:

`API/worker compute + session disk + database + queue + temporary storage + staging operations + network egress + monitoring + support + payment/store fees`.

Web bytes can pass through infrastructure during upload and again on download; provider and hosting billing determines which directions are charged. Measure actual traffic per confirmed stored GB and per streamed GB, including repeated partial playback. Direct native transfers reduce our relay traffic but introduce native engineering work.

No invented fixed operating-cost estimate. Before pricing, benchmark 10, 100 and 1,000 active accounts under defined usage. Set configurable relay quotas to protect costs, with clear user-facing limits. Free tier should not promise unlimited server bandwidth.

Potential Pro features: advanced backup scheduling, multiple devices, advanced organization and larger product transfer caps within provider capabilities. Paid features never unlock a Telegram limit the account does not possess. Do not charge or suggest affiliate revenue before working billing/refunds/store-policy review.

## 17. Testing and release gates

Required automated tests: tenant authorization and IDOR; upload offset/checksum validation; expired login and 2FA flow mocks; transfer state transitions; idempotency conflicts; worker lease contention; provider flood-wait; folder cycle protection; catalog tombstones; malicious filenames/MIME; range boundaries; deletion partial failure; metadata export/import.

Required integration tests against isolated developer test accounts: upload/download byte equality, send acknowledgement lost, worker killed mid-send, app restart, expired remote reference, external Telegram deletion, revoked authorization, history rescan and duplicate-free indexing. Never use customer data in tests.

Android matrix: permission denied/limited, camera asset changed, local file removed, Wi-Fi loss, cellular disallowed, reboot, force stop, battery restrictions and device-vendor behavior. iOS matrix adds limited Photos, iCloud-only assets, background suspension and catch-up on open. Do not treat emulator-only results as sufficient.

Gate before external beta: working session revocation, tested metadata restore, no credential logging, tenant-isolation tests green, temp cleanup proven, no silent duplicates after crash recovery, truthful backup states, provider policy review complete.

## 18. Delivery plan and backlog

Estimates are planning ranges for experienced developers and require revision after spikes. AI coding assistance does not replace native testing or security review. A solo developer should expect a longer schedule.

| Milestone | Deliverable | Planning range | Exit condition |
|---|---|---|---|
| M0: feasibility | Provider/policy review, TDLib deployment, auth, native identity design, standard/large test transfers, range prototype | 1–2 weeks | All blocking assumptions demonstrated or scope revised |
| M1: foundation | Repo, CI, database, account auth, session isolation, safe staging | 1–2 weeks | Tenant isolation and secret handling tested |
| M2: web drive | Storage selection, upload/download, virtual folders, catalog/search, preview | 2–3 weeks | End-to-end original-byte transfer and organization works |
| M3: reliability beta | Durable retries, reconciliation, trash, export, cleanup, restore and monitoring | 2–3 weeks | Web beta gates pass |
| M4: Android | Native connection/pairing, camera backup, queue, policies, permissions | 3–5 weeks | Real-device recovery matrix passes |
| M5: iOS | Photo library backup with honest background limits | 3–5 weeks | Native spike and real-device gates pass |
| M6: expansion | Selected-chat linking, advanced restore, paid features, optional sharing | Separately estimated | Reliability and economics justify expansion |

Potential overlapping team roles: full-stack engineer, mobile engineer, part-time QA/security and product/design owner. Do not sum parallel estimates as a guaranteed deadline.

### Prioritized engineering tickets

P0-01 provider terms/architecture feasibility; P0-02 TDLib deployment and account isolation; P0-03 secure auth/2FA/logout; P0-04 user-bound storage selection; P0-05 database migrations/tenant enforcement; P0-06 resumable staging and quotas; P0-07 confirmed send reconciliation; P0-08 catalog list/search/folders; P0-09 authenticated range downloads; P0-10 trash and remote-delete distinction; P0-11 cleanup and recovery; P0-12 privacy/security release gate.

P1-01 native identity/pairing; P1-02 Android original upload; P1-03 media source permissions; P1-04 durable backup queue; P1-05 backup policy and source checkpoints; P1-06 low-bandwidth/reboot recovery; P1-07 status UX and localized help.

P2-01 iOS spike; P2-02 iOS foreground/OS-permitted backup; P2-03 selected-chat import; P2-04 metadata portability improvements; P2-05 pricing measurements and billing; P2-06 optional public sharing security design.

## 19. Coding-agent handoff

Use this prompt with this document attached:

> Build the product defined in this PRD. Start with M0 feasibility and the web MVP. Inspect the repository and its instructions, then create an implementation checklist mapped to requirement IDs. Use the proposed stack unless a spike provides a concrete reason to change it. Implement production behavior with real Telegram integration behind a testable adapter; keep mock adapters limited to tests/local demos. Do not claim provider limits, background behavior, exactly-once sends or secure native identity without a demonstration. Keep secrets outside source control. Make routine reversible implementation choices independently. Work milestone by milestone, run relevant tests, and update the checklist and decision log. Stop only on missing credentials or a genuine blocked provider/architecture decision. Prepare a reviewable local build before deployment; never deploy, charge users, delete real Telegram content or publish an app without explicit authorization. Begin by proving login, original-byte upload/download, uncertain-send recovery and session revocation with isolated test accounts.

Suggested repository layout:

```
apps/web
apps/api
apps/telegram-worker
apps/transfer-gateway
apps/android
apps/ios
packages/contracts
packages/domain
packages/test-fixtures
infra
 docs/decisions
```

Initial artifacts to implement in repo: README setup, .env.example with placeholders, Docker Compose development stack, migration files, OpenAPI schema, adapter interface, isolated test configuration, CI workflow and milestone checklist. Use compatible pinned versions verified at project setup, rather than unverified version numbers from this document.

## 20. Open decisions and feasibility blockers

| Question | Default / required resolution |
|---|---|
| Is this storage-oriented client acceptable under current Telegram rules? | Review official terms and seek clarification where unclear; blocking before external release |
| Can chosen TDLib bindings support required deployment and file sizes? | M0 proof with actual deployed infrastructure |
| Which owned storage chat works best? | Test Saved Messages and supported private storage destination, then record decision |
| How does Android-only identity securely reach backend? | Validated proof or explicit trusted pairing; insecure claimed IDs are forbidden |
| Can iOS finish useful native transfers under OS constraints? | Native spike before parity promises |
| What is the release budget/team? | User decision; does not block a local web feasibility prototype |
| Product name/domain and pricing? | CloudNest is temporary; decide before public branding/billing |
| Must folders survive loss of all app metadata? | MVP: encrypted database backups plus user export; Telegram-only recovery restores files but not full virtual organization |

## 21. Source notes and evidence boundary

Official references consulted for the baseline architecture on 31 October 2026:

- Telegram FAQ: https://telegram.org/faq . Describes cloud file access, standard/Premium per-file sizes, and inactive-account deletion. Recheck limits and account settings at implementation time.
- TDLib overview: https://core.telegram.org/tdlib . Describes the official cross-platform client library. The overview does not prove a specific binding or hosting configuration works for this product.
- Telegram API Terms: https://core.telegram.org/api/terms . Integration availability is not blanket approval of this business model. Full compliance assessment is a release gate.
- Android persistent background work: https://developer.android.com/develop/background-work/background-tasks/persistent . Use current target-SDK guidance and test real devices.
- Apple BackgroundTasks: https://developer.apple.com/documentation/backgroundtasks . Entry page retrieved; detailed scheduling and PhotoKit constraints still require implementation-time documentation review and device testing.

All architecture, schema, targets, retention defaults and estimates in this document are proposed requirements. The competitor's public frontend and promotional caption were used only to understand the product category. No authenticated competitor session, backend source or native binary was inspected.
