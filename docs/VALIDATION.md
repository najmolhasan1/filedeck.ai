# Verification record

Verified on 30 October 2026 with Node.js 24 and an isolated PostgreSQL 17.6 database. Provider fixtures exist only in tests; no Telegram account was opened.

| Check | Result |
| --- | --- |
| Workspace tests with real PostgreSQL fixtures enabled | 70 passed: API 21, worker 21, web 14, domain 14 |
| Workspace TypeScript checks | All packages passed |
| Production Next.js build | Passed in browser-demo mode and server mode |
| Browser demo journeys | Six passed: persisted original downloads/trash/restore, bulk move/export, mobile/Bangla/unsafe-preview fallback, failed persistence, duplicate-original reuse, metadata restore |
| Server browser journey | Passed phone/code/2FA, explicit Saved Messages selection, staged-versus-confirmed upload, rename, exact download, reload and logout against actual PostgreSQL and a test-only provider |
| Production HTTP integration | Passed CSRF, tenant denial, provider-confirmed catalog creation, ranges/416, canonical-session reconnect, recovery and tombstones, malformed cookies and logout; an additional regression verifies open SSE streams stop after session revocation |
| Database migration runner | All five migrations applied to a fresh database; a second run verified checksums and skipped them; restricted-role bootstrap passed |
| Native TDLib | Loaded and executed a non-account synchronous operation on host and in the non-root backend container |
| Backend Docker image | Built successfully; non-root API startup/denial and worker health, bearer authentication and missing-credential denial passed |
| Setup and Compose | Script syntax, private random-secret setup, repeat preservation and Compose configuration passed |

CI now provisions PostgreSQL, applies migrations with a restricted application role, runs database/API checks and both browser suites. Its first GitHub execution remains pending repository access.

## Reproduce

```sh
npm ci
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

For database and connected-browser fixtures, use a disposable database with all migrations and the restricted runtime role. Set `TEST_DATABASE_URL` to that runtime connection and `TEST_ADMIN_DATABASE_URL` to the disposable migration-owner connection:

```sh
npm test
npm run test:server
npm run test:server-ui
```

Database tests explicitly skip when the test connection variables are absent. They were enabled for the counts above. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select an existing Chromium binary; otherwise install the browser matching the checked Playwright version.

## Still requires external configuration and evidence

Live Telegram phone/code/2FA, provider upload/download, process-death recovery and revocation have not been demonstrated with a real account. Developer credentials, an isolated account and an approved encrypted session mount are required. Native binding availability does not prove provider reachability or acceptance.

The complete Compose stack with a real Telegram session, encrypted production storage/KMS, account lifecycle deletion, isolated media origin, global staging quotas, multi-worker failover, large-file limits and operating SLOs remain release gates. See [release gates](RELEASE_GATES.md). Android/iOS backup, billing and public links remain deferred.

GitHub push is still blocked by unavailable repository authentication. No app was published or charged for this verification.
