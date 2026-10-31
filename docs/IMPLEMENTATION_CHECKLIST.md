# PRD implementation checklist

This checklist distinguishes implemented paths from demonstrated provider acceptance. The [PRD](PRD.md) remains the source of truth; [ADR 0002](decisions/0002-long-running-server-mode.md) records the server-mode update. Live Telegram credentials have not been supplied.

| Requirement | Implemented for review | Remaining acceptance evidence |
| --- | --- | --- |
| AUTH-01 | Provider-state adapter/RPC, application login/session flow, shared PostgreSQL rate counters, refresh/CSRF boundaries, explicit connection disclosure | Isolated-account phone/code/2FA, invalid/expired states, provider delay, session revocation/outage and no-credential-log proof |
| SETUP-01 | Account-bound provider destination selection and storage mapping; Saved Messages feasibility path | Actual permissions, private destination compatibility and recovery verified against provider |
| FILE-01 | Browser demo or server mode; resumable staging, exact offsets/checksums, durable transfer records and provider dispatch boundary | Actual original Telegram bytes, confirmed send, crash/lost-ack recovery and 500 MiB deployed-gateway proof |
| FILE-02 | Folders/search/favorites/grid/list, tenant-scoped PostgreSQL catalog, row versions and request keys | Representative production concurrency and 100k-record cursor/latency measurement |
| FILE-03 | Browser-local preview/download; server staged-original/range handling and provider original-fetch boundary | Deployed media-origin isolation, MIME sniffing, compatible streaming and provider byte/range equality |
| DELETE-01 | Reversible app trash/restore, catalog tombstones and explicit remote-delete boundary | Real remote permissions, uncertain/partial deletion behavior and external-provider deletion reconciliation |
| SYNC-01 | Catalog export, durable selected-chat scan jobs/checkpoints and tenant-bound import | Real-provider restart/rescan, external deletion/update reconciliation and metadata restore proof |
| BACKUP-01 | Explicitly deferred native Android release | Secure binding, native TDLib, scoped media, Room queue and real-device recovery/background matrix |
| BACKUP-02 | Explicitly deferred native iOS release | Native feasibility, PhotoKit limited access, cloud-only preparation and OS-permitted completion tests |
| ACCOUNT-01 | Product-session/device and disconnect boundaries; product trash does not delete Telegram | Full job-stop/revocation proof and implemented primary/backup deletion deadlines before release commitments |

## M0 — provider feasibility

- [x] Preserve PRD and isolate testable adapter/domain contracts.
- [x] Supply guarded TDLib developer harness and private worker RPC.
- [x] Keep unknown sends visible; do not fabricate provider completion.
- [ ] Obtain developer-owned credentials and an isolated test account.
- [ ] Record current provider-policy review.
- [ ] Prove actual login, original-byte equality, uncertain-send recovery, worker restart and revocation.
- [ ] Prove durable message resolution after replacing the TDLib database.
- [ ] Validate deployed gateway/file limits and provider networking.

## M1 — foundation

- [x] TypeScript workspace, reproducible package lock, CI, Dockerfiles and local Compose stack.
- [x] Ordered checksum-tracked migration runner and explicit restricted runtime-role bootstrap.
- [x] PostgreSQL schema with composite tenant FKs, forced RLS and bounded auth helpers.
- [x] PostgreSQL catalog/auth repositories and secure server API integration path.
- [x] Actual initial/runtime schema applied in the isolated development database during integration.
- [x] Record restricted-role, runtime-auth, API, browser and backend-container checks in [VALIDATION.md](VALIDATION.md).
- [ ] Verify actual encrypted staging/session mounts, KMS wrapping/key rotation and production worker/network isolation.

## M2–M3 — drive and reliability

- [x] Responsive drive with English/Bangla controls; optional server-backed mode beside browser demo.
- [x] Resumable staging/domain validation and account-scoped original-byte mount shared with worker.
- [x] Durable PostgreSQL transfer dispatch and authenticated internal RPC wiring.
- [x] Keep app trash and remote Telegram deletion separate.
- [x] Vercel-compatible frontend rewrite to an external long-running API.
- [ ] Prove provider reconciliation after send-ack loss and process death without silent duplicates.
- [ ] Complete expiring worker leases, multi-worker takeover and dispatch/outbox guarantees under failure.
- [x] Add durable selected-chat recovery scan jobs and persisted pending-revocation retry state.
- [x] Add completed-transfer byte cleanup and inactive staging expiry paths.
- [ ] Prove cleanup across disconnected/revoked accounts, global/per-user reservations and stale-chunk recovery.
- [ ] Prove provider recovery scans, complete account-local duplicate decisions and run metadata import/restore drill.
- [ ] Prove production preview isolation/MIME handling and all operational [release gates](RELEASE_GATES.md).

## Validation boundary

Unit, API, database and browser checks provide local evidence only. Parent integration records the latest final test counts and container results; this checklist does not infer them from implementation status. Redis is available in development, but current dispatch polls PostgreSQL and must not be described as BullMQ/outbox completion.

Android/iOS native apps, broad existing-chat linking, public sharing, local-device cleanup, billing and an E2EE vault remain deferred. Installing a PWA does not enable guaranteed background camera backup.
