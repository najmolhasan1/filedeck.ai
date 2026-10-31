# Vercel zero-cost deployment

CloudNest can be hosted **100% on Vercel at $0 cost** with direct browser-to-Telegram MTProto transfers over WebSockets.

In this architecture, file bytes and user credentials bypass intermediary servers entirely:
- **Zero server costs:** Vercel serves the static Next.js frontend on its global CDN for free.
- **Zero storage & bandwidth costs:** Telegram hosts all original files in the user's private storage chat (**Saved Messages**) with unlimited storage and free bandwidth.
- **Zero database costs:** The catalog metadata (virtual folders, tags, file index) persists in the browser's IndexedDB and automatically backs up to the user's Telegram storage chat (`#cloudnest_catalog_sync`).

## How to deploy on Vercel

1. Import `najmolhasan1/filedeck.ai` into [Vercel](https://vercel.com/new).
2. Set **Root Directory** to `apps/web`.
3. Set **Framework Preset** to **Next.js**.
4. Enable **Include source files outside of the Root Directory in the Build Step** (required for monorepo root `package-lock.json`).
5. Build and install settings are handled automatically via `apps/web/vercel.json`:
   - **Install Command:** `cd ../.. && npm ci --workspace=@cloudnest/web --include-workspace-root`
   - **Build Command:** `npm run build`
   - **Output Directory:** `.next`

## Environment variables (optional)

| Variable | Description |
| --- | --- |
| `NEXT_PUBLIC_TELEGRAM_API_ID` | Optional. Your Telegram API ID from [my.telegram.org](https://my.telegram.org). |
| `NEXT_PUBLIC_TELEGRAM_API_HASH` | Optional. Your Telegram API Hash from [my.telegram.org](https://my.telegram.org). |

*Note: If these variables are not provided in Vercel, the app allows users to input their free API credentials directly in the Connect dialog, saving them in their browser's local storage.*
