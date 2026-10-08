# Database 설정

Supabase SQL Editor 에서 아래 순서대로 실행한다. 뒤 테이블의 정책이 앞의 `admins` 테이블과 `set_author` 함수를 참조한다.

쓰기 원칙: 카운터(`index`)와 좋아요(`image_likes`)는 `SECURITY DEFINER` RPC 로만 쓰고 클라이언트 쓰기 정책을 두지 않는다.
작성자 필드(`user_id`, `user_name`)는 트리거가 JWT 에서 채우므로 클라이언트가 보낸 값은 무시된다.

## index 테이블

```sql
CREATE TABLE IF NOT EXISTS index (
  name TEXT PRIMARY KEY,
  view_cnt INTEGER DEFAULT 1
);

ALTER TABLE index ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read" ON index FOR SELECT USING (true);

-- 조회수 원자적 증가를 위한 RPC 함수 (쓰기 정책 없이 이 함수로만 증가)
CREATE OR REPLACE FUNCTION increment_view_cnt(doc_name TEXT)
RETURNS INTEGER AS $$
DECLARE
  new_cnt INTEGER;
BEGIN
  INSERT INTO index (name, view_cnt)
  VALUES (doc_name, 1)
  ON CONFLICT (name) DO UPDATE SET view_cnt = index.view_cnt + 1
  RETURNING view_cnt INTO new_cnt;
  RETURN new_cnt;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
```

## admins 테이블

```sql
CREATE TABLE IF NOT EXISTS admins (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id),
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE admins ENABLE ROW LEVEL SECURITY;

-- 자기 행만 보인다 (관리자 email 노출 방지). 다른 정책의 admin 확인도 자기 행만 보이면 충분하다.
CREATE POLICY "Allow read own row" ON admins
  FOR SELECT USING (user_id = auth.uid());

-- admin 등록 (email 로 user_id 조회)
-- INSERT INTO admins (user_id, email)
-- SELECT id, email FROM auth.users WHERE email = 'ysoftman@gmail.com';
```

## set_author 함수 (작성자 필드 서버 기록)

`image_info`, `image_messages` INSERT 시 `user_id`, `user_name` 을 JWT 로 덮어써 다른 사용자 행세를 막는다.
RLS `WITH CHECK` 는 BEFORE 트리거 이후에 평가된다. `auth.uid()` 가 없는 SQL Editor / service role 작업은 그대로 둔다.

```sql
CREATE OR REPLACE FUNCTION set_author()
RETURNS TRIGGER AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  NEW.user_id := auth.uid();
  NEW.user_name := CASE
    WHEN (auth.jwt() ->> 'is_anonymous')::boolean THEN 'Anonymous'
    ELSE coalesce(
      nullif(auth.jwt() -> 'user_metadata' ->> 'full_name', ''),
      nullif(split_part(auth.jwt() ->> 'email', '@', 1), ''),
      'Unknown'
    )
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;
```

## image_info 테이블

`image_messages`, `image_likes` 가 `file_path` 를 FK 로 참조하므로 먼저 생성한다.

```sql
CREATE TABLE IF NOT EXISTS image_info (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  user_name TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  user_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE image_info ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read" ON image_info FOR SELECT USING (true);

CREATE POLICY "Allow insert for google" ON image_info
  FOR INSERT WITH CHECK (
    auth.uid() IS NOT NULL
    AND auth.jwt() ->> 'is_anonymous' != 'true'
  );

CREATE POLICY "Allow update for admin" ON image_info
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM admins WHERE admins.user_id = auth.uid())
  );

CREATE POLICY "Allow delete" ON image_info
  FOR DELETE USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM admins WHERE admins.user_id = auth.uid())
  );

CREATE TRIGGER image_info_set_author BEFORE INSERT ON image_info
  FOR EACH ROW EXECUTE FUNCTION set_author();
```

## image_messages 테이블

