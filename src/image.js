import { getCurrentUser, getUserName, isAdmin, supabase } from "./common.js";
import { INITIAL_LIMIT, loadMessages, renderMessages, saveMessage } from "./message.js";
import { deleteFile, getImageDirs, moveFile, STORAGE_BUCKET } from "./storage.js";
import { supabaseUrl } from "./supabase_config.js";
import {
  escapeHtml,
  formatCount,
  formatDate,
  formatFileSize,
  getByteLength,
  isVideoName,
  MAX_MSG_BYTES,
  makeDicebear,
  showAlert,
  showConfirm,
  showDirPicker,
  toSafeId,
} from "./utils.js";

// 공유용 링크 생성: og-preview Edge Function 이 있으면 크롤러가 OG 메타를 읽을 수 있도록 그 URL 을,
// 없으면 SPA 해시 딥링크를 복사한다. Edge Function 은 사용자를 SPA 로 자동 리다이렉트한다.
// 단, localhost 개발 환경에서는 og-preview 가 production SITE_URL 로 리다이렉트하므로
// 로컬 테스트용으로 현재 origin 의 해시 링크를 사용한다.
const buildShareLink = (name) => {
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
  const base = supabaseUrl();
  if (base && !isLocal) {
    return `${base}/functions/v1/og-preview?p=${encodeURIComponent(name)}`;
  }
  return `${window.location.origin}${window.location.pathname}#${encodeURIComponent(name)}`;
};

// 공유 링크 클립보드 복사
const copyDeepLink = async (name, btn) => {
  const link = buildShareLink(name);
  let copied = false;
  try {
    await navigator.clipboard.writeText(link);
    copied = true;
  } catch {
    // 비밀 컨텍스트 아닐 때 fallback
    const ta = document.createElement("textarea");
    ta.value = link;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      copied = document.execCommand("copy");
    } catch (err) {
      console.warn("copy failed:", err);
    }
    ta.remove();
  }
  if (!copied) {
    await showAlert("copy failed");
    return;
  }
  if (!btn) return;
  const original = btn.innerHTML;
  btn.innerHTML = '<i class="ph-fill ph-check"></i> copied';
  btn.disabled = true;
  setTimeout(() => {
    btn.innerHTML = original;
    btn.disabled = false;
  }, 1500);
};

// 이미지 오버레이 표시 (파일 경로 + 이미지 사이즈)
const showImageOverlay = (url, name, displayName) => {
  document.querySelector(".img-overlay")?.remove();
  const isVideo = isVideoName(name);
  const overlay = document.createElement("div");
  overlay.className = "img-overlay";
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };
  overlay.innerHTML =
    `<div class="img-overlay-wrap">` +
    `<div class="img-overlay-info">` +
    `<span class="img-overlay-path">${escapeHtml(displayName)}</span>` +
    `<span class="img-overlay-size"></span>` +
    `<button class="btn btn-primary img-overlay-copy" title="copy link" aria-label="copy link">` +
    `<i class="ph-fill ph-link"></i> copy link</button>` +
    `</div>` +
    (isVideo ? `<video src="${url}" controls autoplay muted playsinline></video>` : `<img src="${url}">`) +
    `</div>`;
  document.body.appendChild(overlay);
  overlay.tabIndex = -1;
  overlay.focus();
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") overlay.remove();
  });
  const copyBtn = overlay.querySelector(".img-overlay-copy");
  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    copyDeepLink(name, copyBtn);
  });
  if (isVideo) return;
  const img = overlay.querySelector("img");
  img.addEventListener("load", () => {
    overlay.querySelector(".img-overlay-size").textContent = `${img.naturalWidth} x ${img.naturalHeight}`;
  });
};

