# Dynamic OG Preview

SPA 해시 딥링크(`#category/filename`)는 크롤러(Slack, Twitter, Discord, KakaoTalk 등)가 읽을 수 없다.
해시 fragment 는 서버로 전송되지 않으며 대부분의 크롤러는 JS 를 실행하지 않기 때문이다.

`supabase/functions/og-preview` 는 이 문제를 해결하기 위한 Edge Function 이다.

## 동작 방식

1. 사용자가 이미지 오버레이의 `copy link` 를 누르면 다음 형태의 URL 이 클립보드에 복사된다.

   ```text
   https://<project-id>.supabase.co/functions/v1/og-preview?p=<category>/<filename>
   ```

2. 이 URL 이 Slack 등에 붙여넣어지면 크롤러가 Edge Function 에 접근한다.
3. Edge Function 은 OG 메타태그(`og:title`, `og:description`, `og:image`)를 포함한 HTML 을 반환한다.
4. 실제 사용자는 `<meta http-equiv="refresh">` 와 JS `location.replace` 로 SPA 해시 URL 로 리다이렉트된다.

## 배포

```bash
# Supabase CLI 설치 (최초 1회)
brew install supabase/tap/supabase

# Supabase 계정 로그인 (최초 1회) - 브라우저가 열린다
# `supabase login` 대신 [personal access token](https://supabase.com/dashboard/account/tokens) 을 발급해서 `export SUPABASE_ACCESS_TOKEN="sbp_..."` 로 환경 변수로 지정하는 방식도 가능하다.
supabase login

# 프로젝트 연결 (최초 1회) - DB password 물어보면 그냥 Enter
supabase link --project-ref <project-id>

# Edge Function 배포
supabase functions deploy og-preview --no-verify-jwt
```

`--no-verify-jwt` 필수: 크롤러는 JWT 없이 접근한다.

## 환경 변수 설정

Supabase Dashboard > Edge Functions > og-preview > Secrets 에 다음을 설정:

- `SITE_URL`: 실제 SPA 주소. 슬래시로 끝나야 한다. 예: `https://ysoftman.github.io/sbbs/`
  - 한 개만 설정 가능. og-preview 는 외부 공유용이므로 production URL 만 넣으면 된다.
- `STORAGE_BUCKET`: (선택) 기본값 `images`

`SUPABASE_URL` 은 런타임에 자동 주입된다.

## 동작 확인

```bash
# 브라우저에서 직접 열면 SPA 로 리다이렉트되는지 확인
open "https://<project-id>.supabase.co/functions/v1/og-preview?p=test/foo.jpg"

# 크롤러처럼 curl 로 HTML 메타태그 확인
curl -s "https://<project-id>.supabase.co/functions/v1/og-preview?p=test/foo.jpg" | grep -E 'og:|twitter:'

# Slack / Twitter / Facebook 의 OG 디버거로 확인
# https://cards-dev.twitter.com/validator
# https://developers.facebook.com/tools/debug/
# https://www.opengraph.xyz/
```

## 제한

- Storage 버킷이 public 이어야 `og:image` 가 동작한다.
- 비 ASCII 파일명은 Supabase Storage 제약 때문에 어차피 업로드 불가 (README 참고).
- 크롤러가 OG 캐시를 보유하는 경우 재공유 시 즉시 반영되지 않을 수 있다. 각 플랫폼의 debugger 로 재스크래핑 요청.
