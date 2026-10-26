# AGENTS.md

Guidance for AI agents working in this repository.

## Project Overview

**sbbs** (simple bbs) is a single-page image/video gallery web app. Vanilla JS (no framework), Vite build, Supabase backend (Storage + Postgres + Auth + one Edge Function), deployed to GitHub Pages. There is **no test suite** — verification is manual via `bun dev`.

## Commands

- Package manager: **bun** (never npm). `bun install`, `bun dev`, `bun run build`
- No Node needed: scripts run Vite on the Bun runtime (`bun --bun vite`); vite's `#!/usr/bin/env node` shebang would otherwise pick up any installed node
- Lint/format: **Biome** (`biome.json`, devDependency, no npm script) — run `bunx biome check --write` after code changes
- Markdown lint: **rumdl** (`.rumdl.toml`, line-length rule disabled)
- Edge Function deploy: `supabase functions deploy og-preview --no-verify-jwt` (see `OG.md`)
- Deployment: push to `main` → GitHub Actions (`.github/workflows/deploy-sbbs.yml`) builds with bun and deploys `dist/` to GitHub Pages

## Environment Setup

The app reads Supabase credentials from Vite env vars, not from a hardcoded config:

- Local dev: create `.env` from `.env.example` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`
- `src/supabase_config.js` just re-exports `import.meta.env.VITE_*` (committed; only `.env` is gitignored)
- CI injects `.env` from GitHub Secrets (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`)
- Dev server runs at `http://localhost:5173/sbbs/` (vite `base: "/sbbs/"`)

## Code Organization

Single entry point: `index.html` → `src/index.js`. All DOM manipulation is hand-rolled with `innerHTML` template strings.

| File | Responsibility |
|---|---|
| `src/common.js` | Supabase client singleton, auth UI (Google OAuth redirect + anonymous), shared user state |
| `src/storage.js` | Storage bucket `images` ops: list dirs/files, upload (client-side image re-encode)/move/delete, view-counter RPC |
| `src/image.js` | Image overlay (native `<dialog>`: likes, comments, share link, download, delete/admin move, prev/next), deep-link handling |
| `src/message.js` | Per-image comments (`image_messages` table), paged 10 initially then 5; owner or admin can delete |
| `src/index.js` | Gallery list/grid, infinite scroll, hash routing, search (`?q=`), paste/drag-and-drop upload, keyboard shortcuts, theme |
| `src/utils.js` | `escapeHtml`, formatters, `toSafeId`, dicebear avatars, native `<dialog>` helpers (`openDialog`, `showAlert`/`showConfirm`, `showDirPicker`) |
| `supabase/functions/og-preview/index.ts` | Deno Edge Function: serves OG meta tags to crawlers, JS-redirects humans to the SPA |

## Data Architecture

- Storage bucket `images`: files live under category "directories". In `storage.list()` results, **folders have `id === null`, files have non-null `id`**. An empty category is kept alive by a `.emptyFolderPlaceholder` object (created by the admin "category" button, `createDir`); `getImageList` filters it out.
- `image_info` table: keyed by `file_path` (UNIQUE), holds `user_id`, `user_name`, `display_name`.
- `image_messages` and `image_likes` reference `image_info.file_path` with **ON DELETE/UPDATE CASCADE** — deleting/moving a file only requires touching storage + `image_info`; related rows follow automatically.
- `admins` table: admin check is `EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid())`.
- `index` table (yes, an SQL keyword): view counter, incremented atomically via `increment_view_cnt` RPC. Likes toggle via `toggle_like` RPC. RPCs are `SECURITY DEFINER`; **never implement counters client-side with read-modify-write**.
- RLS: reads are public; uploads/likes require non-anonymous auth (`auth.jwt() ->> 'is_anonymous' != 'true'`); comments require any auth including anonymous; deletes restricted to owner or admin. Client code enforces the same rules before calling (e.g. `deleteFile` in `src/storage.js`).

## Gotchas (things that will bite you)

