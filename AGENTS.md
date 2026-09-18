# AGENTS.md

Guidance for AI agents working in this repository.

## Project Overview

**sbbs** (simple bbs) is a single-page image/video gallery web app. Vanilla JS (no framework), Vite build, Supabase backend (Storage + Postgres + Auth + one Edge Function), deployed to GitHub Pages. There is **no test suite** — verification is manual via `bun dev`.

## Commands

- Package manager: **bun** (never npm). `bun install`, `bun dev`, `bun run build`
- Node version pinned by `mise.toml` (`mise install` if node is missing)
- Lint/format: **Biome** (`biome.json`, devDependency, no npm script) — run `bunx biome check --write` after code changes
- Markdown lint: **rumdl** (`.rumdl.toml`, line-length rule disabled)
- Edge Function deploy: `supabase functions deploy og-preview --no-verify-jwt` (see `OG.md`)
- Deployment: push to `main` → GitHub Actions (`.github/workflows/deploy-sbbs.yml`) builds with bun and deploys `dist/` to GitHub Pages

## Environment Setup

The app reads Supabase credentials from Vite env vars, not from a hardcoded config:

- Local dev: create `.env` from `.env.example` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`
- `src/supabase_config.js` just re-exports `import.meta.env.VITE_*` (it is committed; the README's claim that it is gitignored is stale)
- CI injects `.env` from GitHub Secrets (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`)
- Dev server runs at `http://localhost:5173/sbbs/` (vite `base: "/sbbs/"`)

## Code Organization

Single entry point: `index.html` → `src/index.js`. All DOM manipulation is hand-rolled with `innerHTML` template strings.

| File | Responsibility |
|---|---|
| `src/common.js` | Supabase client singleton, auth UI (Google OAuth redirect + anonymous), shared user state |
| `src/storage.js` | Storage bucket `images` ops: list dirs/files, upload/move/delete, view-counter RPC |
| `src/image.js` | Image overlay (comments, likes, share link, admin move), deep-link handling |
| `src/message.js` | Per-image comments (`image_messages` table), paged 10 initially then 5 |
| `src/index.js` | Gallery list/grid, infinite scroll, hash routing, search, keyboard shortcuts, theme |
| `src/utils.js` | `escapeHtml`, formatters, `toSafeId`, dicebear avatars, `showAlert`/`showConfirm` modals |
| `supabase/functions/og-preview/index.ts` | Deno Edge Function: serves OG meta tags to crawlers, JS-redirects humans to the SPA |

## Data Architecture

- Storage bucket `images`: files live under category "directories". In `storage.list()` results, **folders have `id === null`, files have non-null `id`**.
- `image_info` table: keyed by `file_path` (UNIQUE), holds `user_id`, `user_name`, `display_name`.
- `image_messages` and `image_likes` reference `image_info.file_path` with **ON DELETE/UPDATE CASCADE** — deleting/moving a file only requires touching storage + `image_info`; related rows follow automatically.
- `admins` table: admin check is `EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid())`.
- `index` table (yes, an SQL keyword): view counter, incremented atomically via `increment_view_cnt` RPC. Likes toggle via `toggle_like` RPC. RPCs are `SECURITY DEFINER`; **never implement counters client-side with read-modify-write**.
- RLS: reads are public; uploads/likes require non-anonymous auth (`auth.jwt() ->> 'is_anonymous' != 'true'`); comments require any auth including anonymous; deletes restricted to owner or admin. Client code enforces the same rules before calling (e.g. `deleteFile` in `src/storage.js`).

## Gotchas (things that will bite you)

1. **Non-ASCII filenames**: Supabase Storage rejects non-ASCII keys with `InvalidKey`. Uploads generate an ASCII storage key `<timestamp>-<random6>.<ext>` and store the original filename in `image_info.display_name`. Always use `display_name` for UI/search and `file_path` for storage/DB operations.
2. **Web Locks contention**: concurrent `supabase.auth.getUser()` calls race. Use the cached `getCurrentUser()` from `src/common.js` instead.
3. **Anonymous → Google login**: must `signOut()` the anonymous session before `signInWithOAuth`, otherwise the anonymous session survives the OAuth redirect.
4. **No migration tooling**: schema changes are SQL run manually in the Supabase SQL Editor. `DATABASE.md` is the source of truth for tables, RLS policies, RPCs, and ad-hoc migrations. Update it when changing schema.
5. **Stale async guard**: `src/index.js` uses a `loadGeneration` counter — after every `await` in a load path, check `gen !== loadGeneration` and bail out, or you will append stale results to a screen the user already navigated away from. Follow this pattern for new async list loads.
6. **Pagination**: fetch `pageSize + 1` rows to detect `hasMore`, then slice.
7. **XSS**: user content is interpolated into `innerHTML` everywhere — always pass it through `escapeHtml()` (`src/utils.js`).
8. **Share links**: production copies the `og-preview` Edge Function URL (crawler-friendly); localhost copies the SPA `#hash` link, because the Edge Function's `SITE_URL` points at production. Hash routing format: `#category` / `#category/filename` (decoded with `decodeURIComponent`).
9. **`vite.config.js` injects build-time globals** (`__LAST_VERSION_TAG__`, `__LAST_COMMIT_HASH__`, etc.) read from the local `main` branch via `execSync` — builds outside a git checkout fall back to `"unknown"`.
10. **Supabase free-tier dormancy**: `keep_alive.sh` is a cron script that keeps the project awake; it must hit a real table (`/rest/v1/image_info`), not the REST root (401 with publishable key).
11. **README discrepancies**: the README references `.github/workflows/deploy-supabase.yml` (actual: `deploy-sbbs.yml`) and claims deploys trigger on `supabase/` changes (actual: any push to `main`). Trust the workflow file.

## Style Conventions

- Comments and docs (`DATABASE.md`, `OG.md`, `MIGRATION.md`) are commonly written in **Korean**; code identifiers in English. Match surrounding language when editing.
- Biome: spaces, default line width 100, **JS line width 120**, double quotes.
- Commit messages: lowercase imperative English, no conventional-commit prefixes (see `git log`).
- Docs to update with related changes: schema → `DATABASE.md`; share-link/OG behavior → `OG.md`; setup/deploy → `README.md`.
