import { supabase } from "./common.js";
import { makeDicebear, maxHeightUpdaters } from "./utils.js";

const INITIAL_LIMIT = 10;
const MORE_LIMIT = 5;

// 이미지 메시지 저장
export const saveMessage = async (imageName, message, userName, userId) => {
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

const renderMessageRow = (row, currentUserId, imageName, listId) => {
  const d = new Date(row.created_at);
  const date = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  const user = row.user_name || "Unknown";
  const msg = row.message.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const deleteBtn =
    currentUserId && row.user_id === currentUserId
      ? ` <button class="nes-btn is-error msg-delete-btn" data-msg-id="${row.id}" data-image-name="${imageName}" data-list-id="${listId}">x</button>`
      : "";
  const seed = row.user_id || user;
  const avatar = `<img class="msg-avatar" src="${makeDicebear(seed)}" title="dicebear pixel-art">`;
  return `<div class="msg-item">${avatar}<span class="nes-text is-disabled">${date}</span> <span class="nes-text is-primary">${user}</span> ${msg}${deleteBtn}</div>`;
};

// 이미지 메시지 조회 (초기 10개, 이후 5개씩 추가 로드)
export const loadMessages = async (imageName, listId, currentUserId, offset = 0) => {
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