// 목록 안의 썸네일·제목 클릭은 hash 를 바꾸지 않고 오버레이만 연다.
// hash 로 이동하면 latest/검색/my likes 에서 카테고리 화면으로 바뀌고, 같은 링크를 다시 눌러도 hashchange 가 없어 열리지 않는다.
// 새 탭/창 열기(⌘·Ctrl·Shift 클릭)는 링크 기본 동작에 맡긴다.
const bindOverlayOpen = (el, name, displayName) => {
  el?.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    const {
      data: { publicUrl },
    } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(name);
    showImageOverlay(publicUrl, name, displayName);
  });
};

// 딥링크(#dir/file) 로 들어온 경우 목록 스크롤 대신 해당 파일만 오버레이로 보여준다
export const showOverlayByName = async (name) => {
  const {
    data: { publicUrl },
  } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(name);
  let displayName = name;
  const { data } = await supabase.from("image_info").select("display_name").eq("file_path", name).maybeSingle();
  if (data?.display_name) displayName = data.display_name;
  showImageOverlay(publicUrl, name, displayName);
};

// 좋아요 표시 (리스트·그리드 공통). like-count 가 비면 CSS 로 숨긴다.
const buildLikeHtml = (cls, name, likeCount, isLiked) =>
  `<span class="${cls}" id="like_${toSafeId(name)}">` +
  `<i class="ph-fill ph-thumbs-up ${isLiked ? "like-active" : "like-inactive"} like-heart" ` +
  `data-name="${escapeHtml(name)}" data-liked="${isLiked}" title="Google login required"></i>` +
  `<span class="like-count">${likeCount ? formatCount(likeCount) : ""}</span></span>`;

// 좋아요 핸들러 (리스트·그리드 공통). 구글 로그인 사용자만 토글, 그 외는 로그인 안내
const setupLikeHandler = (name, currentUser) => {
  const likeEl = document.getElementById(`like_${toSafeId(name)}`);
  const heartEl = likeEl?.querySelector(".like-heart");
  if (!heartEl) return;
  if (!currentUser || currentUser.is_anonymous) {
    heartEl.style.cursor = "pointer";
    heartEl.addEventListener("click", () => showAlert("Google login required"));
    return;
  }
  heartEl.classList.add("clickable");
  heartEl.removeAttribute("title");
  heartEl.addEventListener("click", async () => {
    if (heartEl.dataset.pending === "true") return;
    heartEl.dataset.pending = "true";
    try {
      const { data, error } = await supabase.rpc("toggle_like", { p_image_name: name });
      if (error || !data) {
        console.warn("toggle_like error:", error ?? "no data returned");
        return;
      }
      heartEl.dataset.liked = data.liked;
      heartEl.classList.toggle("like-active", data.liked);
      heartEl.classList.toggle("like-inactive", !data.liked);
      likeEl.querySelector(".like-count").textContent = data.like_count ? formatCount(data.like_count) : "";
    } catch (err) {
      console.warn("toggle_like error:", err);
    } finally {
      heartEl.dataset.pending = "false";
    }
  });
};

// 그리드 모드용 간략 HTML 생성
const buildGridItemHtml = (name, publicUrl, likeCountMap, userLikeSet, displayName) => {
  const isImage = !isVideoName(name);
  const msgId = toSafeId(name);

  const mediaHtml = isImage
    ? `<img class="grid-thumb" loading="lazy" src="${publicUrl}" alt="${escapeHtml(displayName)}">`
    : `<video class="grid-thumb" muted preload="metadata"><source type="video/mp4" src="${publicUrl}"></video>`;

  return (
    `<div class="grid-card" data-name="${escapeHtml(name)}" id="grid_${msgId}">` +
    `<div class="grid-card-media">${mediaHtml}</div>` +
    `<div class="grid-card-info">` +
    `<a class="grid-card-name" href="#${encodeURIComponent(name)}" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</a>` +
    buildLikeHtml("grid-card-like", name, likeCountMap[name] || 0, userLikeSet.has(name)) +
    `</div></div>`
  );
};

