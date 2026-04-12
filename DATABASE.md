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

## image_messages 테이블

```sql
CREATE TABLE IF NOT EXISTS image_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  image_name TEXT NOT NULL,
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

## image_info 테이블

```sql
CREATE TABLE IF NOT EXISTS image_info (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_path TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  user_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE image_info ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read" ON image_info FOR SELECT USING (true);

CREATE POLICY "Allow insert for authenticated" ON image_info
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

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
  image_name TEXT NOT NULL,
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
