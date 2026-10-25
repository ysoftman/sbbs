import { getCurrentUser, getUserName, isAdmin, supabase } from "./common.js";
import { formatCount, formatFileSize, showAlert, showConfirm } from "./utils.js";

export const STORAGE_BUCKET = "images";
// Storage 는 빈 폴더를 따로 만들 수 없어 Dashboard 처럼 이 이름의 빈 파일로 카테고리를 유지한다
const FOLDER_PLACEHOLDER = ".emptyFolderPlaceholder";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB (재인코딩 대상은 재인코딩 후 크기 기준)
const MAX_SOURCE_IMAGE_SIZE = 50 * 1024 * 1024; // 50MB, 재인코딩 대상 원본의 디코드 전 상한
const MAX_VIDEO_SIZE = 10 * 1024 * 1024; // 10MB
// 허용 MIME 타입 → storage key 확장자. DATABASE.md 의 버킷 allowed_mime_types 와 같은 목록을 유지한다.
// svg 는 받지 않는다: 공개 객체 응답에 CSP/nosniff 가 없어 스크립트가 든 svg 를 직접 열면 storage origin 에서 실행된다
const TYPE_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "video/mp4": "mp4",
};
const ALLOWED_TYPES = Object.keys(TYPE_EXTENSIONS);
// 업로드 전 재인코딩 대상. gif(애니메이션), mp4 는 원본 그대로 올린다
const REENCODE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/bmp"];
// 재인코딩 시 픽셀 면적 상한. 세로로 긴 인포그래픽도 읽을 수 있도록 긴 변이 아닌 면적으로 제한한다
const MAX_IMAGE_PIXELS = 2560 * 2560;
const MAX_CANVAS_EDGE = 8192; // 재인코딩 시 한 변 상한 (브라우저별 canvas 한계보다 안전하게 작은 값)
const LOSSY_QUALITY = 0.9;

// supabase storage 카테고리 목록 조회 (오류 시 null, 카테고리가 없으면 [])
export const getImageDirs = async (path) => {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(path, {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) {
    console.warn("getImageDirs error:", error);
    return null;
  }
  // 폴더는 id가 null인 항목
  const dirs = data
    .filter((item) => item.id === null)
    .map((item) => {
      if (path === "" || path === "/") return item.name;
      return `${path}/${item.name}`;
    });
  return dirs;
};

// supabase storage 에 저장된 이미지 list (최신순, 페이지네이션. 오류 시 null, 파일이 없으면 [])
export const getImageList = async (path, offset = 0, limit = 1000) => {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(path, {
    limit: limit,
    offset: offset,
    sortBy: { column: "created_at", order: "desc" },
  });
  if (error) {
    console.warn("getImageList error:", error);
    return null;
  }
  // 파일은 id가 null이 아닌 항목 (카테고리 placeholder 제외. 가장 오래된 항목이라 페이지네이션 hasMore 판정에 영향 없음)
  const files = data
    .filter((item) => item.id !== null && item.name !== FOLDER_PLACEHOLDER)
    .map((item) => ({
      name: path === "" || path === "/" ? item.name : `${path}/${item.name}`,
      created_at: item.created_at,
      size: item.metadata?.size || 0,
    }));
  return files;
};

// supabase database 조회수 조회 및 증가
// 카운터는 increment_view_cnt RPC(원자적 증가)로만 쓴다. index 테이블엔 클라이언트 쓰기 권한이 없다.
export const getViewCnt = async (docName, htmlId) => {
  const { data, error } = await supabase.rpc("increment_view_cnt", {
    doc_name: docName,
  });
  if (error) {
    console.warn("getViewCnt error:", error);
    return;
  }
  document.getElementById(htmlId).textContent = formatCount(data);
};

// 파일 이동 (storage move + DB 경로 업데이트, admin 전용)
export const moveFile = async (oldPath, newDir) => {
  const fileName = oldPath.split("/").pop();
  const newPath = `${newDir}/${fileName}`;
  if (oldPath === newPath) return null;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).move(oldPath, newPath);
  if (error) {
    await showAlert(`Move error: ${error.message}`);
    return null;
  }
  // FK ON UPDATE CASCADE 로 image_messages / image_likes 의 image_name 도 자동 갱신된다
  const { data: infoData, error: infoErr } = await supabase
    .from("image_info")
    .update({ file_path: newPath })
    .eq("file_path", oldPath)
    .select();
  if (infoErr || !infoData || infoData.length === 0) {
    // DB 업데이트 실패 시 S3 롤백
    await supabase.storage.from(STORAGE_BUCKET).move(newPath, oldPath);
    await showAlert(
      `image_info update failed, move rolled back.\n${infoErr?.message || `"${oldPath}" not found.`}\n` +
        "Check RLS policy:\n" +
        'CREATE POLICY "Allow update for admin" ON image_info FOR UPDATE USING (EXISTS (SELECT 1 FROM admins WHERE admins.user_id = auth.uid()));',
    );
    return null;
  }
  return newPath;
};

