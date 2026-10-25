import { getCurrentUser, getUserName, isAdmin, supabase } from "./common.js";
import { INITIAL_LIMIT, reloadMessageLists, renderMessages, saveMessage } from "./message.js";
import { deleteFile, getImageDirs, moveFile, STORAGE_BUCKET } from "./storage.js";
import { supabaseUrl } from "./supabase_config.js";
import {
  escapeHtml,
  formatCount,
  formatDate,
  formatFileSize,
  getByteLength,
  isVideoName,
  loadingIndicatorHtml,
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

// 터치 기기에서만 네이티브 공유 시트를 쓴다. 데스크톱은 링크 복사가 더 바로 쓰인다
const canNativeShare = () => typeof navigator.share === "function" && window.matchMedia("(pointer: coarse)").matches;

// 공유 링크: 터치 기기는 네이티브 공유 시트, 그 외(또는 공유 실패)는 클립보드 복사
const shareDeepLink = async (name, title, btn) => {
  const link = buildShareLink(name);
  if (canNativeShare()) {
    try {
      await navigator.share({ url: link, title });
      return;
    } catch (err) {
      // 사용자가 공유 시트를 닫았으면 조용히 끝낸다
      if (err.name === "AbortError") return;
      console.warn("share failed:", err);
    }
  }
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

// 현재 화면에 렌더된 순서대로 파일 경로 목록. 카드와 like 버튼이 모두 data-name 을 가지므로 중복을 제거한다
const getRenderedNames = () => [
  ...new Set([...document.querySelectorAll("#images [data-name]")].map((el) => el.dataset.name)),
];

// 목록 링크의 텍스트가 display_name. 딥링크처럼 목록에 없는 파일은 파일명으로 대체한다
const getRenderedDisplayName = (name) => {
  const link = document.querySelector(`#images a[href="#${encodeURIComponent(name)}"]`);
  return link?.textContent || name.split("/").pop();
};

const openRenderedImage = (name) => {
  const {
    data: { publicUrl },
  } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(name);
  showImageOverlay(publicUrl, name, getRenderedDisplayName(name));
};

// 원본 파일명(display_name)으로 다운로드. fetch 가 막히면 새 탭 열기로 대체한다
const downloadFile = async (url, displayName, btn) => {
  btn.disabled = true;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = displayName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (err) {
    console.warn("download failed:", err);
    window.open(url, "_blank", "noopener");
  } finally {
    btn.disabled = false;
  }
};

// 삭제·이동된 파일의 목록 카드를 지운 뒤 index.js 가 offset·이미지 수를 맞추도록 알린다 (name 은 storage 경로)
const removeRenderedItem = (name) => {
  for (const el of document.querySelectorAll("#images .card, #images .grid-card")) {
    if (el.dataset.name === name) el.remove();
  }
  document.dispatchEvent(new CustomEvent("sbbs:item-removed", { detail: { name } }));
};

// 파일 삭제 (목록 카드·오버레이 공통). 성공하면 true
const confirmDeleteFile = async (name, displayName) => {
  if (!(await showConfirm(`delete "${displayName}"?`))) return false;
  if (!(await deleteFile(name))) return false;
  removeRenderedItem(name);
  return true;
};

// admin 파일 이동 (목록 카드·오버레이 공통). 카테고리를 고르면 옮기고 onMoved 를 부른다
const pickDirAndMove = async (name, onMoved) => {
  const dirs = await getImageDirs("");
  if (!dirs) {
    await showAlert("failed to load categories");
    return;
  }
  const currentDir = name.includes("/") ? name.substring(0, name.indexOf("/")) : "";
  showDirPicker(
    "move to",
    dirs.filter((d) => d !== currentDir),
    async (targetDir) => {
      if (!(await moveFile(name, targetDir))) return;
      removeRenderedItem(name);
      onMoved?.();
    },
  );
};

// 좋아요 표시 (리스트·그리드·오버레이 공통). 키보드로도 누를 수 있는 토글 버튼이고 상태는 aria-pressed 로 알린다.
// like-count 가 비면 CSS 로 숨긴다.
const buildLikeHtml = (cls, name, likeCount, isLiked) =>
  `<span class="${cls}">` +
  `<button type="button" class="like-heart ${isLiked ? "like-active" : "like-inactive"}" aria-label="like" ` +
  `aria-pressed="${isLiked}" data-name="${escapeHtml(name)}" data-liked="${isLiked}" title="Google login required">` +
  `<i class="ph-fill ph-thumbs-up" aria-hidden="true"></i></button>` +
  `<span class="like-count">${likeCount ? formatCount(likeCount) : ""}</span></span>`;

// 같은 이미지의 좋아요 표시(목록 카드·오버레이)를 모두 맞춘다
const syncLikeState = (name, liked, likeCount) => {
  for (const heartEl of document.querySelectorAll(".like-heart")) {
    if (heartEl.dataset.name !== name) continue;
    heartEl.dataset.liked = liked;
    heartEl.setAttribute("aria-pressed", String(liked));
    heartEl.classList.toggle("like-active", liked);
    heartEl.classList.toggle("like-inactive", !liked);
    const countEl = heartEl.parentElement.querySelector(".like-count");
    if (countEl) countEl.textContent = likeCount ? formatCount(likeCount) : "";
  }
};

// 좋아요 핸들러 (likeEl 은 buildLikeHtml 의 바깥 span). 구글 로그인 사용자만 토글, 그 외는 로그인 안내
const setupLikeHandler = (likeEl, name, currentUser) => {
  const heartEl = likeEl?.querySelector(".like-heart");
  if (!heartEl) return;
  if (!currentUser || currentUser.is_anonymous) {
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
      syncLikeState(name, data.liked, data.like_count);
    } catch (err) {
      console.warn("toggle_like error:", err);
    } finally {
      heartEl.dataset.pending = "false";
    }
  });
};