`image_name` 은 `image_info.file_path` 를 참조하며, 이미지 삭제 시 CASCADE 로 함께 삭제된다.

```sql
CREATE TABLE IF NOT EXISTS image_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  image_name TEXT NOT NULL REFERENCES image_info(file_path) ON DELETE CASCADE ON UPDATE CASCADE,
  message TEXT NOT NULL CHECK (octet_length(message) <= 10000),
  user_name TEXT NOT NULL DEFAULT '',
  user_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE image_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read" ON image_messages FOR SELECT USING (true);

CREATE POLICY "Allow write for authenticated" ON image_messages
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Allow update for admin" ON image_messages
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM admins WHERE admins.user_id = auth.uid())
  );

CREATE POLICY "Allow delete own messages" ON image_messages
  FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER image_messages_set_author BEFORE INSERT ON image_messages
  FOR EACH ROW EXECUTE FUNCTION set_author();
```

## image_likes 테이블

INSERT/DELETE 정책이 없으므로 직접 쓰기는 막히고 `toggle_like` RPC 로만 쓴다.

```sql
CREATE TABLE IF NOT EXISTS image_likes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  image_name TEXT NOT NULL REFERENCES image_info(file_path) ON DELETE CASCADE ON UPDATE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(image_name, user_id)
);

ALTER TABLE image_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read" ON image_likes FOR SELECT USING (true);

CREATE INDEX idx_image_likes_image_name ON image_likes(image_name);
CREATE INDEX idx_image_likes_user_id ON image_likes(user_id);

-- 좋아요 토글 RPC (원자적 like/unlike + count 반환). RLS 를 우회하므로 구글 로그인 여부를 직접 확인한다.
CREATE OR REPLACE FUNCTION toggle_like(p_image_name TEXT)
RETURNS JSON AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_liked BOOLEAN;
  v_count INTEGER;
BEGIN
  IF v_user_id IS NULL OR coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) THEN
    RAISE EXCEPTION 'Google login required' USING ERRCODE = '42501';
  END IF;

  DELETE FROM image_likes WHERE image_name = p_image_name AND user_id = v_user_id;
  v_liked := NOT FOUND;
  IF v_liked THEN
    INSERT INTO image_likes (image_name, user_id) VALUES (p_image_name, v_user_id);
  END IF;

  SELECT COUNT(*) INTO v_count FROM image_likes WHERE image_name = p_image_name;
  RETURN json_build_object('liked', v_liked, 'like_count', v_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
```

## Storage 정책 (storage.objects)

`images` 버킷(public) 의 정책. Dashboard 로 만든 정책은 이름 뒤에 접미사가 붙으므로 먼저 현재 정책을 확인하고,
아래와 다른 것만 교체한다. 작업별 필요 권한(Supabase JS reference 기준): upload = INSERT, remove = SELECT + DELETE,
move = SELECT + UPDATE. 클라이언트의 삭제 권한 확인(`deleteFile`)은 우회 가능하므로 실제 차단은 이 정책이 맡는다.

production 은 같은 조건의 정책이 다른 이름으로 있다: 읽기 `read image 1ffg0oo_0`, 업로드 `Allow upload for google`,
이동 `Allow move for admin`, 삭제 `images delete (owner or admin)`. 추가로 중복 읽기 정책
`Authenticated users can read`(authenticated, `bucket_id = 'images'`) 가 있지만 public 읽기와 같아 영향은 없다.

```sql
-- 현재 정책 확인
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects';

CREATE POLICY "images read" ON storage.objects
  FOR SELECT USING (bucket_id = 'images');

CREATE POLICY "images upload (google only)" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'images' AND auth.jwt() ->> 'is_anonymous' != 'true');

CREATE POLICY "images delete (owner or admin)" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'images'
    AND (
      owner_id = (SELECT auth.jwt() ->> 'sub')
      OR EXISTS (SELECT 1 FROM public.admins WHERE admins.user_id = auth.uid())
    )
  );

CREATE POLICY "images move (admin)" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'images'
    AND EXISTS (SELECT 1 FROM public.admins WHERE admins.user_id = auth.uid())
  );
```