// 빈 카테고리 생성 (admin 전용 UI)
// type 이 빈 Blob 은 multipart 파트가 application/octet-stream 으로 전송돼 버킷 allowed_mime_types 에 막히므로
// 허용 목록의 타입을 붙인다. 0 바이트라 이미지로 표시될 일은 없고 getImageList 가 걸러낸다.
export const createDir = async (dir) => {
  const placeholder = new Blob([], { type: "image/png" });
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(`${dir}/${FOLDER_PLACEHOLDER}`, placeholder);
  if (error) {
    await showAlert(`Create category error: ${error.message}`);
    return false;
  }
  return true;
};

// 파일 삭제 (storage + metadata, 본인 업로드만)
export const deleteFile = async (filePath) => {
  const user = await getCurrentUser();
  if (!user) {
    await showAlert("Login required");
    return false;
  }
  // admin 또는 본인 업로드 파일인지 확인
  if (!(await isAdmin())) {
    const { data: uploadRow } = await supabase.from("image_info").select("user_id").eq("file_path", filePath).single();
    if (!uploadRow || uploadRow.user_id !== user.id) {
      await showAlert("You can only delete files you uploaded");
      return false;
    }
  }
  const { error: storageErr } = await supabase.storage.from(STORAGE_BUCKET).remove([filePath]);
  if (storageErr) {
    await showAlert(`Delete error: ${storageErr.message}`);
    return false;
  }
  // image_messages / image_likes 는 image_info FK CASCADE 로 자동 삭제된다
  const { error: dbErr } = await supabase.from("image_info").delete().eq("file_path", filePath);
  if (dbErr) {
    await showAlert(`DB delete failed, storage already removed.\n${dbErr.message}\nCheck RLS policy on image_info.`);
    return false;
  }
  return true;
};

// 파일 앞부분으로 애니메이션·무손실 여부를 판별한다.
// 애니메이션 webp(VP8X 애니메이션 플래그) / png(IDAT 앞의 APNG acTL 청크)는 재인코딩하면 첫 프레임만 남으므로 gif 처럼 원본을 올린다.
// 무손실(png, bmp, 첫 이미지 청크가 VP8L 인 webp)은 화질을 잃지 않도록 q1.0 으로 인코딩한다
const readImageHeader = async (file) => {
  if (file.type !== "image/webp" && file.type !== "image/png") {
    return { animated: false, lossless: file.type === "image/bmp" };
  }
  const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  // latin1 은 1 바이트 → 1 문자라 문자열 인덱스가 바이트 오프셋과 같다
  const text = new TextDecoder("latin1").decode(head);
  if (file.type === "image/png") {
    const idat = text.indexOf("IDAT");
    return { animated: text.slice(0, idat < 0 ? text.length : idat).includes("acTL"), lossless: true };
  }
  // RIFF 청크(4 바이트 이름 + 4 바이트 LE 크기 + 짝수로 패딩한 본문)를 따라가 첫 이미지 청크(VP8 / VP8L)를 찾는다.
  // Chrome 이 만든 무손실 webp 는 VP8X, ICCP, VP8L 순서라 첫 청크만으로는 알 수 없다
  const view = new DataView(head.buffer);
  let lossless = false;
  for (let pos = 12; pos + 8 <= head.length; ) {
    const id = text.slice(pos, pos + 4);
    if (id === "VP8 " || id === "VP8L") {
      lossless = id === "VP8L";
      break;
    }
    const size = view.getUint32(pos + 4, true);
    pos += 8 + size + (size % 2);
  }
  return { animated: text.slice(12, 16) === "VP8X" && (head[20] & 0x02) !== 0, lossless };
};

