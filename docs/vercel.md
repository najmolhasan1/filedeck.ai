# Vercel frontend deployment

The Next.js browser demo can run on Vercel. API, PostgreSQL/Redis, resumable transfer staging and stateful TDLib workers remain separate services, as required by the PRD.

1. Import `najmolhasan1/filedeck.ai` into Vercel.
2. Set **Root Directory** to `apps/web` and **Framework Preset** to **Next.js**.
3. Enable **Include source files outside of the Root Directory in the Build Step**. This is an npm workspace; its `package-lock.json` is at the repository root.
4. Select **Node.js 24.x**.
5. Use the settings checked into `apps/web/vercel.json`:

| Setting | Value |
| --- | --- |
| Install command | `cd ../.. && npm ci --workspace=@cloudnest/web --include-workspace-root` |
| Build command | `npm run build` |
| Output directory | `.next` |

The scoped install includes the frontend and root development tools, while excluding the native TDLib worker from the Vercel build. Run these commands from `apps/web`; the install command deliberately changes to the repository root to use the root lockfile.

## Environment

No environment variables are required for the browser demo. Original uploads persist in the visitor's IndexedDB; they are not sent to Vercel storage or Telegram. Sample originals ship as public assets.

For the connected drive, set both **`NEXT_PUBLIC_STORAGE_MODE=server`** and **`API_URL=https://your-api.example`** in the Vercel project, then redeploy. Configure the backend's **`APP_ORIGIN`** to the exact HTTPS origin of the Vercel deployment, without a trailing slash. The API, PostgreSQL and authenticated worker must already be running on separate long-running infrastructure. Follow the [server setup](development.md) for migrations, worker credentials and approved session storage.

`API_URL` is optional. Set it to the HTTPS origin of a separately deployed API, without `/v1`, only when that API is ready. Vercel reads the rewrite at build time, so redeploy after changing it. Development still defaults to `http://127.0.0.1:4000`; production creates no API rewrite when `API_URL` is absent. The connection dialog clearly reports that live Telegram access is unavailable in the demo.

Keep Telegram credentials and TDLib session storage on the isolated worker infrastructure. Server mode enables the implemented account, transfer and selected-chat recovery flows when that backend is configured; publishing the frontend alone does not configure Telegram. Native camera backup remains deferred. The [release gates](RELEASE_GATES.md) remain in force.
