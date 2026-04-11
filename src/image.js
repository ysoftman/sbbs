import { supabase } from "./common.js";
import { loadMessages, saveMessage } from "./message.js";
import { deleteFile, getMeta, STORAGE_BUCKET } from "./storage.js";
import {
  formatDate,
  formatFileSize,
  getByteLength,
  MAX_MSG_BYTES,
  makeDicebear,
  maxHeightUpdaters,
  toSafeId,
} from "./utils.js";

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

export const loadImages = async (htmlId, imageNames, metaMap = {}, append = false) => {
  if (!append) document.getElementById(htmlId).innerHTML = "";
  const uploaderMap = {};
  if (imageNames.length > 0) {
    const { data: uploadData } = await supabase
      .from("image_uploads")
      .select("file_path, user_name, user_id")
      .in("file_path", imageNames);
    if (uploadData) {
      for (const row of uploadData) {
        uploaderMap[row.file_path] = { user_name: row.user_name, user_id: row.user_id };
      }
    }
  }
  let isImage = true;
  let item = "";
  for (const name of imageNames) {
    isImage = !name.endsWith("mp4");
    const msgId = toSafeId(name);
    const msgHtml =
      `<div class="img-message" id="msg_form_${msgId}" style="display:none">` +
      `<div class="msg-textarea-wrap">` +
      `<textarea class="nes-textarea" id="msg_${msgId}" rows="2" placeholder="message..."></textarea>` +
      `<span class="msg-charcount" id="msg_charcount_${msgId}">0/10,000 bytes</span>` +
      `</div>` +
      `<button class="nes-btn is-primary" id="msg_save_${msgId}">save</button>` +
      `<span class="nes-text is-success" id="msg_status_${msgId}"></span>` +
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
      (uploadInfo.user_name ? `${uploaderAvatar}<span class="img-uploader">${uploadInfo.user_name}</span> ` : "") +
      `</span>`;
    const deleteHtml = `<span class="img-file-delete" id="file_del_${msgId}" style="display:none"></span>`;
    // public URL을 즉시 생성하여 img/video 태그를 바로 포함
    const {
      data: { publicUrl },
    } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(name);
    let mediaHtml;
    if (isImage) {
      mediaHtml = `<img class="thumbnail" loading="lazy" src="${publicUrl}" data-name="${name}" data-url="${publicUrl}">`;
      item =
        `<div class="nes-container with-title">` +
        `<p class="title"><a class="img-link" href="#${encodeURIComponent(name)}">${name}</a> <span id="${name}_img_size"></span> ${metaHtml} ${deleteHtml}</p>` +
        `<div class="img-content-row"><div id="${name}_img">${mediaHtml}</div><div class="img-side-msg">${msgHtml}</div></div></div>`;
    } else {
      mediaHtml = `<video width="640" controls autoplay muted><source type="video/mp4" src=${publicUrl}></video>`;
      item =
        `<div class="nes-container with-title">` +
        `<p class="title"><a class="img-link" href="#${encodeURIComponent(name)}">${name}</a> ${metaHtml} ${deleteHtml}</p>` +
        `<div class="img-content-row"><div id="${name}_video">${mediaHtml}</div><div class="img-side-msg">${msgHtml}</div></div></div>`;
    }
    document.getElementById(htmlId).insertAdjacentHTML("beforeend", item);
  }
  // 로그인 상태 확인
  const {
    data: { user: currentUser },
  } = await supabase.auth.getUser();
  let isAdmin = false;
  if (currentUser) {
    const { data: adminRow } = await supabase.from("admins").select("user_id").eq("user_id", currentUser.id).single();
    isAdmin = !!adminRow;
  }

  for (const name of imageNames) {
    isImage = !name.endsWith("mp4");
    const id = isImage ? `${name}_img` : `${name}_video`;
    if (document.getElementById(id) == null) {
      continue;
    }
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
      const {
        data: { publicUrl },
      } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(name);
      getMeta(publicUrl, (_err, img) => {
        const imgSize = `(${img.naturalWidth}x${img.naturalHeight})`;
        if (document.getElementById(`${name}_img_size`) == null) {
          return;
        }
        document.getElementById(`${name}_img_size`).innerHTML = imgSize;
      });
    }
    // 본인 업로드 파일만 삭제 버튼 표시
    const msgId = toSafeId(name);
    const uploadInfo = uploaderMap[name] || {};
    if (currentUser && (isAdmin || uploadInfo.user_id === currentUser.id)) {
      const delEl = document.getElementById(`file_del_${msgId}`);
      if (delEl) {
        delEl.style.display = "";
        delEl.innerHTML = `<button class="nes-btn is-error img-file-delete-btn">x</button>`;
        delEl.querySelector(".img-file-delete-btn").addEventListener("click", async () => {
          if (!confirm(`delete "${name}"?`)) return;
          const deleted = await deleteFile(name);
          if (deleted) {
            const container = delEl.closest(".nes-container");
            if (container) container.remove();
          }
        });
      }
    }
    // 메시지 로드
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
          charcountEl.textContent = `${bytes.toLocaleString()}/${MAX_MSG_BYTES.toLocaleString()} bytes`;
          charcountEl.classList.toggle("is-over", bytes > MAX_MSG_BYTES);
        });
      }
      const saveBtn = document.getElementById(`msg_save_${msgId}`);
      if (saveBtn) {
        saveBtn.addEventListener("click", async () => {
          const statusEl = document.getElementById(`msg_status_${msgId}`);
          if (!textarea.value.trim()) return;
          if (getByteLength(textarea.value) > MAX_MSG_BYTES) {
            statusEl.innerHTML = `<span class="nes-text is-error">${MAX_MSG_BYTES.toLocaleString()} bytes exceeded</span>`;
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