// 면적(MAX_IMAGE_PIXELS)·한 변(MAX_CANVAS_EDGE) 상한에 맞춘 재인코딩 크기 [width, height] (비율 유지, 확대하지 않음)
const fitImageSize = (width, height) => {
  const scale = Math.min(1, Math.sqrt(MAX_IMAGE_PIXELS / (width * height)), MAX_CANVAS_EDGE / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
};

// EXIF 회전을 픽셀에 반영해 메타데이터를 지워도 방향이 유지되게 디코드한다.
// "from-image" 를 모르는 옛 브라우저(Chrome 112·Firefox 111·Safari 16 미만)는 TypeError 를 내므로 옵션 없이 다시 시도한다
const decodeImage = (file) =>
  createImageBitmap(file, { imageOrientation: "from-image" }).catch((err) => {
    if (err instanceof TypeError) return createImageBitmap(file);
    throw err;
  });

// 알파가 모두 255 인지 (jpeg 로 대체 인코딩해도 되는지)
const isOpaque = (ctx, width, height) => {
  const { data } = ctx.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return false;
  }
  return true;
};

// 공개 버킷이라 업로드 전에 canvas 로 다시 인코딩해 EXIF(GPS 등)를 지우고 큰 이미지는 fitImageSize 로 줄인다.
// 기본 출력은 jpeg → jpeg(q0.9), 무손실 원본(readImageHeader) → 무손실 webp(q1.0), 손실 webp → webp(q0.9).
// webp 인코딩을 못 하는 브라우저(Safari)는 png 로 떨어지므로 blob.type 을 실제 포맷으로 쓴다.
// 결과가 MAX_IMAGE_SIZE 나 원본보다 크면 대안을 고른다: 축소하지 않았으면 원본, 아니면 손실 webp → (불투명하면) jpeg → 원본.
// png/webp/bmp 는 원본을 고를 수 있고 그때 원본의 eXIf 등 메타데이터가 남는다. 실패하면 null 을 반환한다.
const reencodeImage = async (file) => {
  let bitmap;
  let canvas;
  try {
    const { animated, lossless } = await readImageHeader(file);
    if (animated) return file;
    bitmap = await decodeImage(file);
    const [width, height] = fitImageSize(bitmap.width, bitmap.height);
    const resized = width !== bitmap.width || height !== bitmap.height;
    canvas = Object.assign(document.createElement("canvas"), { width, height });
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const encode = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    const isJpeg = file.type === "image/jpeg";
    // 크기 상한 이하이고 원본보다 크지 않아야 쓴다. jpeg 원본은 EXIF 제거가 우선이라 커져도 쓴다
    const fits = (blob) =>
      blob && TYPE_EXTENSIONS[blob.type] && blob.size <= MAX_IMAGE_SIZE && (isJpeg || blob.size <= file.size);
    const first = await encode(isJpeg ? "image/jpeg" : "image/webp", lossless ? 1 : LOSSY_QUALITY);
    if (fits(first)) return first;
    if (isJpeg) throw new Error(first ? `re-encoded jpeg is too large (${first.size})` : "jpeg encode failed");
    // 축소하지 않았다면 화질을 잃는 대안보다 원본이 낫다
    if (!resized && file.size <= MAX_IMAGE_SIZE) return file;
    // 무손실 webp 가 크면 알파를 보존하는 손실 webp. webp 인코딩을 못 하면 다시 png 가 나오므로 건너뛴다
    if (lossless && first?.type === "image/webp") {
      const lossy = await encode("image/webp", LOSSY_QUALITY);
      if (fits(lossy)) return lossy;
    }
    // Safari 에서 webp 대신 나온 png 가 커지는 경우 등. 알파가 없으면 jpeg 로 줄인다
    if (isOpaque(ctx, width, height)) {
      const jpeg = await encode("image/jpeg", LOSSY_QUALITY);
      if (fits(jpeg)) return jpeg;
    }
    if (file.size <= MAX_IMAGE_SIZE) return file;
    throw new Error("re-encoded image is still too large");
  } catch (err) {
    console.warn("image re-encode failed:", err);
    return null;
  } finally {
    bitmap?.close();
    // iOS Safari 는 canvas 메모리 총량 제한이 있어 GC 를 기다리지 않고 바로 해제한다 (연속 업로드 시 getContext 실패 방지)
    if (canvas) Object.assign(canvas, { width: 0, height: 0 });
  }
};

