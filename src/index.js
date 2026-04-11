import "./common.js";
import "@fontsource/press-start-2p";
import "nes.css/css/nes.min.css";
import { supabase } from "./common.js";

const STORAGE_BUCKET = "images";

// 파일명을 HTML id로 사용할 수 있도록 변환
const toSafeId = (name) => name.replaceAll(/[^a-zA-Z0-9]/g, "_");

// 이미지별 textarea max-height 재계산 함수 저장
const maxHeightUpdaters = {};

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/svg+xml", "video/mp4"];
let currentDir = "";

const formatFileSize = (bytes) => {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

const formatDate = (dateStr) => {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
};

// 이미지 오버레이 표시 (파일 경로 + 이미지 사이즈)
const showImageOverlay = (url, name) => {
  const overlay = document.createElement("div");
  overlay.className = "img-overlay";
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };
  overlay.innerHTML =
    `<div class="img-overlay-wrap">` +
    `<div class="img-overlay-info">` +
    `<span class="img-overlay-path">${name}</span>` +
    `<span class="img-overlay-size" id="overlay_size_${toSafeId(name)}"></span>` +
    `</div>` +
    `<img src="${url}">` +
    `</div>`;
  document.body.appendChild(overlay);
  getMeta(url, (_err, img) => {
    const sizeEl = overlay.querySelector(`#overlay_size_${toSafeId(name)}`);
    if (sizeEl) sizeEl.textContent = `${img.naturalWidth} x ${img.naturalHeight}`;
  });
};

