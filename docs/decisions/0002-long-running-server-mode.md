# ADR 0002: Optional PostgreSQL/API mode and authenticated worker RPC

Status: implemented for review; live provider and operational acceptance pending.

This supersedes ADR 0001's initial demo-only runtime decision while retaining the browser demo as a separate mode. The frontend chooses browser-local demo or server catalog using the build-time `NEXT_PUBLIC_STORAGE_MODE` setting. Server mode uses same-origin `/v1` rewrites to a separately running API. This permits Vercel frontend hosting without attempting to run persistent TDLib sessions or relay transfers in serverless functions.

The API uses the normalized PostgreSQL repository and provider-verified application identity flow. Catalog and login/session transactions run under a restricted database role with forced RLS, scoped tenant/login settings and bounded SECURITY DEFINER auth helpers. A migration-owner connection is used only by the migration/bootstrap process. It is never passed to the API. Refresh reuse handling, row versions and stable request keys constrain concurrent/repeated effects.

The API dispatches durable PostgreSQL transfer state to a private, authenticated, long-running worker RPC. API and worker share the staging mount; the worker validates account-scoped paths. PostgreSQL polling is the current dispatch mechanism. Redis is provisioned in development for later queue integration, but BullMQ/outbox delivery is not claimed as implemented by this Compose stack.

The worker can report health without initializing a provider account. Real account RPC remains gated on explicit worker enablement, credentials and operator-approved session storage. Encrypted-volume approval is an acknowledgement, not a cryptographic check, KMS integration or proof that media/journal bytes are encrypted. Account worker locks and uncertain-send journals do not establish expiring multi-worker failover or cross-database stable message identity.

The one-command local stack runs PostgreSQL, Redis, a one-shot migration/bootstrap, API, worker and optional Next.js frontend. It generates local secrets without printing them, binds user-facing ports to loopback and exposes no worker port. Images run as non-root users; API/worker have read-only roots and writable mounted data paths. Production still requires TLS, actual encrypted mounts, KMS/key lifecycle, network controls, backups, monitoring and the live-provider release gates.