## category_bookmarks 테이블 (제거됨)

카테고리 북마크 기능 제거로 더 이상 사용하지 않는다. 기존 프로젝트에서는 아래로 정리한다.

```sql
DROP TABLE IF EXISTS category_bookmarks;
```

## 마이그레이션

기존 테이블에 컬럼 추가 또는 정책 변경이 필요한 경우 실행한다.

### image_messages 에 user_id 컬럼 추가

```sql
ALTER TABLE image_messages ADD COLUMN user_id UUID REFERENCES auth.users(id);

ALTER TABLE image_messages
  ADD CONSTRAINT message_max_bytes CHECK (octet_length(message) <= 10000);

DROP POLICY IF EXISTS "Allow write for authenticated" ON image_messages;
CREATE POLICY "Allow write for authenticated" ON image_messages
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Allow delete own messages" ON image_messages
  FOR DELETE USING (auth.uid() = user_id);
```

### image_info.file_path UNIQUE 제약 추가

중복 데이터가 있을 경우 먼저 정리한 뒤 제약을 추가한다.

```sql
-- 1. 중복 확인
SELECT file_path, COUNT(*) AS cnt
FROM image_info
GROUP BY file_path
HAVING COUNT(*) > 1
ORDER BY cnt DESC;

-- 2. 각 file_path 그룹에서 가장 오래된 1건만 남기고 삭제
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY file_path ORDER BY created_at ASC, id ASC) AS rn
  FROM image_info
)
DELETE FROM image_info
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 3. UNIQUE 제약 추가
ALTER TABLE image_info
  ADD CONSTRAINT image_info_file_path_unique UNIQUE (file_path);
```

### image_messages / image_likes 에 FK CASCADE 추가

`image_info` 에 대응되는 row 없이 남은 고아 데이터를 정리한 뒤 FK 를 추가한다.
FK 가 있으면 `image_info` 삭제/경로 변경 시 연관 레코드가 자동으로 삭제/갱신된다.

```sql
-- 1. 고아 데이터 확인
SELECT COUNT(*) AS orphan_messages
FROM image_messages
WHERE image_name NOT IN (SELECT file_path FROM image_info);

SELECT COUNT(*) AS orphan_likes
FROM image_likes
WHERE image_name NOT IN (SELECT file_path FROM image_info);

-- 2. 고아 데이터 삭제
DELETE FROM image_messages
WHERE image_name NOT IN (SELECT file_path FROM image_info);

DELETE FROM image_likes
WHERE image_name NOT IN (SELECT file_path FROM image_info);

-- 3. FK + ON DELETE/UPDATE CASCADE 추가
ALTER TABLE image_messages
  ADD CONSTRAINT image_messages_image_name_fkey
  FOREIGN KEY (image_name) REFERENCES image_info(file_path)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE image_likes
  ADD CONSTRAINT image_likes_image_name_fkey
  FOREIGN KEY (image_name) REFERENCES image_info(file_path)
  ON DELETE CASCADE ON UPDATE CASCADE;
```

> 주의: Supabase Storage 에서 직접 삭제된 파일(Dashboard 경유)로 인한 `image_info` 고아 row 는
> 이 FK 로는 해결되지 않는다. 이 경우 별도 청소 스크립트(앱에서 Storage list 와 DB 대조)가 필요하다.

### 기존 FK 에 ON UPDATE CASCADE 추가

이미 `ON DELETE CASCADE` 만 걸린 환경에서 `image_info.file_path` 변경(파일 이동) 시
FK 위반으로 UPDATE 가 차단되므로, FK 를 재생성한다.