export const loadImages = async (htmlId, imageNames, metaMap = {}) => {
  document.getElementById(htmlId).innerHTML = "";
  const uploaderMap = {};
  if (imageNames.length > 0) {
    const { data: uploadData } = await supabase
      .from("image_uploads")
      .select("file_path, user_name")
      .in("file_path", imageNames);
    if (uploadData) {
      for (const row of uploadData) {
        uploaderMap[row.file_path] = row.user_name;
      }
    }
  }
  let isImage = true;
  let item = "";
  for (const name of imageNames) {
    isImage = true;
    if (name.endsWith("mp4")) {
      isImage = false;
    }
    const msgId = toSafeId(name);
    const msgHtml =
      `<div class="img-message" id="msg_form_${msgId}" style="display:none">` +
      `<div class="msg-textarea-wrap">` +
      `<textarea class="nes-textarea" id="msg_${msgId}" rows="2" placeholder="message..."></textarea>` +
      `<span class="msg-charcount" id="msg_charcount_${msgId}">0/10000 bytes</span>` +
      `</div>` +
      `<button class="nes-btn is-primary" id="msg_save_${msgId}">save</button>` +
      `<span class="nes-text is-success" id="msg_status_${msgId}"></span>` +
      `</div>` +
      `<div class="msg-list" id="msg_list_${msgId}"></div>`;
    const meta = metaMap[name] || {};
    const uploader = uploaderMap[name] || "";
    const metaHtml =
      `<span class="img-meta">` +
      (meta.size ? `<span class="img-file-size">${formatFileSize(meta.size)}</span> ` : "") +
      (meta.created_at ? `<span class="img-upload-time">${formatDate(meta.created_at)}</span> ` : "") +
      (uploader ? `<span class="img-uploader">${uploader}</span>` : "") +
      `</span>`;
    if (isImage) {
      item =
        `<div class="nes-container with-title">` +
        `<p class="title"><a class="img-link" href="#${encodeURIComponent(name)}">${name}</a> <span id="${name}_img_size"></span> ${metaHtml}</p>` +
        `<div class="img-content-row"><div id="${name}_img"></div><div class="img-side-msg">${msgHtml}</div></div></div>`;
    } else {
      item =
        `<div class="nes-container with-title">` +
        `<p class="title"><a class="img-link" href="#${encodeURIComponent(name)}">${name}</a> ${metaHtml}</p>` +
        `<div class="img-content-row"><div id="${name}_video"></div><div class="img-side-msg">${msgHtml}</div></div></div>`;
    }
    document.getElementById(htmlId).insertAdjacentHTML("beforeend", item);
  }
  // 로그인 상태 확인
  const {
    data: { user: currentUser },
  } = await supabase.auth.getUser();

  for (const name of imageNames) {
    // supabase storage 에 저장된 이미지 public url 불러오기
    const {
      data: { publicUrl },
    } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(name);
    const url = publicUrl;
    isImage = true;
    if (name.endsWith("mp4")) {
      isImage = false;
    }
    let id = name;
    if (isImage) {
      item = `<img class="thumbnail" loading="lazy" src="${url}" data-name="${name}" data-url="${url}">`;
      id += "_img";
    } else {
      item = `<video width="640" controls autoplay muted><source type="video/mp4" src=${url}></video>`;
      id += "_video";
    }
    if (document.getElementById(id) == null) {
      continue;
    }
    document.getElementById(id).innerHTML = item;
    if (isImage) {
      const thumbEl = document.getElementById(id).querySelector(".thumbnail");
      if (thumbEl) {
        thumbEl.addEventListener("click", () => {
          showImageOverlay(thumbEl.dataset.url, thumbEl.dataset.name);
        });
        const sid = toSafeId(name);
        const applyMaxHeight = () => {
          const ta = document.getElementById(`msg_${sid}`);
          if (!ta || !thumbEl.clientHeight) return;
          const imgH = thumbEl.clientHeight;
          const msgList = document.getElementById(`msg_list_${sid}`);
          const charcount = document.getElementById(`msg_charcount_${sid}`);
          const saveBtn = document.getElementById(`msg_save_${sid}`);
          let otherH = 0;
          if (msgList) otherH += msgList.offsetHeight;
          if (charcount) otherH += charcount.offsetHeight;
          if (saveBtn) otherH += saveBtn.offsetHeight;
          otherH += 30; // gaps, margins
          ta.style.maxHeight = `${Math.max(imgH - otherH, 30)}px`;
        };
        maxHeightUpdaters[sid] = applyMaxHeight;
        if (thumbEl.complete) applyMaxHeight();
        thumbEl.addEventListener("load", applyMaxHeight);
      }
      getMeta(url, (_err, img) => {
        const imgSize = `(${img.naturalWidth}x${img.naturalHeight})`;
        if (document.getElementById(`${name}_img_size`) == null) {
          return;
        }
        document.getElementById(`${name}_img_size`).innerHTML = imgSize;
      });
    }
    // 메시지 로드
    const msgId = toSafeId(name);
    await loadMessages(name, `msg_list_${msgId}`, currentUser?.id);
    // 로그인한 사용자만 메시지 입력 가능
    if (currentUser) {
      const formEl = document.getElementById(`msg_form_${msgId}`);
      if (formEl) formEl.style.display = "";
      const textarea = document.getElementById(`msg_${msgId}`);
      const charcountEl = document.getElementById(`msg_charcount_${msgId}`);
      if (textarea && charcountEl) {
        textarea.addEventListener("input", () => {
          const bytes = getByteLength(textarea.value);
          charcountEl.textContent = `${bytes}/${MAX_MSG_BYTES} bytes`;
          charcountEl.style.color = bytes > MAX_MSG_BYTES ? "#e76e55" : "#888";
        });
      }
      const saveBtn = document.getElementById(`msg_save_${msgId}`);
      if (saveBtn) {
        saveBtn.addEventListener("click", async () => {
          const statusEl = document.getElementById(`msg_status_${msgId}`);
          if (!textarea.value.trim()) return;
          if (getByteLength(textarea.value) > MAX_MSG_BYTES) {
            statusEl.innerHTML = `<span class="nes-text is-error">${MAX_MSG_BYTES} bytes exceeded</span>`;
            return;
          }
          const userName = currentUser.is_anonymous
            ? "Anonymous"
            : currentUser.user_metadata?.full_name || currentUser.email?.split("@")[0] || "Unknown";
          await saveMessage(name, textarea.value, userName, currentUser.id);
          textarea.value = "";
          charcountEl.textContent = `0/${MAX_MSG_BYTES} bytes`;
          statusEl.innerHTML = "saved!";
          setTimeout(() => {
            statusEl.innerHTML = "";
          }, 2000);
          await loadMessages(name, `msg_list_${msgId}`, currentUser.id);
        });
      }
    }
  }
};

// 이미지 메시지 저장
const saveMessage = async (imageName, message, userName, userId) => {
  const { error } = await supabase.from("image_messages").insert({
    image_name: imageName,
    message: message,
    user_name: userName,
    user_id: userId,
  });
  if (error) {
    console.log("saveMessage error:", error);
    alert(`saveMessage error: ${error.message}`);
  }
};

// 이미지 메시지 삭제
const deleteMessage = async (id) => {
  const { error } = await supabase.from("image_messages").delete().eq("id", id);
  if (error) {
    console.log("deleteMessage error:", error);
    alert(`deleteMessage error: ${error.message}`);
  }
};

const MAX_MSG_BYTES = 10000;
const textEncoder = new TextEncoder();
const getByteLength = (str) => textEncoder.encode(str).length;

const INITIAL_LIMIT = 10;
const MORE_LIMIT = 5;