1. **Non-ASCII filenames**: Supabase Storage rejects non-ASCII keys with `InvalidKey`. Uploads generate an ASCII storage key `<timestamp>-<random6>.<ext>` (ext from the MIME type, not the filename) and store the original filename in `image_info.display_name`. Always use `display_name` for UI/search and `file_path` for storage/DB operations. JPEG/PNG/WebP/BMP are re-encoded before upload (EXIF stripped, downscaled to ≤ 2560×2560 px of area and ≤ 8192 px per side; JPEG → JPEG q0.9, PNG/BMP/lossless WebP (`VP8L`) → lossless WebP q1.0, lossy WebP → WebP q0.9; Safari encodes PNG instead of WebP). A non-JPEG result over 5MB or larger than the original falls back: not downscaled → the original; downscaled → lossy WebP, JPEG if opaque, then the original. A failed JPEG re-encode asks before uploading the original with its EXIF. So the stored format and the `display_name` extension can differ from the picked file. SVG is not accepted: public objects are served without CSP/`nosniff`, so a scripted SVG would run on the storage origin.
2. **Web Locks contention**: concurrent `supabase.auth.getUser()` calls race. Use the cached `getCurrentUser()` from `src/common.js` instead.
3. **Anonymous → Google login**: must `signOut()` the anonymous session before `signInWithOAuth`, otherwise the anonymous session survives the OAuth redirect.
4. **No migration tooling**: schema changes are SQL run manually in the Supabase SQL Editor. `DATABASE.md` is the source of truth for tables, RLS policies, RPCs, and ad-hoc migrations. Update it when changing schema.
5. **Stale async guard**: `src/index.js` uses a `loadGeneration` counter — after every `await` in a load path, check `gen !== loadGeneration` and bail out, or you will append stale results to a screen the user already navigated away from. Pass `staleChecker(gen)` to `loadImages` so it bails out after its own awaits too. Follow this pattern for new async list loads.
6. **Pagination**: fetch `pageSize + 1` rows to detect `hasMore`, then slice.
7. **XSS**: user content is interpolated into `innerHTML` everywhere — always pass it through `escapeHtml()` (`src/utils.js`).
8. **Share links**: production shares the `og-preview` Edge Function URL (crawler-friendly); localhost shares the SPA `#hash` link, because the Edge Function's `SITE_URL` points at production. Touch devices (`pointer: coarse`) with `navigator.share` open the native share sheet instead of copying (cancel is ignored, other failures fall back to the clipboard). Hash routing format: `#category` / `#category/filename` (decoded with `decodeURIComponent`); search is `?q=`. The URL can carry both: moving to a category changes only the fragment and keeps `?q=`, so Back fires `hashchange` and restores the search. On startup and `hashchange` a valid category hash wins over `?q=`, then latest.
9. **`vite.config.js` injects build-time globals** (`__LAST_VERSION_TAG__`, `__LAST_COMMIT_HASH__`, etc.) read from the local `main` branch via `execSync` — builds outside a git checkout fall back to `"unknown"`.
10. **Supabase free-tier dormancy**: `keep_alive.sh` is a cron script that keeps the project awake; it must hit a real table (`/rest/v1/image_info`), not the REST root (401 with publishable key).
11. **List fetch contract**: `getImageDirs` / `getImageList` return `null` on error and `[]` when truly empty. Show the retry state for `null`; never treat it as an empty category.
12. **Overlay history entry**: opening the overlay pushes one same-URL history entry (`{ sbbsOverlay: true }`) and remembers that URL; browser back (popstate) closes it. On UI close it calls `history.back()` only if the marker is on top **and** `location.href` still equals the pushed URL; if the URL changed while it was open, it just clears the marker with `replaceState(null, ...)`, because going back would undo the new URL. Code that rewrites the URL keeps `history.state` (`replaceState(history.state, ...)`); the overlay's href check decides what closing does.
13. **Overlay ↔ list contract**: index.js registers `setLoadMoreHandler(fn)`; overlay next on the last rendered item awaits `fn()`, which must resolve after the next page renders (immediately when nothing is left). After delete/move, image.js removes the cards and dispatches `sbbs:item-removed` (`detail: { name }`) so index.js fixes `currentOffset`/`imagePool`; new removal paths must dispatch it too, or the next page skips an item.

## Style Conventions

- Comments and docs (`DATABASE.md`, `OG.md`, `MIGRATION.md`) are commonly written in **Korean**; code identifiers in English. Match surrounding language when editing.
- Biome: spaces, default line width 100, **JS line width 120**, double quotes.
- Commit messages: lowercase imperative English, no conventional-commit prefixes (see `git log`).
- Docs to update with related changes: schema → `DATABASE.md`; share-link/OG behavior → `OG.md`; setup/deploy → `README.md`.
