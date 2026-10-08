import { createClient } from "@supabase/supabase-js";

import { supabasePublishableKey, supabaseUrl } from "./supabase_config.js";
import { escapeHtml, makeDicebear, showAlert } from "./utils.js";

export const supabase = createClient(supabaseUrl(), supabasePublishableKey());

// 현재 사용자 단일 소스. supabase.auth.getUser() 동시 호출이 Web Locks 경쟁을
// 일으키므로 startup 시 한 번만 호출하고 onAuthStateChange 로 갱신한다.
let currentUser = null;
let currentUserReady = false;
const currentUserPromise = supabase.auth.getUser().then(({ data }) => {
  currentUser = data?.user ?? null;
  currentUserReady = true;
  return currentUser;
});
export const getCurrentUser = () => (currentUserReady ? Promise.resolve(currentUser) : currentUserPromise);

// admin 여부. 로그인 상태가 바뀌면 페이지를 reload 하므로 세션 동안 한 번만 조회한다.
let adminPromise = null;
export const isAdmin = () => {
  adminPromise ??= getCurrentUser().then(async (user) => {
    if (!user) return false;
    const { data } = await supabase.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
    return !!data;
  });
  return adminPromise;
};

// 화면/DB 에 남길 사용자 이름 (계정 버튼, 댓글, 업로드 공통)
export const getUserName = (user) =>
  user.is_anonymous ? "Anonymous" : user.user_metadata?.full_name || user.email?.split("@")[0] || "Unknown";

const accountBtn = document.getElementById("btn_account");
const accountMenu = document.getElementById("account_menu");
const loginGoogleBtn = document.getElementById("login_google");
const loginAnonymousBtn = document.getElementById("login_anonymous");
const logoutBtn = document.getElementById("btn_logout");

// 아바타 옆에 이름이 같이 나오므로 장식 이미지로 둔다
const makeAvatarHTML = (seed) => `<img class="login-avatar" src="${makeDicebear(seed)}" alt="">`;

// 계정 버튼은 현재 상태(비로그인 / 익명 / 구글 이름)만 보여주고,
// 메뉴에는 그 상태에서 할 수 있는 동작만 남긴다.
const renderAccount = (user) => {
  const name = user ? getUserName(user) : "login";
  const icon = user ? makeAvatarHTML(user.id) : `<i class="ph-fill ph-user-circle"></i>`;
  const caret = `<i class="ph-fill ph-caret-down account-caret"></i>`;
  accountBtn.innerHTML = `${icon}<span class="account-name">${escapeHtml(name)}</span>${caret}`;
  // 긴 이름은 버튼에서 말줄임되므로 전체 이름을 툴팁으로 남긴다
  accountBtn.title = user ? name : "";
  loginGoogleBtn.hidden = !!user && !user.is_anonymous;
  loginAnonymousBtn.hidden = !!user;
  logoutBtn.hidden = !user;
};

// 사용자의 로그인 상태가 변경될 때마다 UI 업데이트
supabase.auth.onAuthStateChange((_event, session) => {
  currentUser = session?.user ?? null;
  currentUserReady = true;
  renderAccount(currentUser);
});

// 메뉴는 fixed 라 열 때마다 계정 버튼 바로 아래, 오른쪽 끝을 맞춰 놓는다
const placeAccountMenu = () => {
  const rect = accountBtn.getBoundingClientRect();
  accountMenu.style.top = `${rect.bottom + 6}px`;
  accountMenu.style.right = `${document.documentElement.clientWidth - rect.right}px`;
};

if ("popover" in HTMLElement.prototype) {
  accountMenu.addEventListener("beforetoggle", (e) => {
    if (e.newState === "open") placeAccountMenu();
  });
} else {
  // popover 미지원 브라우저(Safari 17, Firefox 125 미만)는 [popover] 를 일반 div 로 그려 메뉴가 늘 펼쳐진다.
  // hidden 으로 닫아 두고 버튼 클릭으로 열고, 바깥 클릭/Esc 로 닫는다(네이티브 light dismiss 대신).
  // 열림 상태를 쓰는 쪽이 같은 코드로 다루도록 네이티브처럼 toggle 이벤트(newState: "open"/"closed")를 보낸다.
  const setAccountMenuOpen = (open) => {
    if (open === !accountMenu.hidden) return;
    if (open) placeAccountMenu();
    accountMenu.hidden = !open;
    accountBtn.setAttribute("aria-expanded", String(open));
    const toggle = new Event("toggle");
    toggle.newState = open ? "open" : "closed";
    accountMenu.dispatchEvent(toggle);
  };
  accountMenu.hidden = true;
  accountBtn.setAttribute("aria-expanded", "false");
  accountBtn.addEventListener("click", () => setAccountMenuOpen(accountMenu.hidden));
  document.addEventListener("click", (e) => {
    if (!accountMenu.contains(e.target) && !accountBtn.contains(e.target)) setAccountMenuOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || accountMenu.hidden) return;
    const focusInMenu = accountMenu.contains(document.activeElement);
    setAccountMenuOpen(false);
    if (focusInMenu) accountBtn.focus();
  });
}

// 카테고리 탭 행(.cat-tabs)은 가로 스크롤이다. Tab 키로 옮긴 탭이 가장자리에 걸쳐 있으면 브라우저가 스크롤하지 않아
// 탭과 포커스 링이 잘린 채 남으므로, scroll-padding(페이드 폭)을 지키는 scrollIntoView 로 다시 맞춘다.
// 마우스 클릭/드래그 정렬 중에는 탭이 움직이지 않도록 키보드 포커스(:focus-visible)일 때만 한다.
// :focus-visible 을 모르는 브라우저에서는 matches 가 SyntaxError 를 던지므로 그때는 보정을 건너뛴다.
const focusVisibleSupported = CSS.supports("selector(:focus-visible)");
document.querySelector(".cat-tabs").addEventListener("focusin", (e) => {
  if (focusVisibleSupported && e.target.matches(":focus-visible")) {
    e.target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
});

// supabase > authentication > 익명 로그인 활성화했음
// 버튼 UI 는 onAuthStateChange 가 갱신하고 logout/로그인 후에는 reload 하므로 여기서 직접 바꾸지 않는다.
const loginAnonymous = async () => {
  const { error } = await supabase.auth.signInAnonymously();
  if (error) {
    console.warn("signInAnonymously error:", error);
    return;
  }
  window.location.reload();
};

// 구글 로그인하기
const loginGoogle = async () => {
  const user = await getCurrentUser();
  // anonymous 상태에서 signInWithOAuth 를 호출하면 anonymous 세션이 남아있어
  // OAuth 완료 후에도 anonymous 가 유지되므로, 먼저 signOut 으로 세션을 비운다.
  // (reload 없이 signOut 해야 이어서 OAuth 리다이렉트가 실행된다.)
  if (user?.is_anonymous) {
    await supabase.auth.signOut();
  }
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.href,
    },
  });
  if (error) {
    await showAlert(`errCode:${error.code}\nerrMessage:${error.message}`);
  }
};

// 로그아웃
const logout = async () => {
  await supabase.auth.signOut();
  window.location.reload();
};

// 메뉴 항목 이벤트는 한 번만 등록. 상태에 맞지 않는 항목은 renderAccount 가 숨긴다
loginGoogleBtn.addEventListener("click", loginGoogle);
loginAnonymousBtn.addEventListener("click", loginAnonymous);
logoutBtn.addEventListener("click", logout);