// 그리드 모드 이벤트 핸들러 (썸네일·제목 클릭 → 오버레이, 좋아요). 영상 썸네일도 오버레이에서 재생한다.
const setupGridHandlers = (name, currentUser, displayName) => {
  const card = document.getElementById(`grid_${toSafeId(name)}`);
  if (!card) return;
  bindOverlayOpen(card.querySelector(".grid-thumb"), name, displayName);
  bindOverlayOpen(card.querySelector(".grid-card-name"), name, displayName);
  setupLikeHandler(name, currentUser);
};

// 이미지/비디오 HTML 생성
const buildImageHtml = (name, metaMap, uploaderMap, publicUrl, likeCountMap, userLikeSet, displayName) => {
  const isImage = !isVideoName(name);
  const msgId = toSafeId(name);
  const msgHtml =
    `<div class="img-message" id="msg_form_${msgId}" style="display:none">` +
    `<div class="msg-textarea-wrap">` +
    `<textarea class="textarea" id="msg_${msgId}" rows="2" placeholder="message..."></textarea>` +
    `<span class="msg-charcount" id="msg_charcount_${msgId}">0/10,000 bytes</span>` +
    `</div>` +
    `<button class="btn btn-primary" id="msg_save_${msgId}">save</button>` +
    `<span class="t-ok" id="msg_status_${msgId}"></span>` +
    `</div>` +
    `<div class="msg-list" id="msg_list_${msgId}"></div>`;
  const meta = metaMap[name] || {};
  const uploadInfo = uploaderMap[name] || {};
  const uploaderAvatar = uploadInfo.user_id
    ? `<img class="title-avatar" src="${makeDicebear(uploadInfo.user_id)}">`
    : "";
  const metaHtml =
    `<span class="img-meta">` +
    (meta.size ? `<span class="img-file-size">${formatFileSize(meta.size)}</span> ` : "") +
    (meta.created_at ? `<span class="img-upload-time">${formatDate(meta.created_at)}</span> ` : "") +
    (uploadInfo.user_name
      ? `${uploaderAvatar}<span class="img-uploader">${escapeHtml(uploadInfo.user_name)}</span> `
      : "") +
    `</span>`;
  const likeHtml = buildLikeHtml("img-like", name, likeCountMap[name] || 0, userLikeSet.has(name));
  const moveHtml = `<span class="img-file-move" id="file_move_${msgId}" style="display:none"></span>`;
  const deleteHtml = `<span class="img-file-delete" id="file_del_${msgId}" style="display:none"></span>`;
  if (isImage) {
    const mediaHtml = `<img class="thumbnail" loading="lazy" src="${publicUrl}" alt="${escapeHtml(displayName)}">`;
    return (
      `<div class="card">` +
      `<p class="title"><a class="img-link" href="#${encodeURIComponent(name)}">${escapeHtml(displayName)}</a> <span id="${msgId}_img_size"></span> ${metaHtml} ${likeHtml} ${moveHtml} ${deleteHtml}</p>` +
      `<div class="img-content-row"><div class="img-media" id="${msgId}_img">${mediaHtml}</div><div class="img-side-msg">${msgHtml}</div></div></div>`
    );
  }
  const mediaHtml = `<video controls autoplay muted playsinline><source type="video/mp4" src="${publicUrl}"></video>`;
  return (
    `<div class="card">` +
    `<p class="title"><a class="img-link" href="#${encodeURIComponent(name)}">${escapeHtml(displayName)}</a> ${metaHtml} ${likeHtml} ${moveHtml} ${deleteHtml}</p>` +
    `<div class="img-content-row"><div class="img-media" id="${msgId}_video">${mediaHtml}</div><div class="img-side-msg">${msgHtml}</div></div></div>`
  );
};

