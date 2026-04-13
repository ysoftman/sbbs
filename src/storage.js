import { supabase } from "./common.js";
import { formatCount, formatFileSize, showAlert } from "./utils.js";

export const STORAGE_BUCKET = "images";

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_VIDEO_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/svg+xml", "video/mp4"];

export const getMeta = (url, cb) => {
  const img = new Image();
  img.onload = () => cb(null, img);
  img.onerror = (err) => cb(err);
  img.src = url;
};

// supabase storage 카테고리 목록 조회
export const getImageDirs = async (path) => {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(path, {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) {
    console.warn("getImageDirs error:", error);
    return [];
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

// supabase storage 에 저장된 이미지 list (최신순, 페이지네이션)
export const getImageList = async (path, offset = 0, limit = 1000) => {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(path, {
    limit: limit,
    offset: offset,
    sortBy: { column: "created_at", order: "desc" },
  });
  if (error) {
    console.warn("getImageList error:", error);
    return [];
  }
  // 파일은 id가 null이 아닌 항목
  const files = data
    .filter((item) => item.id !== null)
    .map((item) => ({
      name: path === "" || path === "/" ? item.name : `${path}/${item.name}`,
      created_at: item.created_at,
      size: item.metadata?.size || 0,
    }));
  return files;
};

// supabase database(index 테이블) 문서 생성
export const setViewDoc = async (docName) => {
  const { error } = await supabase.from("index").upsert({
    name: docName,
    view_cnt: 1,
  });
  if (error) {
    console.warn("setViewDoc error:", error);
  }
};

// supabase database 조회수 조회 및 증가
// RPC(stored procedure) 를 사용해 원자적 증가 처리
export const getViewCnt = async (docName, htmlId) => {
  // rpc 함수 increment_view_cnt 호출 (supabase SQL editor 에서 생성 필요)
  const { data, error } = await supabase.rpc("increment_view_cnt", {
    doc_name: docName,
  });
  if (error) {
    console.warn("getViewCnt error:", error);
    // rpc 실패시 직접 조회 시도
    const { data: row } = await supabase.from("index").select("view_cnt").eq("name", docName).single();
    if (row) {
      document.getElementById(htmlId).innerHTML = formatCount(row.view_cnt);
    } else {
      await setViewDoc(docName);
      document.getElementById(htmlId).innerHTML = "1";
    }
    return;
  }
  document.getElementById(htmlId).innerHTML = formatCount(data);
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
  const { error: msgErr } = await supabase
    .from("image_messages")
    .update({ image_name: newPath })
    .eq("image_name", oldPath);
  if (msgErr) {
    // image_messages 업데이트 실패 시 전체 롤백
    await supabase.storage.from(STORAGE_BUCKET).move(newPath, oldPath);
    await supabase.from("image_info").update({ file_path: oldPath }).eq("file_path", newPath);
    await showAlert(`image_messages update failed, move rolled back.\n${msgErr.message}`);
    return null;
  }
  await supabase.from("image_likes").update({ image_name: newPath }).eq("image_name", oldPath);
  return newPath;
};

// 파일 삭제 (storage + metadata, 본인 업로드만)
export const deleteFile = async (filePath) => {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    await showAlert("Login required");
    return false;
  }
  // admin 또는 본인 업로드 파일인지 확인
  const { data: adminRow } = await supabase.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!adminRow) {
    const { data: uploadRow } = await supabase.from("image_info").select("user_id").eq("file_path", filePath).single();
    if (!uploadRow || uploadRow.user_id !== user.id) {
      await showAlert("You can only delete files you uploaded");
      return false;
    }
  }
  const { error } = await supabase.storage.from(STORAGE_BUCKET).remove([filePath]);
  if (error) {
    await showAlert(`Delete error: ${error.message}`);
    return false;
  }
  await supabase.from("image_info").delete().eq("file_path", filePath);
  await supabase.from("image_messages").delete().eq("image_name", filePath);
  await supabase.from("image_likes").delete().eq("image_name", filePath);
  return true;
};

// 파일 업로드
export const uploadFile = async (file) => {
  const maxSize = file.type === "video/mp4" ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;
  if (file.size > maxSize) {
    await showAlert(`File size exceeds ${formatFileSize(maxSize)} limit (${formatFileSize(file.size)})`);
    return false;
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    await showAlert(`Unsupported file type: ${file.type}\nAllowed: jpg, png, gif, webp, bmp, svg, mp4`);
    return false;
  }
  if (!/^[\x20-\x7E]+$/.test(file.name)) {
    await showAlert("File name must contain only ASCII characters");
    return false;
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    await showAlert("Login required");
    return false;
  }
  const filePath = uploadDir ? `${uploadDir}/${file.name}` : file.name;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(filePath, file, { upsert: false });
  if (error) {
    await showAlert(`Upload error: ${error.message}`);
    return false;
  }
  const userName = user.is_anonymous
    ? "Anonymous"
    : user.user_metadata?.full_name || user.email?.split("@")[0] || "Unknown";
  const { error: metaError } = await supabase.from("image_info").upsert(
    {
      file_path: filePath,
      user_name: userName,
      user_id: user.id,
    },
    { onConflict: "file_path" },
  );
  if (metaError) {
    console.warn("image_info upsert error:", metaError);
  }
  return true;
};

// 업로드 대상 카테고리
export let uploadDir = "";
export const setUploadDir = (dir) => {
  uploadDir = dir;
};
