import { getCurrentUser, supabase } from "./common.js";
import { INITIAL_LIMIT, loadMessages, renderMessages, saveMessage } from "./message.js";
import { deleteFile, getImageDirs, getMeta, moveFile, STORAGE_BUCKET } from "./storage.js";
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
  maxHeightUpdaters,
  showAlert,
  showConfirm,
  toSafeId,
} from "./utils.js";

// 이미지 높이에 맞춰 메시지 영역을 접을 때 지켜야 할 하한.
// 입력 폼(약 90px)과 목록(min-height 60px)이 잘리지 않을 만큼.
const MIN_SIDE_HEIGHT = 200;

// admin 상태 캐싱 (세션 내 변경 없음)
let cachedAdminStatus = null;
supabase.auth.onAuthStateChange(() => {
  cachedAdminStatus = null;
});

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
    `<span class="img-overlay-size" id="overlay_size_${toSafeId(name)}"></span>` +
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
  getMeta(url, (err, img) => {
    if (err || !img) return;
    const sizeEl = overlay.querySelector(`#overlay_size_${toSafeId(name)}`);
    if (sizeEl) sizeEl.textContent = `${img.naturalWidth} x ${img.naturalHeight}`;
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

// 파일 이동 카테고리 선택 피커 (admin 전용)
const showMovePicker = (currentDir, onSelect) => {
  const existing = document.getElementById("move-dir-picker");
  if (existing) existing.remove();

  getImageDirs("").then((dirs) => {
    const others = dirs.filter((d) => d !== currentDir);
    const picker = document.createElement("div");
    picker.id = "move-dir-picker";
    picker.className = "upload-dir-picker";

    const dirsHtml =
      others.length > 0
        ? others
            .map(
              (dir) =>
                `<button class="btn btn-primary move-dir-btn" data-dir="${escapeHtml(dir)}">${escapeHtml(dir)}</button>`,
            )
            .join(" ")
        : '<span class="t-muted">no categories</span>';

    picker.innerHTML =
      '<div class="upload-dir-picker-inner panel">' +
      "<p>move to</p>" +
      `<div class="move-dir-list">${dirsHtml}</div>` +
      '<br><button class="btn move-dir-cancel">cancel</button>' +
      "</div>";
    document.body.appendChild(picker);
    picker.tabIndex = -1;
    picker.focus();

    picker.querySelector(".move-dir-cancel").addEventListener("click", () => picker.remove());
    picker.addEventListener("click", (e) => {
      if (e.target === picker) picker.remove();
    });
    picker.addEventListener("keydown", (e) => {
      if (e.key === "Escape") picker.remove();
    });

    for (const btn of picker.querySelectorAll(".move-dir-btn")) {
      btn.addEventListener("click", () => {
        picker.remove();
        onSelect(btn.dataset.dir);
      });
    }
  });
};

// 그리드 모드용 간략 HTML 생성
const buildGridItemHtml = (name, publicUrl, likeCountMap, userLikeSet, displayName) => {
  const isImage = !isVideoName(name);
  const msgId = toSafeId(name);
  const likeCount = likeCountMap[name] || 0;
  const isLiked = userLikeSet.has(name);

  const mediaHtml = isImage
    ? `<img class="grid-thumb" loading="lazy" src="${publicUrl}" alt="${escapeHtml(name)}" data-name="${escapeHtml(name)}" data-url="${publicUrl}">`
    : `<video class="grid-thumb" muted preload="metadata"><source type="video/mp4" src="${publicUrl}"></video>`;

  return (
    `<div class="grid-card" data-name="${escapeHtml(name)}" id="grid_${msgId}">` +
    `<div class="grid-card-media">${mediaHtml}</div>` +
    `<div class="grid-card-info">` +
    `<a class="grid-card-name" href="#${encodeURIComponent(name)}" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</a>` +
    `<span class="grid-card-like" id="like_${msgId}">` +
    `<i class="ph-fill ${isLiked ? "ph-thumbs-up like-active" : "ph-thumbs-up like-inactive"} like-heart" ` +
    `data-name="${escapeHtml(name)}" data-liked="${isLiked}" title="Google login required"></i>` +
    `${likeCount ? `<span class="like-count">${formatCount(likeCount)}</span>` : ""}` +
    `</span>` +
    `</div></div>`
  );
};

// 그리드 모드 이벤트 핸들러 (썸네일 클릭 → 오버레이, 좋아요)
const setupGridHandlers = (name, currentUser, displayName) => {
  const msgId = toSafeId(name);
  const card = document.getElementById(`grid_${msgId}`);
  if (!card) return;
  const isImage = !isVideoName(name);
  if (isImage) {
    const thumb = card.querySelector(".grid-thumb");
    if (thumb) {
      thumb.addEventListener("click", () => {
        showImageOverlay(thumb.dataset.url, thumb.dataset.name, displayName);
      });
    }
  }
  // 좋아요 핸들러
  const likeEl = document.getElementById(`like_${msgId}`);
  const heartEl = likeEl?.querySelector(".like-heart");
  if (!heartEl) return;
  if (!currentUser || currentUser.is_anonymous) {
    heartEl.style.cursor = "pointer";
    heartEl.addEventListener("click", () => showAlert("Google login required"));
  } else {
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
        heartEl.className = `ph-fill ${data.liked ? "ph-thumbs-up like-active" : "ph-thumbs-up like-inactive"} like-heart clickable`;
        const countEl = likeEl.querySelector(".like-count");
        if (countEl) {
          countEl.textContent = data.like_count ? formatCount(data.like_count) : "";
        } else if (data.like_count) {
          likeEl.insertAdjacentHTML("beforeend", `<span class="like-count">${formatCount(data.like_count)}</span>`);
        }
      } catch (err) {
        console.warn("toggle_like error:", err);
      } finally {
        heartEl.dataset.pending = "false";
      }
    });
  }
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
  const likeCount = likeCountMap[name] || 0;
  const isLiked = userLikeSet.has(name);
  const likeHtml =
    `<span class="img-like" id="like_${msgId}">` +
    `<i class="ph-fill ${isLiked ? "ph-thumbs-up like-active" : "ph-thumbs-up like-inactive"} like-heart" ` +
    `data-name="${escapeHtml(name)}" data-liked="${isLiked}" title="Google login required"></i>` +
    `<span class="like-count">${likeCount ? formatCount(likeCount) : ""}</span></span>`;
  const moveHtml = `<span class="img-file-move" id="file_move_${msgId}" style="display:none"></span>`;
  const deleteHtml = `<span class="img-file-delete" id="file_del_${msgId}" style="display:none"></span>`;
  if (isImage) {
    const mediaHtml = `<img class="thumbnail" loading="lazy" src="${publicUrl}" alt="${escapeHtml(name)}" data-name="${escapeHtml(name)}" data-url="${publicUrl}">`;
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
  if (document.getElementById(id) == null) {
    return;
  }
  if (isImage) {
    const thumbEl = document.getElementById(id).querySelector(".thumbnail");
    if (thumbEl) {
      thumbEl.addEventListener("click", () => {
        showImageOverlay(thumbEl.dataset.url, thumbEl.dataset.name, displayName);
      });
      const sid = toSafeId(name);
      // 메시지 영역(.img-side-msg) 높이를 이미지 높이에 맞추되 MIN_SIDE_HEIGHT 아래로는 내리지 않는다.
      // .img-side-msg 는 overflow:hidden 이라 이 값이 그대로 잘리는 높이가 된다.
      // flex column 레이아웃이라 입력 폼이 보이면 그 높이만큼 msg-list 가 자동으로 줄어든다.
      const applyMsgListHeight = () => {
        const sideEl = thumbEl.closest(".img-content-row")?.querySelector(".img-side-msg");
        if (!sideEl || !thumbEl.clientHeight) return;
        if (window.matchMedia("(max-width: 768px)").matches) {
          sideEl.style.height = "";
          return;
        }
        sideEl.style.height = `${Math.max(thumbEl.clientHeight, MIN_SIDE_HEIGHT)}px`;
      };
      maxHeightUpdaters[sid] = applyMsgListHeight;
      // 이미지 크기 표시는 별도 Image 객체로 다시 받지 않고 lazy 로딩되는 썸네일 자체의 load 를 사용한다
      const onThumbLoad = () => {
        applyMsgListHeight();
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
        showMovePicker(currentDir, async (targetDir) => {
          const newPath = await moveFile(name, targetDir);
          if (newPath) {
            const container = moveEl.closest(".card");
            if (container) container.remove();
          }
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
        if (!(await showConfirm(`delete "${name}"?`))) return;
        const deleted = await deleteFile(name);
        if (deleted) {
          const container = delEl.closest(".card");
          if (container) container.remove();
        }
      });
    }
  }
  // 비로그인/anonymous 사용자: 하트 클릭 시 로그인 안내
  if (!currentUser || currentUser.is_anonymous) {
    const heartEl = document.getElementById(`like_${msgId}`)?.querySelector(".like-heart");
    if (heartEl) {
      heartEl.style.cursor = "pointer";
      heartEl.addEventListener("click", () => showAlert("Google login required"));
    }
  }
  // 구글 로그인 사용자만 좋아요 클릭 가능 (anonymous 제외)
  if (currentUser && !currentUser.is_anonymous) {
    const likeEl = document.getElementById(`like_${msgId}`);
    const heartEl = likeEl?.querySelector(".like-heart");
    if (heartEl) {
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
          heartEl.className = `ph-fill ${data.liked ? "ph-thumbs-up like-active" : "ph-thumbs-up like-inactive"} like-heart clickable`;
          const countEl = likeEl.querySelector(".like-count");
          if (countEl) {
            countEl.textContent = data.like_count ? formatCount(data.like_count) : "";
          } else if (data.like_count) {
            likeEl.insertAdjacentHTML("beforeend", `<span class="like-count">${formatCount(data.like_count)}</span>`);
          }
        } catch (err) {
          console.warn("toggle_like error:", err);
        } finally {
          heartEl.dataset.pending = "false";
        }
      });
    }
  }
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
          const userName = currentUser.is_anonymous
            ? "Anonymous"
            : currentUser.user_metadata?.full_name || currentUser.email?.split("@")[0] || "Unknown";
          const saved = await saveMessage(name, textarea.value, userName, currentUser.id);
          if (!saved) return;
          textarea.value = "";
          charcountEl.textContent = `0/${MAX_MSG_BYTES} bytes`;
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

