# Telegram worker and feasibility harness

This package contains a real TDLib account adapter, an authenticated internal HTTP worker and an isolated-account CLI. Native loading happens only when an account worker is created. Importing the module never opens a session.

Dependencies are pinned to `tdl` 8.1.0 and `prebuilt-tdlib` 0.1008069.0. No provider credentials were available during implementation; the tests use the transport seam. Actual Telegram login, original-byte round trips and revoked-session behavior remain verification gates.

## Internal HTTP service

Run `npm run serve --workspace=@cloudnest/telegram-worker` from the repository root. The service binds to `127.0.0.1:4001` by default. Set `WORKER_HOST=0.0.0.0` only on a private container network; do not publish this port. `WORKER_PORT` changes the port.

Required configuration:

- `CLOUDNEST_WORKER_TOKEN`: unique service bearer token, at least 32 characters; shared only with the API.
- `STAGING_ROOT`: absolute shared staging directory. The API must stage originals at `STAGING_ROOT/<accountKey>/<uploadId>`.
- `CLOUDNEST_WORKER_ENABLE=true`: explicit enablement.
- `CLOUDNEST_SESSION_STORAGE_APPROVED=true`: operator acknowledgement that the session/media volume has approved encryption and access controls. This flag does not establish or verify encryption.
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`: your own Telegram developer credentials.
- `TDLIB_DATABASE_KEY`: nonempty database encryption secret.
- `TDLIB_STATE_DIR`: absolute approved encrypted session/media volume, outside the source checkout.
- Optional `TDLIB_USE_TEST_DC=true`, and `WORKER_MAX_ACCOUNTS` (default 10, maximum 100).

The service can expose health with credentials missing, but provider RPCs return `ADAPTER_NOT_CONFIGURED`. Missing enablement or storage approval returns an explicit unavailable state. A missing/weak service token prevents startup. Environment files are not automatically loaded; export variables or use your process runner's env-file support.

`GET /health` returns `{service, configured, enabled, approved, activeAccounts}`. **Configured is configuration readiness, not a successful Telegram connection or completed release assessment.**

All provider calls use `POST /rpc` with `Authorization: Bearer <internal token>` and JSON `{method, accountKey, input}`. Responses are `{result}` or `{error:{code,message,retryAfterSeconds?}}`. Retry delays are also exposed in `Retry-After`. Typed requests/results are exported from `@cloudnest/contracts` as `WorkerRpcMethods`, `WorkerRpcRequest` and `WorkerRpcResponse`.

| Method | Input | Result |
| --- | --- | --- |
| `auth.start` | `{phoneNumber}` | Provider authorization state |
| `auth.step` | `{type:'code'|'password', value}` | Provider authorization state |
| `auth.state` | `{}` | State; ready includes verified `telegramUserId` from TDLib `getMe` |
| `capabilities` | `{}` | 500 MiB product cap; larger provider limits remain unverified |
| `chats.list` | `{}` | Authenticated account's Saved Messages |
| `chats.select` | `{peerId}` | Validated writable Saved Messages selection |
| `attachments.list` | `{peerId,cursor?}` | Selected-chat document history page |
| `files.send` | `{path,peerId,operationId,originalName?}` | Pending, unknown, or provider-confirmed result |
| `files.result` | `{operationId}` | Durable result; known pending message is queried for reconciliation |
| `files.fetch` | `{reference}` | Internal `{path,bytes}`; never expose this local path to a browser |
| `files.refresh` | `{reference}` | Refreshed document metadata/reference |
| `session.revoke` | `{}` | `confirmed` only after accepted logout and observed closure; otherwise `pending` |

`POST /content` uses the same bearer and JSON `{accountKey,reference}`. It streams original bytes using bounded file buffers. A single `Range` header supports bounded, open-ended and suffix ranges, returning proper 206/416 responses. The API remains responsible for product-session ownership and allowed-chat checks before invoking this internal endpoint; the adapter independently checks its account and selected peer.

The API owns login-transaction/device-to-account binding and must never accept a browser's unverified Telegram user ID as identity. Account keys are opaque identifiers, not phone numbers. A ready response gets its Telegram identity directly from the authenticated native client. A directory already bound to one Telegram identity refuses another identity.

Paths are checked lexically and through `realpath`; cross-account paths, escaping symlinks and non-regular sources are rejected. Pass `originalName` for opaque staging filenames. The adapter creates an account-owned prepared source with that basename, using a hardlink or cross-volume copy, and removes it after provider confirmation. API staging bytes must be immutable after commit. Unknown sends retain prepared bytes for reconciliation; operators must monitor and resolve them rather than treating them as confirmed or resending blindly.

Each active account has a single native client and serialized RPC work. The process enforces a maximum account count and evicts idle clients after 15 minutes. An exclusive account-directory lock blocks other workers. Graceful shutdown closes clients and releases locks; it does not revoke Telegram authorizations. After a crash, verify the old process is stopped before removing its leftover `worker.lock`. Expiring distributed worker leases are still a production reliability gate.

## Isolated developer CLI

Set `CLOUDNEST_SPIKE_ENABLE=true` and the provider variables above. Set optional `CLOUDNEST_SPIKE_ACCOUNT` (default `isolated-test-account`). Use an isolated Telegram developer/test account and an approved encrypted volume.

Run `npm run spike --workspace=@cloudnest/telegram-worker`.

1. Run `state`, then `login` and provide an international phone number. Telegram determines code delivery; SMS is not assumed.
2. Use `code` only when requested, then `password` only if Telegram requests 2FA. Codes/passwords are hidden and never logged.
3. Run `chats`, then `select <peer-id>` to select the authenticated user's Saved Messages. Other conversations are rejected.
4. Run `upload /absolute/path/to/a/small/fixture`. Keep the printed stable operation ID. Pending is not confirmed.
5. Poll `result <operation-id>`. If unknown, inspect Saved Messages and reconcile manually. The harness never blindly resends an uncertain operation, even after restarting.
6. Run `download <confirmed-message-id> /absolute/output/path`. Compare the reported SHA-256 with the source. Originals use document semantics and streaming hashing.
7. Run `logout`; a pending response requires later confirmation. Verify termination in Telegram's device settings. `quit` closes the client without asserting revocation.

The command parser accepts spaces in upload/output paths but does not expand shell quotes or `~`.

## Evidence and remaining release gates

The adapter uses actual TDLib authorization, document upload/history/download and logout calls. It restricts storage to the authenticated account's Saved Messages. File IDs are fetched fresh and never persisted as remote keys. Remote message deletion is deliberately disabled. No account/proxy rotation or provider-limit bypass exists.

The operation journal is fsynced before sending. Provider send-success updates or a confirmed lookup establish completion. A lost acknowledgement stays visible and is not blindly resent. This mechanism complements API durable records; it does not replace the PRD's full transactional outbox, distributed leases, automatic selected-chat recovery or transfer cleanup monitoring.

**Durable cross-database message identity remains a release gate.** `AttachmentRef.messageId` is currently a TDLib locator bound to this account's existing database. Restoring a fresh TDLib database needs a demonstrated remote-message resolver and history-recovery test. Do not advertise recovery from prototype locators alone.

TDLib receives its database encryption key. Media, the operation journal and prepared send sources rely on the approved encrypted volume. Per-account KMS wrapping, volume verification, worker isolation and key rotation require deployment infrastructure. The service's approval flag cannot prove those controls.

Before external beta, run isolated-account login/code/2FA, original-byte equality, lost-ack and process-death recovery, pending-revocation, selected-history scan and cross-database identity tests. Complete the Telegram API terms review and the PRD release gates. No native mobile background-backup claim is made by this worker.