```sql
ALTER TABLE image_messages
  DROP CONSTRAINT image_messages_image_name_fkey,
  ADD CONSTRAINT image_messages_image_name_fkey
    FOREIGN KEY (image_name) REFERENCES image_info(file_path)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE image_likes
  DROP CONSTRAINT image_likes_image_name_fkey,
  ADD CONSTRAINT image_likes_image_name_fkey
    FOREIGN KEY (image_name) REFERENCES image_info(file_path)
    ON DELETE CASCADE ON UPDATE CASCADE;
```

### image_info 에 display_name 컬럼 추가

업로드 시 Storage 경로는 ASCII 키로 저장되고 원본 파일명은 `display_name` 에 보관된다.
기존 row 는 `file_path` 의 파일명 부분으로 채운다.

```sql
ALTER TABLE image_info ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';

UPDATE image_info
SET display_name = regexp_replace(file_path, '^.*/', '')
WHERE display_name = '';
```

### 보안 정책 강화 (작성자 서버 기록, RPC 전용 쓰기, admins 노출 차단)

기존 프로젝트에 한 번 실행한다. 클라이언트 코드는 이 마이그레이션 전후 모두 동작한다.
production 에는 2026-10-08 에 1~4 단계를 하나의 트랜잭션으로 적용했다.

1. 위 [set_author 함수](#set_author-함수-작성자-필드-서버-기록) 의 `CREATE OR REPLACE FUNCTION` 을 실행한다.
2. 위 [image_likes 테이블](#image_likes-테이블) 의 `toggle_like` `CREATE OR REPLACE FUNCTION` 을 다시 실행한다 (익명 차단 + `search_path` 고정).
3. 아래를 실행한다.

```sql
-- 작성자 필드 서버 기록
CREATE TRIGGER image_info_set_author BEFORE INSERT ON image_info
  FOR EACH ROW EXECUTE FUNCTION set_author();
CREATE TRIGGER image_messages_set_author BEFORE INSERT ON image_messages
  FOR EACH ROW EXECUTE FUNCTION set_author();

-- image_likes / index 는 RPC 로만 쓴다
DROP POLICY IF EXISTS "Allow insert for authenticated" ON image_likes;
DROP POLICY IF EXISTS "Allow delete own likes" ON image_likes;
DROP POLICY IF EXISTS "Allow write for authenticated" ON index;

ALTER FUNCTION increment_view_cnt(TEXT) SET search_path = public;

-- admins 는 자기 행만
DROP POLICY IF EXISTS "Allow read for authenticated" ON admins;
CREATE POLICY "Allow read own row" ON admins
  FOR SELECT USING (user_id = auth.uid());

-- 확인
SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2;
```

4. 문서와 다르게 만들어져 있던 정책을 교체한다. 아래는 production 에서 조회된 정책 이름 기준이며,
   다른 프로젝트는 [Storage 정책](#storage-정책-storageobjects) 의 확인 쿼리로 이름과 조건을 먼저 비교한다.

```sql
-- image_info 삭제: 본인만 → 본인 또는 admin (admin 이 남의 파일을 지울 때 image_info 가 남지 않도록)
DROP POLICY "Allow delete own" ON image_info;
CREATE POLICY "Allow delete" ON image_info
  FOR DELETE USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM admins WHERE admins.user_id = auth.uid())
  );

-- storage 삭제: 이름과 달리 조건이 bucket_id 뿐이라 익명 포함 누구나 모든 파일 삭제 가능 → 업로더 또는 admin
DROP POLICY "Authenticated users can delete own files" ON storage.objects;
CREATE POLICY "images delete (owner or admin)" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'images'
    AND (
      owner_id = (SELECT auth.jwt() ->> 'sub')
      OR EXISTS (SELECT 1 FROM public.admins WHERE admins.user_id = auth.uid())
    )
  );

-- storage 업로드: 조건이 bucket_id 뿐이라 익명도 업로드 가능 → 제거 ("Allow upload for google" 만 남긴다)
DROP POLICY "Authenticated users can upload" ON storage.objects;
```
