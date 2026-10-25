import { isAdmin, supabase } from "./common.js";
import { escapeHtml, formatDateTime, formatRelativeTime, makeDicebear, showAlert, showConfirm } from "./utils.js";

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

// 이미지 메시지 삭제. RLS 에 막히면 오류 없이 0행 삭제로 끝나므로 실제로 지워진 행 수로 확인한다
const deleteMessage = async (id) => {
  const { data, error } = await supabase.from("image_messages").delete().eq("id", id).select("id");
  if (error) {
    console.warn("deleteMessage error:", error);
    await showAlert(`deleteMessage error: ${error.message}`);
    return;
  }
  if (!data?.length) {
    await showAlert("delete failed: no permission or already deleted (check RLS policy on image_messages)");
  }
};

// 댓글 행: 아바타 | 이름 · 상대 시간(title 에 정확한 일시) / 다음 줄에 본문. 삭제 버튼은 본인 댓글, admin 은 모든 댓글
const renderMessageRow = (row, currentUserId, admin) => {
  const user = escapeHtml(row.user_name || "Unknown");
  const msg = escapeHtml(row.message).replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  const deleteBtn =
    currentUserId && (admin || row.user_id === currentUserId)
      ? `<button class="btn btn-danger msg-delete-btn" aria-label="delete comment" data-msg-id="${row.id}">x</button>`
      : "";
  const seed = row.user_id || row.user_name || "Unknown";
  const avatar = `<img class="msg-avatar" src="${makeDicebear(seed)}" alt="" title="dicebear pixel-art">`;
  const time = row.created_at
    ? `<time class="msg-time" datetime="${escapeHtml(row.created_at)}" title="${formatDateTime(row.created_at)}">${formatRelativeTime(row.created_at)}</time>`
    : "";
  return (
    `<div class="msg-item">${avatar}<div class="msg-body">` +
    `<div class="msg-head"><span class="msg-user">${user}</span>${time}${deleteBtn}</div>` +
    `<div class="msg-text">${msg}</div></div></div>`
  );
};

// 댓글이 없을 때 빈 영역 대신 보이는 안내. 비로그인은 currentUserId 가 없다.
const emptyMessagesHtml = (currentUserId) =>
  `<p class="msg-empty"><i class="ph-fill ph-chat-circle" aria-hidden="true"></i>` +
  `${currentUserId ? "No comments yet" : "Log in to comment"}</p>`;

const fetchMessages = (imageName, offset, limit) =>
  supabase
    .from("image_messages")
    .select("id, message, user_name, user_id, created_at")
    .eq("image_name", imageName)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit);

const messageErrorHtml = (error) =>
  `<div class="msg-item"><span class="t-danger">${escapeHtml(error.message)}</span></div>`;

// 조회된 메시지를 el(.msg-list)에 렌더링 (limit 보다 1개 많으면 more 버튼 표시).
// 초기 목록은 loadImages / 오버레이가 image_info 임베드로 미리 받아온 rows 를 넘기므로 이미지별 요청이 없다.
export const renderMessages = (el, imageName, currentUserId, data, offset = 0, admin = false) => {
  const limit = offset === 0 ? INITIAL_LIMIT : MORE_LIMIT;
  if (data.length === 0) {
    // 초기 페이지가 비면(댓글 없음, 마지막 댓글 삭제) 안내로 바꾸고, 추가 페이지가 비면 more 버튼만 제거
    if (offset === 0) {
      el.innerHTML = emptyMessagesHtml(currentUserId);
    } else {
      el.querySelector(".msg-more")?.remove();
    }
    return;
  }
  const hasMore = data.length > limit;
  const rows = hasMore ? data.slice(0, limit) : data;
  const newOffset = offset + rows.length;
  const html = rows.map((row) => renderMessageRow(row, currentUserId, admin)).join("");

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
    btn.addEventListener("click", async () => {
      if (!(await showConfirm("delete?"))) return;
      await deleteMessage(btn.dataset.msgId);
      await reloadMessageLists(imageName, currentUserId);
    });
  }
  // 더보기 버튼
  if (hasMore) {
    el.insertAdjacentHTML("beforeend", `<div class="msg-more"><button class="btn msg-more-btn">more</button></div>`);
    el.querySelector(".msg-more-btn").addEventListener("click", () => {
      loadMessages(el, imageName, currentUserId, newOffset);
    });
  }
};

// 이미지 메시지 추가 조회 (more 버튼, 5개씩)
const loadMessages = async (el, imageName, currentUserId, offset) => {
  // 1개 더 조회하여 다음 페이지 존재 여부 확인
  const [{ data, error }, admin] = await Promise.all([fetchMessages(imageName, offset, MORE_LIMIT), isAdmin()]);
  if (!el.isConnected) return;
  if (error) {
    console.warn("loadMessages error:", error);
    el.innerHTML = messageErrorHtml(error);
    return;
  }
  renderMessages(el, imageName, currentUserId, data || [], offset, admin);
};

// 같은 이미지의 댓글 목록(.msg-list[data-image], 목록 카드·오버레이)을 한 번 조회해 모두 첫 페이지부터 다시 그린다.
// 저장/삭제 후 갱신에 사용
export const reloadMessageLists = async (imageName, currentUserId) => {
  const lists = () => [...document.querySelectorAll(".msg-list")].filter((el) => el.dataset.image === imageName);
  if (lists().length === 0) return;
  const [{ data, error }, admin] = await Promise.all([fetchMessages(imageName, 0, INITIAL_LIMIT), isAdmin()]);
  if (error) console.warn("loadMessages error:", error);
  // 조회 사이에 오버레이가 다른 이미지로 바뀌었을 수 있으므로 목록을 다시 찾는다
  for (const el of lists()) {
    if (error) el.innerHTML = messageErrorHtml(error);
    else renderMessages(el, imageName, currentUserId, data || [], 0, admin);
  }
};
