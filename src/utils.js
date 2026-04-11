import { pixelArt } from "@dicebear/collection";
import { createAvatar } from "@dicebear/core";

// 파일명을 HTML id로 사용할 수 있도록 변환
export const toSafeId = (name) => name.replaceAll(/[^a-zA-Z0-9]/g, "_");

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

// 이미지별 textarea max-height 재계산 함수 저장 (image.js, message.js 에서 공유)
export const maxHeightUpdaters = {};

// 테마 커스텀 alert
export const showAlert = (message) => {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML =
      '<div class="dialog-inner nes-container is-dark">' +
      `<p class="dialog-message">${message}</p>` +
      '<div class="dialog-buttons">' +
      '<button class="nes-btn is-primary dialog-ok">OK</button>' +
      "</div></div>";
    document.body.appendChild(overlay);
    const ok = overlay.querySelector(".dialog-ok");
    ok.focus();
    ok.addEventListener("click", () => {
      overlay.remove();
      resolve();
    });
  });
};

// 테마 커스텀 confirm
export const showConfirm = (message) => {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML =
      '<div class="dialog-inner nes-container is-dark">' +
      `<p class="dialog-message">${message}</p>` +
      '<div class="dialog-buttons">' +
      '<button class="nes-btn is-primary dialog-yes">OK</button> ' +
      '<button class="nes-btn is-error dialog-no">Cancel</button>' +
      "</div></div>";
    document.body.appendChild(overlay);
    const yes = overlay.querySelector(".dialog-yes");
    yes.focus();
    yes.addEventListener("click", () => {
      overlay.remove();
      resolve(true);
    });
    overlay.querySelector(".dialog-no").addEventListener("click", () => {
      overlay.remove();
      resolve(false);
    });
  });
};
