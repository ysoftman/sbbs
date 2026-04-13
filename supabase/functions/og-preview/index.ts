// Supabase Edge Function: og-preview
// SPA 의 해시 기반 딥링크는 크롤러가 읽을 수 없으므로, 이 함수가 대신
// OG 메타태그를 포함한 HTML 을 반환하고 실제 사용자는 SPA 로 리다이렉트시킨다.
//
// 배포:
//   supabase functions deploy og-preview --no-verify-jwt
//
// 사용:
//   https://<project-id>.supabase.co/functions/v1/og-preview?p=<category>/<filename>
//
// 필요한 환경 변수 (Supabase Dashboard > Edge Functions > og-preview > Secrets):
//   SITE_URL       실제 SPA 주소 (예: https://ysoftman.github.io/sbbs/)
//   STORAGE_BUCKET (선택) 기본값 "images"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SITE_URL = Deno.env.get("SITE_URL") ?? "";
const STORAGE_BUCKET = Deno.env.get("STORAGE_BUCKET") ?? "images";

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const buildPublicUrl = (path: string): string =>
  `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")}`;

const buildSpaUrl = (path: string): string => {
  const base = SITE_URL.endsWith("/") ? SITE_URL : `${SITE_URL}/`;
  return `${base}#${encodeURIComponent(path)}`;
};

const renderHtml = (path: string): string => {
  const title = path.split("/").pop() ?? path;
  const imageUrl = buildPublicUrl(path);
  const spaUrl = buildSpaUrl(path);
  const isVideo = path.toLowerCase().endsWith(".mp4");
  const ogType = isVideo ? "video.other" : "website";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - sbbs</title>
<meta name="description" content="${escapeHtml(path)}">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(path)}">
<meta property="og:url" content="${escapeHtml(spaUrl)}">
<meta property="og:image" content="${escapeHtml(imageUrl)}">
${isVideo ? `<meta property="og:video" content="${escapeHtml(imageUrl)}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(path)}">
<meta name="twitter:image" content="${escapeHtml(imageUrl)}">
<meta http-equiv="refresh" content="0; url=${escapeHtml(spaUrl)}">
<link rel="canonical" href="${escapeHtml(spaUrl)}">
</head>
<body>
<script>window.location.replace(${JSON.stringify(spaUrl)});</script>
<p>Redirecting to <a href="${escapeHtml(spaUrl)}">${escapeHtml(spaUrl)}</a></p>
</body>
</html>`;
};

Deno.serve((req: Request) => {
  const url = new URL(req.url);
  const path = url.searchParams.get("p");
  if (!path) {
    return new Response("missing ?p=<path>", { status: 400 });
  }
  // 간단한 경로 검증: 상위 탈출 방지, 비어있지 않음
  if (path.includes("..") || path.startsWith("/")) {
    return new Response("invalid path", { status: 400 });
  }
  if (!SITE_URL) {
    return new Response("SITE_URL env not configured", { status: 500 });
  }
  return new Response(renderHtml(path), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // 크롤러/CDN 캐싱: 이미지 메타데이터는 거의 변하지 않음
      "cache-control": "public, max-age=3600",
    },
  });
});
