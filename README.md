# CloudNest

A personal drive for originals stored in your own Telegram account, built from the supplied [PRD](docs/PRD.md). The web app supports a browser demo and an optional server-backed catalog. The long-running backend combines a tenant-scoped PostgreSQL repository, secure application-session flow, durable transfer dispatch and authenticated TDLib worker RPC.

**Live Telegram acceptance remains blocked on developer credentials, an isolated test account and approved encrypted session storage.** This is a reviewable implementation, not an external-beta certification. No Telegram integration result should be treated as confirmed without a provider acknowledgement.

## Run the browser demo

Use Node.js 24 and npm:

```sh
npm ci
npm run dev
```

Open `http://localhost:3000`. Demo originals stay in this browser's **IndexedDB**. Demo data does not enter PostgreSQL or Telegram. Clearing site data can remove it.

## Run the long-running backend stack

With Docker and its Compose plugin installed:

```sh
node scripts/dev-stack.mjs up --web
```

This prepares a private `.env` with random local secrets, starts PostgreSQL and Redis, applies checked migrations, creates a restricted `cloudnest_app` database role, and starts the API, worker RPC and server-mode frontend. The API/drive are bound to localhost. The worker has no published port. Data volumes and local originals survive a normal stop.

The drive is at `http://localhost:3000`; API health is at `http://localhost:4000/v1/health`. Without Telegram credentials and approved encrypted session storage the worker reports unconfigured and connection attempts fail clearly. The stack never fabricates a linked account or completed upload.

```sh
node scripts/dev-stack.mjs status
node scripts/dev-stack.mjs logs
node scripts/dev-stack.mjs down
```

For backend services with a separately running Next.js frontend, omit `--web`, then run `NEXT_PUBLIC_STORAGE_MODE=server API_URL=http://127.0.0.1:4000 npm run dev`. Server mode is selected at build time for production. See [development setup](docs/development.md) for host-process configuration, migrations and the isolated Telegram harness.

## Verification and deployment

See the [verification record](docs/VALIDATION.md) for the executed database, browser and container checks.

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

The [implementation checklist](docs/IMPLEMENTATION_CHECKLIST.md) separates implemented behavior from live provider and operational release gates. The [release gates](docs/RELEASE_GATES.md) cover recovery, byte equality, isolation, encryption and native backup. Automated adapter tests use controlled transports and do not prove Telegram behavior.

Vercel can host `apps/web`. Server mode requires `NEXT_PUBLIC_STORAGE_MODE=server` and `API_URL` set to an **external long-running API origin without `/v1`**. The API and TDLib worker must run outside Vercel; the frontend rewrites same-origin `/v1` requests. See [Vercel setup](docs/vercel.md). Never put PostgreSQL admin credentials or worker tokens in public frontend variables.

## Components and data boundaries

| Path | Purpose |
| --- | --- |
| `apps/web` | Responsive Next.js drive, demo or server catalog |
| `apps/api` | NestJS auth/catalog API, resumable staging and durable dispatch |
| `apps/telegram-worker` | Internal authenticated TDLib RPC and separate M0 CLI |
| `packages/contracts` | Provider/account boundaries |
| `packages/domain` | Ownership, folder, upload, range and transfer rules |
| `infra` | Docker build, Compose services and PostgreSQL migrations |
| `scripts` | Secret-safe local stack preparation and migration/role bootstrap |
| `docs` | Requirements, decisions, operating setup and gates |

Ordinary Telegram cloud messages are not end-to-end encrypted Secret Chats. A server authorization can technically access more than the chats selected in the app. Session mount approval is an operator acknowledgement, not a KMS implementation or proof of disk encryption. Android/iOS background backup, public sharing, billing and native account pairing remain deferred.
