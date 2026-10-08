import { Avatar, Style } from "@dicebear/core";
import pixelArt from "@dicebear/styles/pixel-art.json";

const textEncoder = new TextEncoder();

// 파일명을 DOM/CSS selector에 안전하고 충돌 없는 HTML id로 변환
export const toSafeId = (name) =>
  `id_${Array.from(textEncoder.encode(name), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

export const isVideoName = (name) => name.toLowerCase().endsWith(".mp4");

const compactNumber = new Intl.NumberFormat("en", { notation: "compact" });
export const formatCount = (n) => compactNumber.format(n ?? 0);

export const formatFileSize = (bytes) => {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

export const formatDate = (dateStr) => {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
};

export const MAX_MSG_BYTES = 10000;
export const getByteLength = (str) => textEncoder.encode(str).length;

const pixelArtStyle = new Style(pixelArt);

export const makeDicebear = (seed) => new Avatar(pixelArtStyle, { seed }).toDataUri();

// HTML 특수문자 escape (XSS 방지)
export const escapeHtml = (str) =>
  str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const loadingIndicatorHtml = (label = "loading") =>
  `<div class="loading-indicator">${label}<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span></div>`;

// 화면을 통째로 채우는 로딩. 최종 레이아웃과 같은 모양이라 콘텐츠가 들어와도 자리가 튀지 않는다.
export const skeletonHtml = (mode) =>
  mode === "grid"
    ? '<div class="sk-card"><div class="sk-media"></div><div class="sk-line"></div></div>'.repeat(12)
    : '<div class="sk-row"><div class="sk-line sk-title"></div><div class="sk-media"></div></div>'.repeat(2);

// 비어 있는 이유와 채우는 방법을 함께 보여준다
export const emptyStateHtml = (icon, title, hint) =>
  `<div class="empty-state"><i class="ph-fill ph-${icon}"></i>` +
  `<p class="empty-title">${title}</p>` +
  (hint ? `<p class="empty-hint">${hint}</p>` : "") +
  "</div>";

// 네이티브 모달 <dialog>. 포커스 가두기·Esc·top layer 는 브라우저가 처리한다.
// form[method=dialog] 버튼의 value 가 closed 의 결과가 되고, Esc·배경 클릭은 "" 로 닫힌다.
export const openDialog = (html) => {
  const dialog = document.createElement("dialog");
  dialog.className = "dialog";
  dialog.innerHTML = `<div class="dialog-inner panel">${html}</div>`;
  // 배경(::backdrop) 클릭은 dialog 자신이 target 이 된다
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close("");
  });
  const closed = new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(dialog.returnValue);
    });
  });
  document.body.appendChild(dialog);
  dialog.showModal();
  return { dialog, closed };
};

const dialogMessageHtml = (message, buttons) =>
  `<p class="dialog-message">${escapeHtml(message)}</p><form method="dialog" class="dialog-buttons">${buttons}</form>`;

export const showAlert = async (message) => {
  await openDialog(dialogMessageHtml(message, '<button class="btn btn-primary" value="ok" autofocus>OK</button>'))
    .closed;
};

export const showConfirm = async (message) =>
  (await openDialog(
    dialogMessageHtml(
      message,
      '<button class="btn btn-primary" value="ok" autofocus>OK</button><button class="btn" value="cancel">Cancel</button>',
    ),
  ).closed) === "ok";

// 카테고리 선택 다이얼로그 (업로드 대상 / 파일 이동).
// 업로드는 file input 을 열어야 하므로 close 이벤트를 기다리지 않고 클릭 안에서 바로 onSelect 를 부른다.
export const showDirPicker = (title, dirs, onSelect) => {
  const dirsHtml =
    dirs.length > 0
      ? dirs
          .map(
            (dir) =>
              `<button type="button" class="btn btn-primary" data-dir="${escapeHtml(dir)}">${escapeHtml(dir)}</button>`,
          )
          .join("")
      : '<span class="t-muted">no categories</span>';
  const { dialog } = openDialog(
    `<p>${title}</p><div class="move-dir-list">${dirsHtml}</div>` +
      '<form method="dialog"><button class="btn">cancel</button></form>',
  );
  dialog.addEventListener("click", (e) => {
    const dir = e.target.closest("[data-dir]")?.dataset.dir;
    if (dir === undefined) return;
    dialog.close(dir);
    onSelect(dir);
  });
};