// 댓글 입력폼 (리스트 카드·오버레이 공통). 로그인 사용자에게만 setupMessageForm 이 보여준다
const messageFormHtml =
  `<div class="img-message" style="display:none">` +
  `<div class="msg-textarea-wrap">` +
  `<textarea class="textarea" rows="2" placeholder="message..." aria-label="comment"></textarea>` +
  `<span class="msg-charcount">0/10,000 bytes</span>` +
  `</div>` +
  `<button class="btn btn-primary msg-save-btn" title="save (⌘/Ctrl+Enter)">save</button>` +
  `<span class="t-ok msg-status"></span>` +
  `</div>`;

// 댓글 입력 (리스트 카드·오버레이 공통). 로그인 사용자(익명 포함)만 쓸 수 있고 ⌘/Ctrl+Enter 로도 저장한다
const setupMessageForm = (formEl, name, currentUser) => {
  if (!formEl || !currentUser) return;
  formEl.style.display = "";
  const textarea = formEl.querySelector("textarea");
  const charcountEl = formEl.querySelector(".msg-charcount");
  const saveBtn = formEl.querySelector(".msg-save-btn");
  const statusEl = formEl.querySelector(".msg-status");
  textarea.addEventListener("input", () => {
    const bytes = getByteLength(textarea.value);
    charcountEl.textContent = `${bytes.toLocaleString()}/${MAX_MSG_BYTES.toLocaleString()} bytes`;
    charcountEl.classList.toggle("is-over", bytes > MAX_MSG_BYTES);
  });
  const save = async () => {
    if (saveBtn.dataset.pending === "true") return;
    if (!textarea.value.trim()) return;
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
      // 목록 카드와 오버레이에 같은 이미지의 댓글 목록이 함께 있으면 모두 갱신한다
      await reloadMessageLists(name, currentUser.id);
      setTimeout(() => {
        statusEl.innerHTML = "";
      }, 2000);
    } finally {
      saveBtn.dataset.pending = "false";
      saveBtn.disabled = false;
    }
  };
  saveBtn.addEventListener("click", save);
  // 한글 등 IME 조합을 확정하는 Enter 는 isComposing 인 keydown 이 한 번 더 오므로 건너뛴다
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      e.preventDefault();
      save();
    }
  });
};

