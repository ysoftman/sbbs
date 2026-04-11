# supabase test

이미지/동영상 갤러리 웹앱. Supabase Storage, Auth, Database 를 사용한다.

## 주요 기능

- 카테고리(디렉토리)별 이미지/동영상 조회 (최신순, 무한 스크롤)
- Google / Anonymous 로그인
- 이미지별 메시지 작성/삭제 (10,000 bytes 제한, 5개씩 더보기)
- 파일 업로드 (이미지 5MB, mp4 10MB, 디렉토리 선택)
- 본인 업로드 파일 삭제, admin 은 모든 파일 삭제 가능
- URL hash 기반 딥링크 (`#카테고리`, `#카테고리/파일명`)

## supabase 프로젝트 생성 후 최초 설정

```bash
# https://supabase.com/dashboard 에서 새 프로젝트 생성
# Settings > General > Project ID 확인 후 Project URL 조합 (.com 이 아니라 .co 임에 주의)
# Settings > API Keys > Publishable and secret API keys 탭에서 확인
# src/supabase_config.js(.gitignore 로 추가했음) 생성
cat << zzz >! src/supabase_config.js
export const supabaseUrl = () => {
  return "https://<project-id>.supabase.co";
};

export const supabasePublishableKey = () => {
  return "sb_publishable_...";
};
zzz
```

## supabase 대시보드 설정

### Authentication 설정

- Google Cloud Console 에서 OAuth 클라이언트 생성:
  1. [Google Cloud Console](https://console.cloud.google.com/) 접속
  2. **API 및 서비스 > OAuth 동의 화면** 에서 동의 화면 생성 (없는 경우)
     - 테스트 단계에서는 **테스트 사용자**에 본인 이메일을 추가해야 로그인 가능
  3. **API 및 서비스 > 사용자 인증 정보 > + 사용자 인증 정보 만들기 > OAuth 클라이언트 ID** 선택
  4. 애플리케이션 유형: **웹 애플리케이션**
  5. **승인된 리디렉션 URI** 에 추가: `https://<project-id>.supabase.co/auth/v1/callback`
  6. **만들기** 클릭 후 **클라이언트 ID** 와 **클라이언트 보안 비밀번호** 복사
- Supabase 대시보드에서 Google 제공자 활성화:
  1. Authentication > Sign In / Providers > Third-Party Auth 탭 > Google 활성화
  2. Client IDs: 위에서 복사한 클라이언트 ID 입력 (공백 없이, 쉼표로 구분)
  3. Client Secret (for OAuth): 위에서 복사한 클라이언트 보안 비밀번호 입력
  4. Callback URL (for OAuth): `https://<project-id>.supabase.co/auth/v1/callback` (자동 생성됨)
- Authentication > Sign In / Providers > Supabase Auth 탭 > Allow anonymous sign-ins 활성화
- Authentication > URL Configuration 설정:
  - **Site URL**: `https://ysoftman.github.io/supabase` (로그인 후 최종 redirect 대상)
  - **Redirect URLs**: `https://ysoftman.github.io/supabase` 추가
  - 로컬 테스트 시 `http://localhost:5173/sbbs/` 도 Redirect URLs 에 추가
- Google Cloud Console > OAuth 클라이언트 > **승인된 자바스크립트 원본**에 `http://localhost:5173` 추가

### Storage 설정

```bash
# Storage > New bucket > "images" 버킷 생성 (Public bucket 체크)
# 이미지 파일 업로드는 대시보드에서 드래그앤드롭으로 가능
```

### Storage Policy 설정

Storage > Policies > images 버킷 > New policy:

- Policy name: `read image`
- Allowed operation: SELECT 체크 (download, list, createSignedUrl, createSignedUrls, getPublicUrl 허용됨)
- Target roles: 기본값 (all public roles)
- Policy definition: `bucket_id = 'images'`

### Database 설정

테이블 생성, RLS 정책, 마이그레이션은 [DATABASE.md](DATABASE.md) 참조.

### Storage 파일명 제한 (non-ASCII 문자 불가)

Supabase Storage 는 한글, 중국어 등 non-ASCII 문자가 포함된 파일명을 지원하지 않는다.
대시보드에서 드래그앤드롭 업로드 시 `InvalidKey` 에러가 발생한다.

- `병아리.jpg` (X) → `chick.jpg` (O)
- `방독면-아이콘.png` (X) → `gas_mask_icon.png` (O)

관련 이슈:

- <https://github.com/supabase/supabase/issues/34595>
- <https://github.com/supabase/storage/issues/133>
- <https://github.com/supabase/supabase/issues/22974>

## 프로젝트 배포

```bash
# mise 툴로 이프로젝트에서 사용할 node 버전 고정 및 설치
mise use node@24

# 최초 한번만 패키지 설치
bun install

# 로컬 테스트 (vite 가 빌드 + 서빙을 자동으로 해준다)
bun dev

# 로컬 확인
# http://localhost:5173/
```

## GitHub Pages 배포

### GitHub Actions 자동 배포

`supabase/` 하위 파일이 변경되어 `main`에 push 되면 GitHub Actions 가 자동으로 빌드/배포한다.

- workflow 파일: `.github/workflows/deploy-supabase.yml`
- 배포 URL: `https://ysoftman.github.io/supabase/`

### GitHub 레포 설정 (최초 1회)

1. GitHub 레포 > Settings > Pages > Source 를 `GitHub Actions` 로 변경

### GitHub Secrets 설정 (최초 1회)

`src/supabase_config.js` 는 `.gitignore` 에 포함되어 있어 GitHub Actions 빌드 시 존재하지 않는다.
GitHub Secrets 로 주입해야 한다.

1. GitHub 레포 > Settings > Secrets and variables > Actions
2. **Repository secrets** 에 다음 추가:
   - `SUPABASE_URL`: Supabase Project URL
   - `SUPABASE_PUBLISHABLE_KEY`: Supabase Publishable Key (`sb_publishable_...`)

## 참고

- <https://supabase.com/docs>
- <https://supabase.com/docs/guides/auth>
- <https://supabase.com/docs/guides/storage>
- <https://supabase.com/docs/guides/database>
- <https://nostalgic-css.github.io/NES.css/#installation>