const renderMessageRow = (row, currentUserId, imageName, listId) => {
  const d = new Date(row.created_at);
  const date = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  const user = row.user_name || "Unknown";
  const msg = row.message.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const deleteBtn =
    currentUserId && row.user_id === currentUserId
      ? ` <button class="nes-btn is-error msg-delete-btn" data-msg-id="${row.id}" data-image-name="${imageName}" data-list-id="${listId}">x</button>`
      : "";
  return `<div class="msg-item"><span class="nes-text is-disabled">${date}</span> <span class="nes-text is-primary">${user}</span> ${msg}${deleteBtn}</div>`;
};

// 이미지 메시지 조회 (초기 10개, 이후 5개씩 추가 로드)
const loadMessages = async (imageName, listId, currentUserId, offset = 0) => {
  const el = document.getElementById(listId);
  if (!el) {
    console.log("loadMessages: element not found:", listId);
    return;
  }
  const limit = offset === 0 ? INITIAL_LIMIT : MORE_LIMIT;
  // 1개 더 조회하여 다음 페이지 존재 여부 확인
  const { data, error } = await supabase
    .from("image_messages")
    .select("id, message, user_name, user_id, created_at")
    .eq("image_name", imageName)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit);
  if (error) {
    console.log("loadMessages error:", error);
    el.innerHTML = `<div class="msg-item"><span class="nes-text is-error">${error.message}</span></div>`;
    return;
  }
  if (!data || data.length === 0) {
    if (offset > 0) {
      const oldMore = el.querySelector(".msg-more");
      if (oldMore) oldMore.remove();
    }
    return;
  }
  const hasMore = data.length > limit;
  const rows = hasMore ? data.slice(0, limit) : data;
  const newOffset = offset + rows.length;
  const html = rows.map((row) => renderMessageRow(row, currentUserId, imageName, listId)).join("");

  if (offset === 0) {
    el.innerHTML = html;
  } else {
    const oldMore = el.querySelector(".msg-more");
    if (oldMore) oldMore.remove();
    el.insertAdjacentHTML("beforeend", html);
  }
  // 삭제 버튼 이벤트 등록 (새로 추가된 버튼만)
  for (const btn of el.querySelectorAll(".msg-delete-btn:not([data-bound])")) {
    btn.dataset.bound = "1";
    btn.addEventListener("click", async (e) => {
      if (!confirm("delete?")) return;
      await deleteMessage(e.target.dataset.msgId);
      await loadMessages(e.target.dataset.imageName, e.target.dataset.listId, currentUserId);
    });
  }
  // 더보기 버튼
  if (hasMore) {
    el.insertAdjacentHTML(
      "beforeend",
      `<div class="msg-more"><button class="nes-btn msg-more-btn">more</button></div>`,
    );
    el.querySelector(".msg-more-btn").addEventListener("click", () => {
      loadMessages(imageName, listId, currentUserId, newOffset);
    });
  }
  // 메시지 로드 후 textarea max-height 재계산
  const msgIdKey = listId.replace("msg_list_", "");
  if (maxHeightUpdaters[msgIdKey]) maxHeightUpdaters[msgIdKey]();
};

// get image width height
export const getImgMetaSync = (url) => {
  return new Promise((resolver, reject) => {
    const img = new Image();
    img.onload = () => resolver(img);
    img.onerror = (err) => reject(err);
    img.src = url;
  });
};
export const getMeta = (url, cb) => {
  const img = new Image();
  img.onload = () => cb(null, img);
  img.onerror = (err) => cb(err);
  img.src = url;
};