// 이미지 오버레이는 네이티브 <dialog>(showModal) 하나를 열어 두고 prev/next 이동은 내용만 바꾼다.
// 포커스 가두기·Esc·닫을 때 포커스 복원은 브라우저가 처리한다.
let overlayDialog = null;
// 보여주는(또는 바꾸는 중인) 파일 경로. prev/next 의 기준
let overlayName = "";
// 내용 교체 순번. await 뒤에 새 교체가 시작됐거나 오버레이가 닫혔으면(close 도 올린다) 이전 결과를 버린다
let overlaySeq = 0;
// 다음 페이지를 불러오는 동안 이동을 막는다
let overlayLoadingMore = false;
// 모바일 뒤로가기로 닫을 수 있게 오버레이를 열 때 같은 URL 로 쌓은 history 기록의 URL. 그 기록이 빠졌으면 null
let overlayHistoryHref = null;
// 직접 부른 history.back() 이 일으킨 popstate 는 건너뛴다
let ignoreNextPopstate = false;
let loadMoreHandler = null;

// 목록 다음 페이지 로더 등록 (index.js). fn: () => Promise<void> — #images 에 다음 페이지를 붙이고 렌더가 끝나면 resolve,
// 이미 로딩 중이면 그 로드를 기다리고, 더 없으면 바로 resolve 한다
export const setLoadMoreHandler = (fn) => {
  loadMoreHandler = fn;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const decodeImage = (url) => {
  const img = new Image();
  img.src = url;
  return img.decode().catch(() => {});
};

// 오버레이 정보: 업로더·표시 이름·좋아요·최신 댓글을 image_info 한 번 조회로 받는다.
// 행이 없으면 info 가 null, 조회에 실패하면 error 가 있다 (오류를 빈 상태로 보이지 않게 구분한다)
const fetchOverlayInfo = async (name) => {
  const { data, error } = await supabase
    .from("image_info")
    .select(
      "user_id, user_name, display_name, created_at, image_likes(user_id), " +
        "image_messages(id, message, user_name, user_id, created_at)",
    )
    .eq("file_path", name)
    .order("created_at", { referencedTable: "image_messages", ascending: false })
    .limit(INITIAL_LIMIT + 1, { referencedTable: "image_messages" })
    .maybeSingle();
  if (error) console.warn("image_info error:", error);
  return { info: data ?? null, error };
};

// 오버레이에서 렌더된 목록 순서로 이전/다음 항목을 연다. 마지막 항목에서 다음으로 가면 다음 페이지를 불러와 이어 가고,
// 더 없으면(또는 로더가 없으면) 처음으로 돈다
const navigateOverlay = async (direction) => {
  const dialog = overlayDialog;
  if (!dialog || overlayLoadingMore) return;
  const name = overlayName;
  let names = getRenderedNames();
  let idx = names.indexOf(name);
  if (idx === -1 || names.length < 2) return;
  if (direction > 0 && idx === names.length - 1 && loadMoreHandler) {
    overlayLoadingMore = true;
    const nextBtn = dialog.querySelector(".img-overlay-next");
    nextBtn.setAttribute("aria-busy", "true");
    try {
      await loadMoreHandler();
    } catch (err) {
      console.warn("load more failed:", err);
    } finally {
      overlayLoadingMore = false;
      nextBtn.removeAttribute("aria-busy");
    }
    if (overlayDialog !== dialog || overlayName !== name) return;
    names = getRenderedNames();
    idx = names.indexOf(name);
    if (idx === -1) return;
  }
  openRenderedImage(names[(idx + direction + names.length) % names.length]);
};

const createOverlayDialog = () => {
  const dialog = document.createElement("dialog");
  dialog.className = "img-overlay";
  dialog.tabIndex = -1;
  dialog.setAttribute("aria-labelledby", "img_overlay_title");
  // 닫기·이전/다음 버튼은 내용 교체 때 다시 만들지 않아 눌러 이동해도 포커스가 그대로 남는다.
  // 좁은 화면은 내용이 화면을 거의 채워 배경을 누르기 어려우므로 닫기 버튼을 따로 둔다
  dialog.innerHTML =
    '<div class="img-overlay-wrap"></div>' +
    '<button class="btn img-overlay-close" title="close (Esc)" aria-label="close"><i class="ph-fill ph-x-circle"></i></button>' +
    '<button class="btn img-overlay-nav img-overlay-prev" title="previous image (←)" aria-label="previous image" hidden>' +
    '<i class="ph-fill ph-caret-left"></i></button>' +
    '<button class="btn img-overlay-nav img-overlay-next" title="next image (→)" aria-label="next image" hidden>' +
    '<i class="ph-fill ph-caret-right"></i></button>';
  // 빈 곳(dialog 자신) 클릭으로 닫는다. 댓글을 드래그 선택하다 바깥에서 놓은 클릭은 누른 곳이 달라 닫지 않는다
  let pressedBackdrop = false;
  dialog.addEventListener("pointerdown", (e) => {
    pressedBackdrop = e.target === dialog;
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog && pressedBackdrop) dialog.close();
  });
  // 쓰던 댓글이 있으면 Esc 는 입력란에서 빠져나오기만 하고, 한 번 더 누르면 닫힌다
  dialog.addEventListener("cancel", (e) => {
    const field = document.activeElement;
    if (field?.tagName === "TEXTAREA" && dialog.contains(field) && field.value.trim()) {
      e.preventDefault();
      dialog.focus();
    }
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (overlayDialog === dialog) overlayDialog = null;
    overlaySeq++;
    overlayLoadingMore = false;
    // UI(Esc·버튼·배경)로 닫았으면 열 때 쌓은 기록을 되돌린다. 우리 기록 위에 있을 때만 back 해서 사이트 밖으로 나가지 않는다.
    // 열려 있는 동안 URL 이 바뀌었으면(업로드 완료 후 카테고리 이동 등) back 은 열기 전 화면으로 돌아가므로,
    // 기록 하나가 남더라도 표시만 지워 URL 과 화면을 맞춘다
    const pushedHref = overlayHistoryHref;
    overlayHistoryHref = null;
    if (pushedHref !== null && history.state?.sbbsOverlay) {
      if (window.location.href === pushedHref) {
        ignoreNextPopstate = true;
        history.back();
      } else {
        history.replaceState(null, "", window.location.href);
      }
    }
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    // 입력 중이거나 비디오에 포커스가 있으면 화살표 키는 커서 이동·재생 탐색(시크)에 양보한다
    if (["TEXTAREA", "INPUT", "VIDEO"].includes(e.target.tagName)) return;
    navigateOverlay(e.key === "ArrowLeft" ? -1 : 1);
  });
  dialog.querySelector(".img-overlay-close").addEventListener("click", () => dialog.close());
  dialog.querySelector(".img-overlay-prev").addEventListener("click", () => navigateOverlay(-1));
  dialog.querySelector(".img-overlay-next").addEventListener("click", () => navigateOverlay(1));
  document.body.appendChild(dialog);
  dialog.showModal();
  // 기본 초기 포커스(첫 버튼) 대신 dialog 자신에 두어 Enter/Space 가 버튼을 누르지 않게 한다
  dialog.focus();
  // hashchange 가 나지 않도록 같은 URL 로 기록만 하나 쌓는다. 이후 prev/next 는 기록을 더 쌓지 않는다
  history.pushState({ sbbsOverlay: true }, "", window.location.href);
  overlayHistoryHref = window.location.href;
  return dialog;
};

