# ADR 0001: Reviewable local web drive before provider integration

Status: accepted for this initial implementation; production feasibility remains open.

The PRD requires M0 proofs before real-account onboarding. This workspace has no Telegram developer credentials or isolated test account. A local demo allows the drive interactions and domain rules to be reviewed while keeping unverified provider actions unavailable.

We use Next.js and TypeScript for the web, NestJS for the API, and a provider adapter to isolate TDLib. The browser demo retains sample metadata and local files separately from Telegram-backed records. The local API uses a durable JSON repository for a single-process developer demo. A proposed PostgreSQL schema is supplied with composite ownership constraints and row-level security; a normalized runtime repository and migration/restore tests remain work to complete.

No Telegram upload may become completed because browser-to-server staging finished. Without a verified provider, committed staging remains queued or blocked. Uncertain sends require reconciliation; they must not trigger an automatic fresh send.

The proposed production path remains long-running Docker services for API, transfer gateway and account-isolated TDLib workers, backed by PostgreSQL, Redis/BullMQ, KMS and encrypted staging/session volumes. Cloudflare Workers or short-lived serverless functions are unsuitable for persistent TDLib sessions and multi-GB relay transfers. A separately hosted stateless frontend is compatible with this design.

Production authentication must bind a provider-verified identity to a secure application session. A claimed Telegram ID, a browser header or the local-demo identity is not a production login mechanism. Android-only identity and native pairing remain blocked on the PRD's verification design.

No deployment has been authorized. PRD section 19 explicitly says to prepare a reviewable local build and never deploy or publish an app without explicit authorization. This implementation therefore remains local.

Consequences: reviewable UI and tests can proceed now; live storage, security claims, reliability SLOs and release readiness cannot be asserted until the provider and operational gates are demonstrated.