// 이벤트 핸들러 등록 (썸네일 클릭, 삭제, 이동, 메시지 등)
const setupImageHandlers = (name, currentUser, isAdmin, uploaderMap, messageMap, displayName) => {
  const isImage = !isVideoName(name);
  const msgId = toSafeId(name);
  const id = isImage ? `${msgId}_img` : `${msgId}_video`;
  const mediaEl = document.getElementById(id);
  if (mediaEl == null) {
    return;
  }
  bindOverlayOpen(mediaEl.closest(".card").querySelector(".img-link"), name, displayName);
  if (isImage) {
    const thumbEl = mediaEl.querySelector(".thumbnail");
    if (thumbEl) {
      bindOverlayOpen(thumbEl, name, displayName);
      // 이미지 크기 표시는 별도 Image 객체로 다시 받지 않고 lazy 로딩되는 썸네일 자체의 load 를 사용한다
      const onThumbLoad = () => {
        const sizeEl = document.getElementById(`${msgId}_img_size`);
        if (sizeEl && thumbEl.naturalWidth) sizeEl.innerHTML = `(${thumbEl.naturalWidth}x${thumbEl.naturalHeight})`;
      };
      if (thumbEl.complete) onThumbLoad();
      thumbEl.addEventListener("load", onThumbLoad);
    }
  }
  // admin 전용 파일 이동 버튼
  if (isAdmin) {
    const moveEl = document.getElementById(`file_move_${msgId}`);
    if (moveEl) {
      moveEl.style.display = "";
      moveEl.innerHTML = `<button class="btn img-file-move-btn">move</button>`;
      moveEl.querySelector(".img-file-move-btn").addEventListener("click", () => {
        const currentDir = name.includes("/") ? name.substring(0, name.indexOf("/")) : "";
        getImageDirs("").then((dirs) => {
          showDirPicker(
            "move to",
            dirs.filter((d) => d !== currentDir),
            async (targetDir) => {
              if (await moveFile(name, targetDir)) moveEl.closest(".card")?.remove();
            },
          );
        });
      });
    }
  }
  // 본인 업로드 파일만 삭제 버튼 표시
  const uploadInfo = uploaderMap[name] || {};
  if (currentUser && (isAdmin || uploadInfo.user_id === currentUser.id)) {
    const delEl = document.getElementById(`file_del_${msgId}`);
    if (delEl) {
      delEl.style.display = "";
      delEl.innerHTML = `<button class="btn btn-danger img-file-delete-btn">x</button>`;
      delEl.querySelector(".img-file-delete-btn").addEventListener("click", async () => {
        if (!(await showConfirm(`delete "${displayName}"?`))) return;
        const deleted = await deleteFile(name);
        if (deleted) {
          const container = delEl.closest(".card");
          if (container) container.remove();
        }
      });
    }
  }
  setupLikeHandler(name, currentUser);
  // 메시지 렌더 (loadImages 가 image_info 임베드로 미리 받아온 rows)
  renderMessages(name, `msg_list_${msgId}`, currentUser?.id, messageMap[name] || []);
  // 로그인한 사용자만 메시지 입력 가능
  if (currentUser) {
    const formEl = document.getElementById(`msg_form_${msgId}`);
    if (formEl) formEl.style.display = "";
    const textarea = document.getElementById(`msg_${msgId}`);
    const charcountEl = document.getElementById(`msg_charcount_${msgId}`);
    if (textarea && charcountEl) {
      textarea.addEventListener("input", () => {
        const bytes = getByteLength(textarea.value);
        charcountEl.textContent = `${bytes.toLocaleString()}/${MAX_MSG_BYTES.toLocaleString()} bytes`;
        charcountEl.classList.toggle("is-over", bytes > MAX_MSG_BYTES);
      });
    }
    const saveBtn = document.getElementById(`msg_save_${msgId}`);
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        if (saveBtn.dataset.pending === "true") return;
        if (!textarea.value.trim()) return;
        const statusEl = document.getElementById(`msg_status_${msgId}`);
        if (getByteLength(textarea.value) > MAX_MSG_BYTES) {
          statusEl.innerHTML = `<span class="t-danger">${MAX_MSG_BYTES.toLocaleString()} bytes exceeded</span>`;
          return;
        }
        saveBtn.dataset.pending = "true";
        saveBtn.disabled = true;
        try {
          const saved = await saveMessage(name, textarea.value, getUserName(currentUser), currentUser.id);
          if (!saved) return;
          textarea.value = "";
          charcountEl.textContent = `0/${MAX_MSG_BYTES.toLocaleString()} bytes`;
          statusEl.innerHTML = "saved!";
          await loadMessages(name, `msg_list_${msgId}`, currentUser.id);
          setTimeout(() => {
            statusEl.innerHTML = "";
          }, 2000);
        } finally {
          saveBtn.dataset.pending = "false";
          saveBtn.disabled = false;
        }
      });
    }
  }
};

