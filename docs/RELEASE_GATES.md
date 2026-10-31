# Release gates

The repository now includes optional server-mode PostgreSQL/API/worker wiring. These gates remain acceptance work, not certifications. Passing local checks does not establish live-provider behavior or permit claims of reliable remote backup.

## Isolated provider feasibility

- Review current Telegram API terms for this storage-oriented use case; record the decision/date before external release.
- Use developer-owned credentials and an isolated account. Keep codes/passwords, session state and filenames out of diagnostics/analytics.
- Demonstrate actual phone/code/2FA states, expired/wrong codes, provider retry delay and revocation, including honest pending revocation during outage.
- Verify Saved Messages and each supported private destination's actual write/delete permissions. Prove stable account/peer/message/attachment resolution across TDLib database replacement.
- Upload/download known original fixtures and compare exact sizes and SHA-256. Test deployed range 206/416 boundaries and expired-reference refresh.
- Kill a worker during send and lose its acknowledgement. Prove restart/reconciliation without a silent duplicate; unknown must not cause blind resend.
- Verify standard/large-file limits through the actual gateway. Keep the configured product cap at 500 MiB until staging tests support raising it; never infer Premium status from the browser.

## Foundation and reliability

- Maintain restricted-role tenant tests for every catalog/chunk/preview/range route. HTTP processes must never receive the migration-owner database URL.
- Verify refresh rotation/reuse detection, secure HttpOnly cookies, CSRF, origin policy, shared rate limits and immediate session/job revocation under real deployment conditions.
- Verify encrypted per-account session/media and staging mounts, KMS wrapping, decrypt access, key rotation and worker isolation. An operator-approval flag does not implement or prove these.
- Prove durable transfer dispatch after queue/process failure. Current dispatch polls PostgreSQL; add/test transactional outbox guarantees and expiring single-account leases before multi-worker failover claims.
- Prove staging quotas, checksum/offset recovery, bounded buffering, cancellation races and idempotent 24-hour stale/one-hour confirmed cleanup.
- Prove allowed-chat scans resume at checkpoints and handle external deletion/revoked access without duplicate import or tombstone resurrection.
- Verify explicit remote-delete permissions, uncertainty and partial failures. Product deletion must never implicitly delete Telegram messages.
- Verify isolated preview origin, MIME sniffing, sandboxing and malicious filename/HTML/SVG fixtures.
- Demonstrate metadata export/import and a restore drill. Implement and measure chosen RPO/RTO and account-data/backup-retention deadlines before publishing them as commitments.
- Verify keyboard/screen-reader/mobile connect/upload/find/download in English and Bangla and measure PRD latency, memory and transfer reliability targets.
- Configure content-free operations/alerts and rehearse provider outage, account restriction, compromise, full disk, missing messages, worker failure and database restore.

## Native releases and publication

Android follows after reliable web transfers and secure account binding. Test on real devices: scoped/limited media permission, changed/removed assets, reboot/force stop, network policy, charging/battery restriction and process death. iOS requires its own TDLib/background feasibility proof, PhotoKit limited/cloud-only asset tests and honest catch-up-on-open copy. A PWA or emulator result does not prove continuous background camera backup.

Deploy/publish, real provider deletion and charging users require the user's applicable authorization. Keep backend runtime private, terminate HTTPS, protect worker RPC and preserve the intended audience. Recheck brand/domain and current provider/store policies. Vercel frontend hosting alone does not host the long-running backend or clear these gates.
