import { pixelArt } from "@dicebear/collection";
import { createAvatar } from "@dicebear/core";

// 파일명을 HTML id로 사용할 수 있도록 변환
export const toSafeId = (name) => name.replaceAll(/[^a-zA-Z0-9]/g, "_");

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
const textEncoder = new TextEncoder();
export const getByteLength = (str) => textEncoder.encode(str).length;

export const makeDicebear = (seed) => {
  const avatar = createAvatar(pixelArt, { seed });
  return avatar.toDataUri();
};

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

// 테마 커스텀 alert
export const showAlert = (message) => {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML =
      '<div class="dialog-inner nes-container is-dark" role="alertdialog" aria-modal="true">' +
      '<p class="dialog-message"></p>' +
      '<div class="dialog-buttons">' +
      '<button class="nes-btn is-primary dialog-ok">OK</button>' +
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
      '<div class="dialog-inner nes-container is-dark" role="dialog" aria-modal="true">' +
      '<p class="dialog-message"></p>' +
      '<div class="dialog-buttons">' +
      '<button class="nes-btn is-primary dialog-yes">OK</button> ' +
      '<button class="nes-btn is-error dialog-no">Cancel</button>' +
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
