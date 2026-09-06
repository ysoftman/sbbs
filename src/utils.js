import { Avatar, Style } from "@dicebear/core";
import pixelArt from "@dicebear/styles/pixel-art.json";

const textEncoder = new TextEncoder();

// 파일명을 DOM/CSS selector에 안전하고 충돌 없는 HTML id로 변환
export const toSafeId = (name) =>
  `id_${Array.from(textEncoder.encode(name), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

export const isVideoName = (name) => name.toLowerCase().endsWith(".mp4");

// 저장 시 파일명은 Supabase Storage ASCII 제한 때문에 encodeURIComponent 로 인코딩된다. 표시 시 원본으로 복원한다.
export const displayName = (name) => {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

export const formatCount = (n) => {
  if (n == null) return "0";
  if (n < 1000) return `${n}`;
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}K`;
  return `${(n / 1000000).toFixed(1)}M`;
};

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

// 이미지별 메시지 영역 높이 재계산 함수 저장 (image.js, message.js 에서 공유)
export const maxHeightUpdaters = {};

// 화면 크기 변경 시 모든 메시지 영역 높이 재계산
window.addEventListener("resize", () => {
  for (const fn of Object.values(maxHeightUpdaters)) fn();
});

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

// 테마 커스텀 alert
export const showAlert = (message) => {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML =
      '<div class="dialog-inner panel" role="alertdialog" aria-modal="true">' +
      '<p class="dialog-message"></p>' +
      '<div class="dialog-buttons">' +
      '<button class="btn btn-primary dialog-ok">OK</button>' +
      "</div></div>";
    overlay.querySelector(".dialog-message").textContent = message;
    document.body.appendChild(overlay);
    const ok = overlay.querySelector(".dialog-ok");
    ok.focus();
    const close = () => {
      overlay.remove();
      resolve();
    };
    ok.addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const focusable = overlay.querySelectorAll(
          "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    });
  });
};

// 테마 커스텀 confirm
export const showConfirm = (message) => {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML =
      '<div class="dialog-inner panel" role="dialog" aria-modal="true">' +
      '<p class="dialog-message"></p>' +
      '<div class="dialog-buttons">' +
      '<button class="btn btn-primary dialog-yes">OK</button> ' +
      '<button class="btn dialog-no">Cancel</button>' +
      "</div></div>";
    overlay.querySelector(".dialog-message").textContent = message;
    document.body.appendChild(overlay);
    const yes = overlay.querySelector(".dialog-yes");
    yes.focus();
    const accept = () => {
      overlay.remove();
      resolve(true);
    };
    const cancel = () => {
      overlay.remove();
      resolve(false);
    };
    yes.addEventListener("click", accept);
    overlay.querySelector(".dialog-no").addEventListener("click", cancel);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cancel();
    });
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") cancel();
      if (e.key === "Tab") {
        const focusable = overlay.querySelectorAll(
          "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    });
  });
};
