# simple bbs

Image/video gallery web app using Supabase Storage, Auth, and Database.

## Key Features

- Browse images/videos by category (directory), sorted by newest, with infinite scroll
- Google / Anonymous sign-in
- Per-image comments: create/delete (10,000 bytes limit, load more in batches of 5); admins can delete any comment
- File upload via button, paste, or drag and drop (images 5MB, mp4 10MB, with directory selection)
  - Supported types: JPEG, PNG, GIF, WebP, BMP, MP4 (SVG is rejected because a scripted SVG would run on the storage origin)
  - JPEG/PNG/WebP/BMP are re-encoded before upload (EXIF stripped, downscaled to at most 2560×2560 px of area,
    PNG/BMP/lossless WebP kept lossless where possible); the 5MB limit applies after re-encoding
- Delete your own uploaded files; admins can delete any file
- Admins can add (empty) categories
- URL-based deep linking (`#category`, `#category/filename`, search `?q=`)

## Initial Setup After Creating a Supabase Project

```bash
# Create a new project at https://supabase.com/dashboard
# Check Settings > General > Project ID and compose the Project URL (note: .co, not .com)
# Check Settings > API Keys > Publishable and secret API keys tab
# Create .env (gitignored) from .env.example; Bun inlines these PUBLIC_* env vars into src/supabase_config.js
cp .env.example .env
# PUBLIC_SUPABASE_URL=https://<project-id>.supabase.co
# PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

## Supabase Dashboard Configuration

### Authentication Setup

- Create an OAuth client in Google Cloud Console:
  1. Go to [Google Cloud Console](https://console.cloud.google.com/)
  2. Under **APIs & Services > OAuth consent screen**, create a consent screen (if none exists)
     - During testing, add your email to **Test users** to enable sign-in
  3. Go to **APIs & Services > Credentials > + Create Credentials > OAuth client ID**
  4. Application type: **Web application**
  5. Add to **Authorized redirect URIs**: `https://<project-id>.supabase.co/auth/v1/callback`
  6. Click **Create**, then copy the **Client ID** and **Client secret**
- Enable Google provider in Supabase Dashboard:
  1. Authentication > Sign In / Providers > Third-Party Auth tab > Enable Google
  2. Client IDs: enter the copied Client ID (no spaces, comma-separated)
  3. Client Secret (for OAuth): enter the copied Client secret
  4. Callback URL (for OAuth): `https://<project-id>.supabase.co/auth/v1/callback` (auto-generated)
- Authentication > Sign In / Providers > Supabase Auth tab > Enable "Allow anonymous sign-ins"
- Authentication > URL Configuration:
  - **Site URL**: `https://ysoftman.github.io/sbbs/` (final redirect target after sign-in)
  - **Redirect URLs**: add `https://ysoftman.github.io/sbbs/`
  - For local testing, also add `http://localhost:5173/sbbs/` to Redirect URLs
- Google Cloud Console > OAuth client > Add `http://localhost:5173` to **Authorized JavaScript origins**

### Storage Setup

```bash
# Storage > New bucket > Create "images" bucket (check "Public bucket")
# You can upload image files via drag-and-drop in the dashboard
```

Set the bucket upload limits (`file_size_limit`, `allowed_mime_types`) as server-side enforcement of the client checks;
see [DATABASE.md](DATABASE.md#storage-버킷-업로드-제한-storagebuckets).

### Storage Policy Setup

Run the `storage.objects` policies (read: public, upload: Google users, delete: uploader or admin, move: admin)
in the SQL Editor; see [DATABASE.md](DATABASE.md#storage-정책-storageobjects).

### Database Setup

For table creation, RLS policies, and migrations, see [DATABASE.md](DATABASE.md).

### Storage Filename Encoding (non-ASCII File Names)

Supabase Storage does not support filenames containing non-ASCII characters such as Korean or Chinese
(an upload results in an `InvalidKey` error).

To work around this, the app generates a unique ASCII-only storage key for every upload
(e.g. `1736012345678-a1b2c3.jpg`) instead of using the original filename. The original filename is
preserved in the `image_info.display_name` column and used for all on-screen display and search.

- Upload: `병아리.jpg` → storage path `<timestamp>-<random>.jpg`, `image_info.display_name = "병아리.jpg"`
- The key's extension comes from the MIME type. When re-encoding changes the format (usually PNG/BMP → WebP; PNG, or JPEG
  for opaque images, on browsers without WebP encoding such as Safari), the `display_name` extension changes too
  (e.g. `병아리.png` → `병아리.webp`).
- `display_name` requires a database migration (see [DATABASE.md](DATABASE.md)). Existing rows are backfilled
  with the file name part of `file_path`; rows still missing it fall back to the storage key.

Related issues:

- <https://github.com/supabase/supabase/issues/34595>
- <https://github.com/supabase/storage/issues/133>
- <https://github.com/supabase/supabase/issues/22974>

## Project Deployment

```bash
# Install packages (first time only)
bun install

# Local development (Bun dev server with HMR, dev.js)
bun dev

# Production build into dist/ (build.js)
bun run build

# Local preview
# http://localhost:5173/sbbs/
```

## GitHub Pages Deployment

### Automatic Deployment via GitHub Actions

Every push to `main` triggers GitHub Actions to build and deploy.

- Workflow file: `.github/workflows/deploy-sbbs.yml`
- Deployment URL: `https://ysoftman.github.io/sbbs/`
- The `og-preview` Edge Function is not deployed by this workflow (see [OG.md](OG.md))

### GitHub Repo Settings (One-Time Setup)

1. GitHub repo > Settings > Pages > Change Source to `GitHub Actions`

### GitHub Secrets Setup (One-Time Setup)

`.env` is gitignored, so the workflow writes it from GitHub Secrets before building.

1. GitHub repo > Settings > Secrets and variables > Actions
2. Add the following to **Repository secrets**:
   - `SUPABASE_URL`: Supabase Project URL
   - `SUPABASE_PUBLISHABLE_KEY`: Supabase Publishable Key (`sb_publishable_...`)

## References

- <https://supabase.com/docs>
- <https://supabase.com/docs/guides/auth>
- <https://supabase.com/docs/guides/storage>
- <https://supabase.com/docs/guides/database>
- <https://nostalgic-css.github.io/NES.css/#installation>
