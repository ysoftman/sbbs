# Database 설정

Supabase SQL Editor 에서 실행한다.

## index 테이블

```sql
CREATE TABLE IF NOT EXISTS index (
  name TEXT PRIMARY KEY,
  view_cnt INTEGER DEFAULT 1
);

ALTER TABLE index ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read" ON index FOR SELECT USING (true);

CREATE POLICY "Allow write for authenticated" ON index
  FOR ALL USING (auth.uid() IS NOT NULL);

-- 조회수 원자적 증가를 위한 RPC 함수
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
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

## image_info 테이블

`image_messages`, `image_likes` 가 `file_path` 를 FK 로 참조하므로 먼저 생성한다.

```sql
CREATE TABLE IF NOT EXISTS image_info (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  user_name TEXT NOT NULL DEFAULT '',
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

CREATE POLICY "Allow read for authenticated" ON admins
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- admin 등록 (email 로 user_id 조회)
-- INSERT INTO admins (user_id, email)
-- SELECT id, email FROM auth.users WHERE email = 'ysoftman@gmail.com';
```

## image_likes 테이블

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

CREATE POLICY "Allow insert for authenticated" ON image_likes
  FOR INSERT WITH CHECK (
    auth.uid() IS NOT NULL
    AND auth.jwt() ->> 'is_anonymous' != 'true'
  );

CREATE POLICY "Allow delete own likes" ON image_likes
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_image_likes_image_name ON image_likes(image_name);
CREATE INDEX idx_image_likes_user_id ON image_likes(user_id);

-- 좋아요 토글 RPC (원자적 like/unlike + count 반환)
CREATE OR REPLACE FUNCTION toggle_like(p_image_name TEXT)
RETURNS JSON AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_exists BOOLEAN;
  v_count INTEGER;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM image_likes WHERE image_name = p_image_name AND user_id = v_user_id
  ) INTO v_exists;

  IF v_exists THEN
    DELETE FROM image_likes WHERE image_name = p_image_name AND user_id = v_user_id;
  ELSE
    INSERT INTO image_likes (image_name, user_id) VALUES (p_image_name, v_user_id);
  END IF;

  SELECT COUNT(*) INTO v_count FROM image_likes WHERE image_name = p_image_name;
  RETURN json_build_object('liked', NOT v_exists, 'like_count', v_count);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

## category_bookmarks 테이블

```sql
CREATE TABLE IF NOT EXISTS category_bookmarks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  category_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, category_name)
);

ALTER TABLE category_bookmarks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read own bookmarks" ON category_bookmarks
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Allow insert for authenticated" ON category_bookmarks
  FOR INSERT WITH CHECK (
    auth.uid() IS NOT NULL
    AND auth.jwt() ->> 'is_anonymous' != 'true'
  );

CREATE POLICY "Allow delete own bookmarks" ON category_bookmarks
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_category_bookmarks_user_id ON category_bookmarks(user_id);
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