// 모바일/브라우저 뒤로가기: 오버레이를 열 때 쌓은 기록이 빠졌으므로 오버레이만 닫는다
window.addEventListener("popstate", () => {
  if (ignoreNextPopstate) {
    ignoreNextPopstate = false;
    return;
  }
  if (!overlayDialog) return;
  overlayHistoryHref = null;
  overlayDialog.close();
});

// 오버레이 본문: 정보 bar + 미디어 | 댓글 패널. 좋아요·댓글·파일 조작은 fillOverlayDetails 가 채운다
const renderOverlayContent = (dialog, url, name, displayName) => {
  const isVideo = isVideoName(name);
  const shareLabel = canNativeShare() ? "share" : "copy link";
  const shareIcon = canNativeShare() ? "ph-share-network" : "ph-link";
  const wrap = dialog.querySelector(".img-overlay-wrap");
  wrap.innerHTML =
    `<div class="img-overlay-main">` +
    `<div class="img-overlay-info">` +
    `<span class="img-overlay-path" id="img_overlay_title">${escapeHtml(displayName)}</span>` +
    `<span class="img-overlay-size"></span>` +
    `<span class="img-overlay-actions">` +
    `<button class="btn btn-primary img-overlay-copy" title="${shareLabel}" aria-label="${shareLabel}">` +
    `<i class="ph-fill ${shareIcon}"></i> ${shareLabel}</button>` +
    `<button class="btn btn-primary img-overlay-download" title="download" aria-label="download">` +
    `<i class="ph-fill ph-download-simple"></i></button>` +
    `</span>` +
    `</div>` +
    (isVideo
      ? `<video class="img-overlay-media" src="${url}" controls autoplay muted playsinline></video>`
      : `<img class="img-overlay-media" src="${url}" alt="${escapeHtml(displayName)}" decoding="async">`) +
    `</div>` +
    `<div class="img-overlay-side">` +
    `<div class="img-overlay-side-head"></div>` +
    messageFormHtml +
    `<div class="msg-list" data-image="${escapeHtml(name)}">${loadingIndicatorHtml()}</div>` +
    `</div>`;
  dialog.scrollTop = 0;
  const names = getRenderedNames();
  const canNavigate = names.includes(name) && names.length > 1;
  for (const btn of dialog.querySelectorAll(".img-overlay-nav")) btn.hidden = !canNavigate;
  // 교체된 내용 안에 있던 포커스는 사라지므로 dialog 로 돌려 ←/→ 키를 계속 받는다
  if (!dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
  const copyBtn = wrap.querySelector(".img-overlay-copy");
  copyBtn.addEventListener("click", () => shareDeepLink(name, displayName, copyBtn));
  const downloadBtn = wrap.querySelector(".img-overlay-download");
  downloadBtn.addEventListener("click", () => downloadFile(url, displayName, downloadBtn));
  if (isVideo) return;
  const img = wrap.querySelector(".img-overlay-media");
  const showSize = () => {
    if (img.naturalWidth) {
      wrap.querySelector(".img-overlay-size").textContent = `${img.naturalWidth} x ${img.naturalHeight}`;
    }
  };
  if (img.complete) showSize();
  img.addEventListener("load", showSize);
};

// 업로더·좋아요·댓글과 파일 조작 버튼을 채운다. 권한은 목록 카드(setupImageHandlers)와 같다
const fillOverlayDetails = (dialog, name, displayName, info, currentUser, admin) => {
  const likes = info?.image_likes ?? [];
  const isLiked = !!currentUser && likes.some((l) => l.user_id === currentUser.id);
  const avatar = info?.user_id ? `<img class="title-avatar" src="${makeDicebear(info.user_id)}" alt="">` : "";
  const uploader = info?.user_name
    ? `<span class="img-overlay-uploader">${avatar}${escapeHtml(info.user_name)}</span>`
    : "";
  const time = info?.created_at
    ? `<time class="img-overlay-time" datetime="${escapeHtml(info.created_at)}">${formatDate(info.created_at)}</time>`
    : "";
  const head = dialog.querySelector(".img-overlay-side-head");
  head.innerHTML = uploader + time + buildLikeHtml("img-like", name, likes.length, isLiked);
  setupLikeHandler(head.querySelector(".img-like"), name, currentUser);
  const side = dialog.querySelector(".img-overlay-side");
  renderMessages(side.querySelector(".msg-list"), name, currentUser?.id, info?.image_messages ?? [], 0, admin);
  setupMessageForm(side.querySelector(".img-message"), name, currentUser);

  // 그리드·딥링크에서도 파일을 다룰 수 있게 admin 이동, 본인/admin 삭제 버튼을 둔다. 성공하면 오버레이를 닫는다
  const actions = dialog.querySelector(".img-overlay-actions");
  const closeIfShowing = () => {
    if (overlayDialog === dialog && overlayName === name) dialog.close();
  };
  if (admin) {
    actions.insertAdjacentHTML(
      "beforeend",
      '<button class="btn img-overlay-move" title="move to category" aria-label="move to category">' +
        '<i class="ph-fill ph-folder-simple"></i> move</button>',
    );
    actions.querySelector(".img-overlay-move").addEventListener("click", () => pickDirAndMove(name, closeIfShowing));
  }
  if (currentUser && (admin || info?.user_id === currentUser.id)) {
    actions.insertAdjacentHTML(
      "beforeend",
      '<button class="btn btn-danger img-overlay-delete" title="delete" aria-label="delete file">' +
        '<i class="ph-fill ph-trash"></i></button>',
    );
    actions.querySelector(".img-overlay-delete").addEventListener("click", async () => {
      if (await confirmDeleteFile(name, displayName)) closeIfShowing();
    });
  }
};

// 정보 조회(fetchOverlayInfo 결과 promise)를 기다려 패널을 채운다. 조회에 실패하면 빈 상태 대신 오류와 retry 를 보여 주고,
// 권한을 판단할 수 없으므로 좋아요·댓글 입력·이동·삭제 버튼은 만들지 않는다
const loadOverlayDetails = async (dialog, name, displayName, resultPromise, seq) => {
  const [currentUser, admin, { info, error }] = await Promise.all([getCurrentUser(), isAdmin(), resultPromise]);
  if (seq !== overlaySeq) return;
  if (!error) {
    fillOverlayDetails(dialog, name, displayName, info, currentUser, admin);
    return;
  }
  const list = dialog.querySelector(".img-overlay-side .msg-list");
  list.innerHTML =
    `<p class="msg-empty msg-load-error"><i class="ph-fill ph-warning-circle" aria-hidden="true"></i>Couldn't load` +
    `<button type="button" class="btn msg-retry-btn"><i class="ph-fill ph-arrow-clockwise"></i> retry</button></p>`;
  list.querySelector(".msg-retry-btn").addEventListener("click", () => {
    list.innerHTML = loadingIndicatorHtml();
    // 누른 retry 버튼이 사라지므로 포커스를 dialog 로 돌려 ←/→ 키를 계속 받는다
    dialog.focus({ preventScroll: true });
    loadOverlayDetails(dialog, name, displayName, fetchOverlayInfo(name), seq);
  });
};

// 이미지 오버레이 표시 (파일 경로 + 이미지 사이즈 + 좋아요·댓글). 목록에 여러 장이 있으면 ←/→ 키와 버튼으로 이동한다.
// prefetched 는 미리 조회한 fetchOverlayInfo 결과(딥링크). 넘기지 않으면 여기서 조회한다
const showImageOverlay = async (url, name, displayName, prefetched) => {
  const replacing = overlayDialog !== null;
  overlayDialog ??= createOverlayDialog();
  const dialog = overlayDialog;
  const seq = ++overlaySeq;
  overlayName = name;
  const resultPromise = Promise.resolve(prefetched ?? fetchOverlayInfo(name));
  if (replacing) {
    // 이전 화면을 잠깐(최대 300ms) 남겨 두고 새 이미지 디코드와 정보 조회를 기다렸다 한 번에 바꿔 빈 화면 깜빡임을 줄인다
    const ready = Promise.all([resultPromise, isVideoName(name) ? null : decodeImage(url)]);
    await Promise.race([ready, delay(300)]);
    if (seq !== overlaySeq) return;
  }
  renderOverlayContent(dialog, url, name, displayName);
  await loadOverlayDetails(dialog, name, displayName, resultPromise, seq);
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

// 딥링크(#dir/file) 로 들어온 경우 목록 스크롤 대신 해당 파일만 오버레이로 보여준다.
// 표시 이름을 알아야 하므로 오버레이 정보를 먼저 조회해 넘긴다
export const showOverlayByName = async (name) => {
  const {
    data: { publicUrl },
  } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(name);
  const result = await fetchOverlayInfo(name);
  showImageOverlay(publicUrl, name, result.info?.display_name || name, result);
};

// 그리드 모드용 간략 HTML 생성
const buildGridItemHtml = (name, publicUrl, likeCountMap, userLikeSet, displayName) => {
  const isImage = !isVideoName(name);
  const msgId = toSafeId(name);

  const mediaHtml = isImage
    ? `<img class="grid-thumb" loading="lazy" decoding="async" src="${publicUrl}" alt="${escapeHtml(displayName)}">`
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
// 삭제/이동은 오버레이에서 한다
const setupGridHandlers = (name, currentUser, displayName) => {
  const card = document.getElementById(`grid_${toSafeId(name)}`);
  if (!card) return;
  bindOverlayOpen(card.querySelector(".grid-thumb"), name, displayName);
  bindOverlayOpen(card.querySelector(".grid-card-name"), name, displayName);
  setupLikeHandler(card.querySelector(".grid-card-like"), name, currentUser);
};

// 이미지/비디오 HTML 생성
const buildImageHtml = (name, metaMap, uploaderMap, publicUrl, likeCountMap, userLikeSet, displayName) => {
  const isImage = !isVideoName(name);
  const msgId = toSafeId(name);
  const msgHtml = `${messageFormHtml}<div class="msg-list" data-image="${escapeHtml(name)}"></div>`;
  const meta = metaMap[name] || {};
  const uploadInfo = uploaderMap[name] || {};
  const uploaderAvatar = uploadInfo.user_id
    ? `<img class="title-avatar" src="${makeDicebear(uploadInfo.user_id)}" alt="">`
    : "";
  // 마지막 메타 항목과 좋아요를 한 덩어리(.img-meta-end)로 묶어, 줄바꿈될 때 좋아요만 다음 줄에 혼자 남지 않게 한다
  const metaParts = [
    meta.size ? `<span class="img-file-size">${formatFileSize(meta.size)}</span>` : "",
    meta.created_at ? `<span class="img-upload-time">${formatDate(meta.created_at)}</span>` : "",
    uploadInfo.user_name
      ? `<span class="img-uploader">${uploaderAvatar}${escapeHtml(uploadInfo.user_name)}</span>`
      : "",
  ].filter(Boolean);
  const likeHtml = buildLikeHtml("img-like", name, likeCountMap[name] || 0, userLikeSet.has(name));
  const metaEndHtml = `<span class="img-meta-end">${metaParts.pop() ?? ""}${likeHtml}</span>`;
  const metaHtml = `<span class="img-meta">${[...metaParts, metaEndHtml].join(" ")}</span>`;
  // 파일 조작(admin move, 본인/admin 삭제)은 .img-file-actions 로 따로 묶는다. 좁은 화면에서 제목과 다른 열에 둬
  // 터치 히트 영역이 제목 링크/좋아요를 덮지 않게 한다. 넓은 화면에서는 두 묶음 모두 display: contents 라 배치가 같다.
  const moveHtml = `<span class="img-file-move" id="file_move_${msgId}" style="display:none"></span>`;
  const deleteHtml = `<span class="img-file-delete" id="file_del_${msgId}" style="display:none"></span>`;
  const actionsHtml = `<span class="img-file-actions">${moveHtml}${deleteHtml}</span>`;
  const linkHtml = `<a class="img-link" href="#${encodeURIComponent(name)}">${escapeHtml(displayName)}</a>`;
  // 오버레이 prev/next 순서(getRenderedNames)와 삭제·이동 후 카드 제거가 data-name 을 쓴다
  const cardOpen = `<div class="card" data-name="${escapeHtml(name)}">`;
  if (isImage) {
    const mediaHtml = `<img class="thumbnail" loading="lazy" decoding="async" src="${publicUrl}" alt="${escapeHtml(displayName)}">`;
    return (
      cardOpen +
      `<p class="title"><span class="title-main">${linkHtml} <span id="${msgId}_img_size"></span> ${metaHtml}</span> ${actionsHtml}</p>` +
      `<div class="img-content-row"><div class="img-media" id="${msgId}_img">${mediaHtml}</div><div class="img-side-msg">${msgHtml}</div></div></div>`
    );
  }
  // 스크롤로 쌓인 영상이 한꺼번에 재생되지 않도록 자동재생 없이 메타데이터만 미리 받는다
  const mediaHtml = `<video controls muted playsinline preload="metadata"><source type="video/mp4" src="${publicUrl}"></video>`;
  return (
    cardOpen +
    `<p class="title"><span class="title-main">${linkHtml} ${metaHtml}</span> ${actionsHtml}</p>` +
    `<div class="img-content-row"><div class="img-media" id="${msgId}_video">${mediaHtml}</div><div class="img-side-msg">${msgHtml}</div></div></div>`
  );
};

// 이벤트 핸들러 등록 (썸네일 클릭, 삭제, 이동, 메시지 등)
const setupImageHandlers = (name, currentUser, admin, uploaderMap, messageMap, displayName) => {
  const isImage = !isVideoName(name);
  const msgId = toSafeId(name);
  const id = isImage ? `${msgId}_img` : `${msgId}_video`;
  const mediaEl = document.getElementById(id);
  if (mediaEl == null) {
    return;
  }
  const card = mediaEl.closest(".card");
  bindOverlayOpen(card.querySelector(".img-link"), name, displayName);
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
  if (admin) {
    const moveEl = document.getElementById(`file_move_${msgId}`);
    if (moveEl) {
      moveEl.style.display = "";
      moveEl.innerHTML = `<button class="btn img-file-move-btn">move</button>`;
      moveEl.querySelector(".img-file-move-btn").addEventListener("click", () => pickDirAndMove(name));
    }
  }
  // 본인 업로드 파일만 삭제 버튼 표시
  const uploadInfo = uploaderMap[name] || {};
  if (currentUser && (admin || uploadInfo.user_id === currentUser.id)) {
    const delEl = document.getElementById(`file_del_${msgId}`);
    if (delEl) {
      delEl.style.display = "";
      delEl.innerHTML = `<button class="btn btn-danger img-file-delete-btn" aria-label="delete file">x</button>`;
      delEl.querySelector(".img-file-delete-btn").addEventListener("click", () => confirmDeleteFile(name, displayName));
    }
  }
  setupLikeHandler(card.querySelector(".img-like"), name, currentUser);
  // 메시지 렌더 (loadImages 가 image_info 임베드로 미리 받아온 rows)
  renderMessages(card.querySelector(".msg-list"), name, currentUser?.id, messageMap[name] || [], 0, admin);
  // 로그인한 사용자만 메시지 입력 가능
  setupMessageForm(card.querySelector(".img-message"), name, currentUser);
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
