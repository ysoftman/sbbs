# simple bbs

Image/video gallery web app using Supabase Storage, Auth, and Database.

## Key Features

- Browse images/videos by category (directory), sorted by newest, with infinite scroll
- Google / Anonymous sign-in
- Per-image comments: create/delete (10,000 bytes limit, load more in batches of 5)
- File upload (images 5MB, mp4 10MB, with directory selection)
- Delete your own uploaded files; admins can delete any file
- URL hash-based deep linking (`#category`, `#category/filename`)

## Initial Setup After Creating a Supabase Project

```bash
# Create a new project at https://supabase.com/dashboard
# Check Settings > General > Project ID and compose the Project URL (note: .co, not .com)
# Check Settings > API Keys > Publishable and secret API keys tab
# Create src/supabase_config.js (added to .gitignore)
cat << zzz >! src/supabase_config.js
export const supabaseUrl = () => {
  return "https://<project-id>.supabase.co";
};

export const supabasePublishableKey = () => {
  return "sb_publishable_...";
};
zzz
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
  - **Site URL**: `https://ysoftman.github.io/supabase` (final redirect target after sign-in)
  - **Redirect URLs**: add `https://ysoftman.github.io/supabase`
  - For local testing, also add `http://localhost:5173/sbbs/` to Redirect URLs
- Google Cloud Console > OAuth client > Add `http://localhost:5173` to **Authorized JavaScript origins**

### Storage Setup

```bash
# Storage > New bucket > Create "images" bucket (check "Public bucket")
# You can upload image files via drag-and-drop in the dashboard
```

### Storage Policy Setup

Storage > Policies > images bucket > New policy:

- Policy name: `read image`
- Allowed operation: check SELECT (allows download, list, createSignedUrl, createSignedUrls, getPublicUrl)
- Target roles: default (all public roles)
- Policy definition: `bucket_id = 'images'`

### Database Setup

For table creation, RLS policies, and migrations, see [DATABASE.md](DATABASE.md).

### Storage Filename Restrictions (non-ASCII Characters Not Allowed)

Supabase Storage does not support filenames containing non-ASCII characters such as Korean or Chinese.
Drag-and-drop uploads in the dashboard will result in an `InvalidKey` error.

- `병아리.jpg` (X) → `chick.jpg` (O)
- `방독면-아이콘.png` (X) → `gas_mask_icon.png` (O)

Related issues:

- <https://github.com/supabase/supabase/issues/34595>
- <https://github.com/supabase/storage/issues/133>
- <https://github.com/supabase/supabase/issues/22974>

## Project Deployment

```bash
# Pin and install the Node version for this project using mise
mise use node@24

# Install packages (first time only)
bun install

# Local development (vite handles build + serving automatically)
bun dev

# Local preview
# http://localhost:5173/
```

## GitHub Pages Deployment

### Automatic Deployment via GitHub Actions

When files under `supabase/` are changed and pushed to `main`, GitHub Actions automatically builds and deploys.

- Workflow file: `.github/workflows/deploy-supabase.yml`
- Deployment URL: `https://ysoftman.github.io/supabase/`

### GitHub Repo Settings (One-Time Setup)

1. GitHub repo > Settings > Pages > Change Source to `GitHub Actions`

### GitHub Secrets Setup (One-Time Setup)

`src/supabase_config.js` is included in `.gitignore`, so it does not exist during GitHub Actions builds.
It must be injected via GitHub Secrets.

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