// 파일 업로드
export const uploadFile = async (file) => {
  if (!ALLOWED_TYPES.includes(file.type)) {
    await showAlert(`Unsupported file type: ${file.type}\nAllowed: ${Object.values(TYPE_EXTENSIONS).join(", ")}`);
    return false;
  }
  if (file.size === 0) {
    await showAlert("Empty file");
    return false;
  }
  const maxSize = file.type === "video/mp4" ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;
  // 재인코딩 대상은 축소 후 크기로 판단하되, 디코드 비용이 큰 원본은 미리 거절한다
  const reencode = REENCODE_TYPES.includes(file.type);
  const sourceLimit = reencode ? MAX_SOURCE_IMAGE_SIZE : maxSize;
  if (file.size > sourceLimit) {
    await showAlert(`File size exceeds ${formatFileSize(sourceLimit)} limit (${formatFileSize(file.size)})`);
    return false;
  }
  const user = await getCurrentUser();
  if (!user || user.is_anonymous) {
    await showAlert("Google login required");
    return false;
  }
  let body = file;
  if (reencode) {
    const reencoded = await reencodeImage(file);
    // jpeg 는 GPS 등 EXIF 가 흔한 카메라 사진이라 재인코딩에 실패했으면 원본을 그대로 올릴지 묻는다.
    // 위치 유출을 막으려는 질문이라 Enter 로 바로 올라가지 않게 Cancel 에 초기 포커스를 둔다
    if (!reencoded && file.type === "image/jpeg" && file.size <= maxSize) {
      const message = `couldn't remove photo metadata (location etc) from "${file.name}". upload original?`;
      if (!(await showConfirm(message, { focusCancel: true }))) return false;
    }
    body = reencoded ?? file;
  }
  if (body.size > maxSize) {
    await showAlert(`File size exceeds ${formatFileSize(maxSize)} limit (${formatFileSize(body.size)})`);
    return false;
  }
  // Supabase Storage 는 non-ASCII 파일명(한글 등)을 거부하므로
  // 원본 파일명 대신 ASCII 로만 구성된 고유 키를 생성한다. 확장자는 파일명이 아닌 실제 MIME 타입에서 정한다.
  const ext = TYPE_EXTENSIONS[body.type];
  const storageKey = `${Date.now()}-${crypto.randomUUID().slice(0, 6)}.${ext}`;
  const filePath = uploadDir ? `${uploadDir}/${storageKey}` : storageKey;
  // 재인코딩으로 포맷이 바뀌면 다운로드 파일명도 맞도록 display_name 확장자를 바꾼다
  const displayName = body.type === file.type ? file.name : `${file.name.replace(/\.[^.]*$/, "")}.${ext}`;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(filePath, body, { upsert: false });
  if (error) {
    await showAlert(`Upload error: ${error.message}`);
    return false;
  }
  const { error: metaError } = await supabase.from("image_info").upsert(
    {
      file_path: filePath,
      user_name: getUserName(user),
      user_id: user.id,
      display_name: displayName,
    },
    { onConflict: "file_path" },
  );
  if (metaError) {
    console.warn("image_info upsert error:", metaError);
    const { error: removeErr } = await supabase.storage.from(STORAGE_BUCKET).remove([filePath]);
    if (removeErr) console.warn("storage rollback failed (orphan file may remain):", removeErr);
    await showAlert(`Upload metadata error: ${metaError.message}`);
    return false;
  }
  return true;
};

// 업로드 대상 카테고리
export let uploadDir = "";
export const setUploadDir = (dir) => {
  uploadDir = dir;
};
