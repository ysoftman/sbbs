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

// 대표적인 OG/소셜 크롤러 user-agent 패턴
const CRAWLER_UA =
  /facebookexternalhit|Facebot|Twitterbot|Slackbot|LinkedInBot|Discordbot|TelegramBot|WhatsApp|SkypeUriPreview|kakaotalk-scrap|Daumoa|Googlebot|bingbot|Applebot|Embedly|redditbot|iframely|Pinterest|vkShare|Line|MattermostBot|Mastodon|Bytespider|PetalBot/i;

const renderHtml = (path: string, selfUrl: string): string => {
  const title = path.split("/").pop() ?? path;
  const imageUrl = buildPublicUrl(path);
  const spaUrl = buildSpaUrl(path);
  const isVideo = path.toLowerCase().endsWith(".mp4");
  const ogType = isVideo ? "video.other" : "website";

  // og:url 은 이 함수 URL 자체로 둬서 크롤러가 canonical mismatch 로 리다이렉트를 따라가지 않게 한다.
  // meta refresh 는 일부 크롤러가 따라가면서 SPA 의 기본 OG 를 읽어버리므로 사용하지 않고, JS 로만 리다이렉트한다.
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
<meta property="og:url" content="${escapeHtml(selfUrl)}">
<meta property="og:image" content="${escapeHtml(imageUrl)}">
<meta property="og:image:secure_url" content="${escapeHtml(imageUrl)}">
<meta property="og:site_name" content="sbbs">
${isVideo ? `<meta property="og:video" content="${escapeHtml(imageUrl)}">\n<meta property="og:video:secure_url" content="${escapeHtml(imageUrl)}">\n<meta property="og:video:type" content="video/mp4">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(path)}">
<meta name="twitter:image" content="${escapeHtml(imageUrl)}">
<link rel="canonical" href="${escapeHtml(selfUrl)}">
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
  // url.origin 은 내부 프록시 주소(http)라 외부에서 접근 가능한 URL 을 직접 구성한다.
  const selfUrl = `${SUPABASE_URL}/functions/v1/og-preview?p=${encodeURIComponent(path)}`;
  const ua = req.headers.get("user-agent") ?? "";
  const isCrawler = CRAWLER_UA.test(ua);

  // 실제 사용자는 HTTP 302 로 즉시 SPA 로 리다이렉트 (JS 안 깔려 있거나 인앱 브라우저에서도 동작).
  // 크롤러는 OG 메타태그가 포함된 HTML 을 받는다.
  if (!isCrawler) {
    return new Response(null, {
      status: 302,
      headers: {
        location: buildSpaUrl(path),
        vary: "user-agent",
      },
    });
  }
  return new Response(renderHtml(path, selfUrl), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // 크롤러/CDN 캐싱: 이미지 메타데이터는 거의 변하지 않음
      "cache-control": "public, max-age=3600",
      vary: "user-agent",
    },
  });
});