// isStale: 호출 측 loadGeneration 비교 함수. 내부 await 사이에 화면이 바뀌었으면 렌더하지 않고 끝낸다.
export const loadImages = async (
  htmlId,
  imageNames,
  metaMap = {},
  append = false,
  viewMode = "list",
  isStale = () => false,
) => {
  // 로그인 상태 확인 (admin 여부는 캐싱)
  const currentUser = await getCurrentUser();
  if (isStale()) return;
  const isGrid = viewMode === "grid";

  // image_info 한 번의 조회에 좋아요(+리스트 모드는 최신 댓글)를 임베드해 페이지 단위로 가져온다.
  // image_likes / image_messages 가 image_info.file_path 를 FK 로 참조하므로 PostgREST 가 관계를 인식하고,
  // 임베드 order/limit 은 부모 행마다 적용되어 이미지별 요청이 필요 없다.
  const uploaderMap = {};
  const likeCountMap = {};
  const userLikeSet = new Set();
  const messageMap = {};
  if (imageNames.length > 0) {
    const msgSelect = isGrid ? "" : ", image_messages(id, message, user_name, user_id, created_at)";
    let query = supabase
      .from("image_info")
      .select(`file_path, user_name, user_id, display_name, image_likes(user_id)${msgSelect}`)
      .in("file_path", imageNames);
    if (!isGrid) {
      // 1개 더 조회하여 more 버튼 표시 여부 판단
      query = query
        .order("created_at", { referencedTable: "image_messages", ascending: false })
        .limit(INITIAL_LIMIT + 1, { referencedTable: "image_messages" });
    }
    const { data, error } = await query;
    if (isStale()) return;
    if (error) console.warn("image_info error:", error);
    for (const row of data || []) {
      uploaderMap[row.file_path] = row;
      likeCountMap[row.file_path] = row.image_likes.length;
      if (currentUser && row.image_likes.some((l) => l.user_id === currentUser.id)) userLikeSet.add(row.file_path);
      messageMap[row.file_path] = row.image_messages || [];
    }
  }
  const displayNameOf = (name) => uploaderMap[name]?.display_name || name.split("/").pop();
  if (!append) document.getElementById(htmlId).innerHTML = "";

  if (isGrid) {
    // 그리드 모드: 간략 카드, 댓글/업로더 정보 스킵
    for (const name of imageNames) {
      const {
        data: { publicUrl },
      } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(name);
      const item = buildGridItemHtml(name, publicUrl, likeCountMap, userLikeSet, displayNameOf(name));
      document.getElementById(htmlId).insertAdjacentHTML("beforeend", item);
    }
    for (const name of imageNames) {
      setupGridHandlers(name, currentUser, displayNameOf(name));
    }
    return;
  }

  // 리스트 모드
  for (const name of imageNames) {
    const {
      data: { publicUrl },
    } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(name);
    const item = buildImageHtml(name, metaMap, uploaderMap, publicUrl, likeCountMap, userLikeSet, displayNameOf(name));
    document.getElementById(htmlId).insertAdjacentHTML("beforeend", item);
  }
  const admin = await isAdmin();
  if (isStale()) return;

  for (const name of imageNames) {
    setupImageHandlers(name, currentUser, admin, uploaderMap, messageMap, displayNameOf(name));
  }
};
