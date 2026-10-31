# Development and verification

Use Node.js 24. `npm ci` uses the checked-in workspace lockfile. The browser, API and worker are separate services; choose the mode intentionally.

## Browser-only demo

```sh
npm ci
npm run dev
```

At `http://localhost:3000`, demo metadata remains in browser storage and uploaded originals remain in **IndexedDB**. No remote backup is implied. A browser/profile change or clearing site data can remove these local originals.

## One-command local server stack

```sh
node scripts/dev-stack.mjs up --web
```

The script creates `.env` privately when absent, with distinct random local database, worker RPC and preauthorization-cookie secrets. It creates local staging/session directories, builds Node 24 long-running containers, starts PostgreSQL/Redis, executes ordered checksum-tracked migrations, creates a `NOSUPERUSER NOBYPASSRLS` runtime role, and starts API/worker/optional frontend.

- Frontend: `http://localhost:3000`, built with `NEXT_PUBLIC_STORAGE_MODE=server`.
- API health: `http://localhost:4000/v1/health`.
- Worker: container-internal port 4001; never publish its RPC port.
- PostgreSQL/Redis: loopback-only host ports 5432/6379 by default.
- Redis is provisioned for later queue integration. Current durable dispatch polls PostgreSQL; it does not claim BullMQ delivery.

`node scripts/dev-stack.mjs up` omits the frontend. Run it separately with:

```sh
NEXT_PUBLIC_STORAGE_MODE=server API_URL=http://127.0.0.1:4000 npm run dev
```

`API_URL` is a base origin **without `/v1`**; Next appends the API prefix. Production server mode is a build-time setting. Demo remains the default when that setting is absent. HttpOnly session/CSRF requests pass through the same-origin rewrite. Use HTTPS for deployed origins; the explicit localhost HTTP development origin is supported.

```sh
node scripts/dev-stack.mjs setup
node scripts/dev-stack.mjs status
node scripts/dev-stack.mjs logs
node scripts/dev-stack.mjs down
```

`down` preserves named database volumes and original bytes. Do not run `down -v` on needed data. Existing `.env` files are preserved: if required secrets are absent or placeholders, set unique values of at least 32 URL-safe characters. Never print `.env` or place real credentials in a shell command that enters shared logs. Generated values are 64-character hexadecimal strings.

Compose defaults to local **unencrypted** development directories. Before enabling Telegram, select an actually encrypted mount in `CLOUDNEST_SESSION_HOST_DIR` and configure its owner/access controls. Set `CLOUDNEST_SESSION_STORAGE_APPROVED=true` only after verification. That flag does not configure encryption, KMS, worker isolation or key rotation.

## Database migration and restricted role

The stack runs `node scripts/migrate.mjs` with a migration-owner `DATABASE_ADMIN_URL`. It holds a database advisory lock, verifies applied-file SHA-256 checksums, and commits each migration plus its history record atomically. It refuses changed applied migrations. Do not edit applied files; add a new migration.

The migration role needs superuser/BYPASSRLS solely for migration and bounded SECURITY DEFINER function ownership. The HTTP API must **never** receive its URL. Bootstrap creates a dedicated `cloudnest_app` role without superuser, membership inheritance, database/role creation, replication or BYPASSRLS. It grants explicit tenant-table CRUD and bounded authentication, rate-limit, sync and revocation helpers. Existing runtime table ownership or role memberships make bootstrap fail rather than silently accepting excess privileges. A different runtime role can be selected with `POSTGRES_APP_USER` for host-run migration; Compose intentionally uses `cloudnest_app`.

`DATABASE_URL` is the restricted role for both catalog and authentication. `AUTH_DATABASE_URL` is optional and must have the same restricted privileges, never admin. The API sets tenant/login scope transaction-locally after validating signed or hashed credentials. The runtime cannot create schema objects. Auth helper functions have a fixed search path and PUBLIC execution revoked.

For host processes, export settings from `.env` through a trusted environment runner. Plain API/worker npm scripts do not automatically source it. The migration/dev-stack scripts parse `.env` as data and never evaluate shell commands or substitutions. For a host API with generated configuration, use `CLOUDNEST_API_ENABLE=true node --env-file=.env --import tsx apps/api/src/main.ts`; the worker can use `node --env-file=.env --import tsx apps/telegram-worker/src/server.ts`. Stop the corresponding Compose service first to avoid shared ports/account state. `CLOUDNEST_DEMO=1 npm run dev:api` remains a loopback-only legacy JSON demo and is separate from server mode.

A pre-existing manually migrated database without migration-history records requires an explicit operator baseline; the runner will not silently adopt it or drop tables. Database restore and tenant-role integration tests remain release evidence to maintain.

## Telegram connection and internal RPC

Required worker settings:

- `CLOUDNEST_WORKER_TOKEN`: 32+ characters, shared only with the API.
- `CLOUDNEST_WORKER_ENABLE=true` and `CLOUDNEST_SESSION_STORAGE_APPROVED=true`.
- Developer-owned `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and secret `TDLIB_DATABASE_KEY`.
- `TDLIB_STATE_DIR`: approved encrypted path inside the worker; Compose mounts `/data/tdlib`.
- `STAGING_ROOT`: the same original-byte mount for API and worker (`/data/staging` in Compose).

Missing configuration permits health reporting but denies real account RPC. No phone/code/password is logged or stored as analytics. The adapter is initialized per isolated account, and only allowed storage destinations are used. The server connection requires the disclosure that its Telegram session has broader technical scope than app-selected chats.

Server sync routes queue selected-chat recovery scans and expose durable page/file counters. They never authorize arbitrary chat traversal. The API also retries persisted pending revocations and cleans completed/inactive staging through its background services. `CLOUDNEST_DISPATCH_AUTO=false` pauses the dispatch and sync timers for deterministic QA; leave it unset for normal service operation. SSE emits an account-scoped status snapshot every two seconds; its event IDs are connection-local, not a durable replay log.

Do not infer a confirmed send from browser or staging completion. Unknown outcomes must reconcile before retry. The worker journal/locking is a local mechanism; lease expiry, multi-worker failover, KMS wrapping and cross-database durable message identity remain release gates.

The separate interactive developer harness is documented in [its README](../apps/telegram-worker/README.md). It needs `CLOUDNEST_SPIKE_ENABLE=true` and an isolated test account:

```sh
npm run spike --workspace=@cloudnest/telegram-worker
```

Live Telegram credentials have not been supplied in this session. Provider login, original-byte equality, uncertain-send recovery, session revocation and deployment-network access therefore remain unverified. Do not use customer accounts as test fixtures.

## Build proxy and CA

The Dockerfile preserves inherited proxy settings and keeps TLS verification enabled. A public CA bundle is mounted as a BuildKit secret only for dependency installation. The stack script chooses the inherited `CODEX_PROXY_CERT`, a system CA bundle, or an empty optional secret on systems with ordinary trust. Set `CLOUDNEST_BUILD_CA_FILE` to a PEM bundle when needed. It is never copied into the image. Do not replace trust checks with insecure flags. Managed environments need their configured network/credential setup; the Compose file cannot grant egress or prove provider reachability.

## Checks and release limits

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

PostgreSQL integration checks use an isolated disposable database and a restricted test role. Unit/adapter tests use controlled transports; they do not connect to Telegram. Browser workflow tests need an available Chromium/Playwright browser. Record current results separately from [release gates](RELEASE_GATES.md): a local green build does not establish real-provider byte equality, crash recovery, encrypted-volume configuration, metadata restore or measured SLOs.
