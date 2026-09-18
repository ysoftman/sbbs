import { supabase } from "./common.js";
import { escapeHtml, makeDicebear, maxHeightUpdaters, showAlert, showConfirm } from "./utils.js";

export const INITIAL_LIMIT = 10;
const MORE_LIMIT = 5;

// 이미지 메시지 저장
export const saveMessage = async (imageName, message, userName, userId) => {
  try {
    const { error } = await supabase.from("image_messages").insert({
      image_name: imageName,
      message: message,
      user_name: userName,
      user_id: userId,
    });
    if (error) {
      console.warn("saveMessage error:", error);
      await showAlert(`saveMessage error: ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("saveMessage error:", err);
    await showAlert(`saveMessage error: ${err.message || err}`);
    return false;
  }
};

// 이미지 메시지 삭제
const deleteMessage = async (id) => {
  const { error } = await supabase.from("image_messages").delete().eq("id", id);
  if (error) {
    console.warn("deleteMessage error:", error);
    await showAlert(`deleteMessage error: ${error.message}`);
  }
};

const renderMessageRow = (row, currentUserId, imageName, listId) => {
  const d = new Date(row.created_at);
  const date = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  const user = escapeHtml(row.user_name || "Unknown");
  const msg = escapeHtml(row.message).replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  const deleteBtn =
    currentUserId && row.user_id === currentUserId
      ? ` <button class="btn btn-danger msg-delete-btn" data-msg-id="${row.id}" data-image-name="${escapeHtml(imageName)}" data-list-id="${escapeHtml(listId)}">x</button>`
      : "";
  const seed = row.user_id || row.user_name || "Unknown";
  const avatar = `<img class="msg-avatar" src="${makeDicebear(seed)}" title="dicebear pixel-art">`;
  return `<div class="msg-item">${avatar}<span class="t-muted">${date}</span> <span class="t-strong">${user}</span> ${msg}${deleteBtn}</div>`;
};

// 조회된 메시지 렌더링 (limit 보다 1개 많으면 more 버튼 표시).
// 초기 목록은 loadImages 가 image_info 임베드로 미리 받아온 rows 를 넘기므로 이미지별 요청이 없다.
export const renderMessages = (imageName, listId, currentUserId, data, offset = 0) => {
  const el = document.getElementById(listId);
  if (!el) return;
  const limit = offset === 0 ? INITIAL_LIMIT : MORE_LIMIT;
  if (data.length === 0) {
    // 초기 페이지가 비면(마지막 댓글 삭제 등) 남아 있는 목록을 비우고, 추가 페이지가 비면 more 버튼만 제거
    if (offset === 0) {
      el.innerHTML = "";
    } else {
      el.querySelector(".msg-more")?.remove();
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
      if (!(await showConfirm("delete?"))) return;
      await deleteMessage(e.target.dataset.msgId);
      await loadMessages(e.target.dataset.imageName, e.target.dataset.listId, currentUserId);
    });
  }
  // 더보기 버튼
  if (hasMore) {
    el.insertAdjacentHTML("beforeend", `<div class="msg-more"><button class="btn msg-more-btn">more</button></div>`);
    el.querySelector(".msg-more-btn").addEventListener("click", () => {
      loadMessages(imageName, listId, currentUserId, newOffset);
    });
  }
  // 메시지 로드 후 textarea max-height 재계산
  const msgIdKey = listId.replace("msg_list_", "");
  if (maxHeightUpdaters[msgIdKey]) maxHeightUpdaters[msgIdKey]();
};

// 이미지 메시지 조회 (초기 10개, 이후 5개씩 추가 로드). more 버튼과 저장/삭제 후 갱신에 사용
export const loadMessages = async (imageName, listId, currentUserId, offset = 0) => {
  const el = document.getElementById(listId);
  if (!el) {
    console.warn("loadMessages: element not found:", listId);
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
    console.warn("loadMessages error:", error);
    el.innerHTML = `<div class="msg-item"><span class="t-danger">${escapeHtml(error.message)}</span></div>`;
    return;
  }
  renderMessages(imageName, listId, currentUserId, data || [], offset);
};