// supabase storage 디렉토리 목록 조회
export const getImageDirs = async (path) => {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(path, {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) {
    console.log("getImageDirs error:", error);
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

// supabase storage 에 저장된 이미지 list
export const getImageList = async (path) => {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(path, {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) {
    console.log("getImageList error:", error);
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
export const setVisitDoc = async (docName) => {
  const { error } = await supabase.from("index").upsert({
    name: docName,
    visit_cnt: 1,
  });
  if (error) {
    console.log("setVisitDoc error:", error);
  }
};

// supabase database 방문카운트 조회 및 증가
// RPC(stored procedure) 를 사용해 원자적 증가 처리
export const getVisitCnt = async (docName, htmlId) => {
  // rpc 함수 increment_visit_cnt 호출 (supabase SQL editor 에서 생성 필요)
  const { data, error } = await supabase.rpc("increment_visit_cnt", {
    doc_name: docName,
  });
  if (error) {
    console.log("getVisitCnt error:", error);
    // rpc 실패시 직접 조회 시도
    const { data: row } = await supabase.from("index").select("visit_cnt").eq("name", docName).single();
    if (row) {
      document.getElementById(htmlId).innerHTML = `${row.visit_cnt}`;
    }
    return;
  }
  document.getElementById(htmlId).innerHTML = `${data}`;
};

// 파일 업로드
const uploadFile = async (file) => {
  if (file.size > MAX_FILE_SIZE) {
    alert(`File size exceeds 5MB limit (${formatFileSize(file.size)})`);
    return false;
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    alert(`Unsupported file type: ${file.type}\nAllowed: jpg, png, gif, webp, bmp, svg, mp4`);
    return false;
  }
  if (!/^[\x20-\x7E]+$/.test(file.name)) {
    alert("File name must contain only ASCII characters");
    return false;
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    alert("Login required");
    return false;
  }
  const filePath = currentDir ? `${currentDir}/${file.name}` : file.name;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(filePath, file, { upsert: false });
  if (error) {
    alert(`Upload error: ${error.message}`);
    return false;
  }
  const userName = user.is_anonymous
    ? "Anonymous"
    : user.user_metadata?.full_name || user.email?.split("@")[0] || "Unknown";
  const { error: metaError } = await supabase.from("image_uploads").insert({
    file_path: filePath,
    user_name: userName,
    user_id: user.id,
  });
  if (metaError) {
    console.log("image_uploads insert error:", metaError);
  }
  return true;
};

const version = `last_version: ${__LAST_VERSION_TAG__}<br>last_commit_hash: ${__LAST_COMMIT_HASH__}<br>last_commit_date: ${__LAST_COMMIT_DATE__}<br>last_commit_message: ${__LAST_COMMIT_MESSAGE__}<br>`;
document.getElementById("version").innerHTML = version;

document.getElementById("btn_version").addEventListener("click", () => {
  const el = document.getElementById("version_info");
  el.style.display = el.style.display === "none" ? "" : "none";
});

async function loadImg(path, scrollTarget) {
  currentDir = path;
  const imgFiles = await getImageList(path);
  const imgNames = imgFiles.map((f) => f.name);
  const metaMap = {};
  for (const f of imgFiles) {
    metaMap[f.name] = { created_at: f.created_at, size: f.size };
  }
  // image div 태그를 구성해 이미지 순서를 보장
  await loadImages("images", imgNames, metaMap);
  if (scrollTarget) {
    const targetId = `${scrollTarget}_img`;
    const el = document.getElementById(targetId);
    if (el) {
      el.closest(".nes-container")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}

// URL hash 에서 이미지 경로 파싱 (예: #dir/image.jpg → { dir: "dir", image: "dir/image.jpg" })
const parseHash = () => {
  const hash = decodeURIComponent(window.location.hash.slice(1));
  if (!hash) return null;
  const lastSlash = hash.indexOf("/");
  if (lastSlash === -1) return { dir: hash, image: null };
  const dir = hash.substring(0, lastSlash);
  return { dir, image: hash };
};

const imgDirs = await getImageDirs("");
for (const dir of imgDirs) {
  const item = `<button class="nes-btn is-primary" id='load_${dir}'>${dir}</button>`;
  document.getElementById("load_img_buttons").insertAdjacentHTML("beforeend", item);
  document.getElementById(`load_${dir}`).addEventListener("click", () => {
    if (document.getElementById("images") != null) {
      document.getElementById("images").innerHTML = "";
    }
    loadImg(dir);
  });
}

getVisitCnt("ysoftman", "visitcnt");

const hashInfo = parseHash();
if (hashInfo && imgDirs.includes(hashInfo.dir)) {
  loadImg(hashInfo.dir, hashInfo.image);
} else if (imgDirs.length > 0) {
  loadImg(imgDirs[0]);
}

// hash 변경 시 해당 이미지로 이동
window.addEventListener("hashchange", () => {
  const info = parseHash();
  if (!info || !imgDirs.includes(info.dir)) return;
  const targetId = info.image ? `${info.image}_img` : null;
  const el = targetId ? document.getElementById(targetId) : null;
  if (el) {
    el.closest(".nes-container")?.scrollIntoView({ behavior: "smooth", block: "center" });
  } else {
    loadImg(info.dir, info.image);
  }
});

// 업로드 버튼 (로그인 사용자만 표시)
const {
  data: { user: currentUploadUser },
} = await supabase.auth.getUser();
if (currentUploadUser) {
  document.getElementById("upload_area").style.display = "";
}

document.getElementById("btn_upload").addEventListener("click", () => {
  if (!currentDir) {
    alert("Select a directory first");
    return;
  }
  document.getElementById("file_input").click();
});

document.getElementById("file_input").addEventListener("change", async (e) => {
  const files = e.target.files;
  if (!files || files.length === 0) return;
  let uploaded = 0;
  for (const file of files) {
    const success = await uploadFile(file);
    if (success) uploaded++;
  }
  if (uploaded > 0) {
    await loadImg(currentDir);
  }
  e.target.value = "";
});