export const loadImages = async (htmlId, imageNames, metaMap = {}, append = false, viewMode = "list") => {
  if (!append) document.getElementById(htmlId).innerHTML = "";

  // 로그인 상태 확인 (admin 여부는 캐싱)
  const currentUser = await getCurrentUser();
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
    if (error) console.warn("image_info error:", error);
    for (const row of data || []) {
      uploaderMap[row.file_path] = row;
      likeCountMap[row.file_path] = row.image_likes.length;
      if (currentUser && row.image_likes.some((l) => l.user_id === currentUser.id)) userLikeSet.add(row.file_path);
      messageMap[row.file_path] = row.image_messages || [];
    }
  }
  const displayNameOf = (name) => uploaderMap[name]?.display_name || name.split("/").pop();

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
  let isAdmin = false;
  if (currentUser) {
    if (cachedAdminStatus === null) {
      const { data: adminRow } = await supabase
        .from("admins")
        .select("user_id")
        .eq("user_id", currentUser.id)
        .maybeSingle();
      cachedAdminStatus = !!adminRow;
    }
    isAdmin = cachedAdminStatus;
  }

  for (const name of imageNames) {
    setupImageHandlers(name, currentUser, isAdmin, uploaderMap, messageMap, displayNameOf(name));
  }
};
