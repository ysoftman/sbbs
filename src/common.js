// ysoftman
import "./common.css"; // css, scss 중 마지막에 import 해야 올바르게 적용된다.
import { pixelArt } from "@dicebear/collection";
import { createAvatar } from "@dicebear/core";
import { createClient } from "@supabase/supabase-js";

import { supabasePublishableKey, supabaseUrl } from "./supabase_config.js";
import { escapeHtml, showAlert } from "./utils.js";

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

const loginBoxID = "login_google";
const loginAnonymousBoxID = "login_anonymous";

const makeAvatarHTML = (seed) => {
  const src = createAvatar(pixelArt, { seed }).toDataUri();
  return `<img class="login-avatar" src="${src}">`;
};

const makeLogoutBoxHTML = (userName, userId) => {
  const avatars = userId ? makeAvatarHTML(userId) : "";
  if (userName.length === 0) {
    return `${avatars}Anonymous (logout)`;
  }
  return `${avatars}${escapeHtml(userName)} (logout)`;
};

// 사용자의 로그인 상태가 변경될 때마다 UI 업데이트
supabase.auth.onAuthStateChange((_event, session) => {
  currentUser = session?.user ?? null;
  currentUserReady = true;
  if (session?.user) {
    const user = session.user;
    if (user.is_anonymous) {
      document.getElementById(loginAnonymousBoxID).innerHTML = makeLogoutBoxHTML("", user.id);
      return;
    }
    const userName = user.user_metadata?.full_name || user.email?.split("@")[0] || "Unknown";
    document.getElementById(loginBoxID).innerHTML = makeLogoutBoxHTML(userName, user.id);
    document.getElementById(loginAnonymousBoxID).innerHTML = "login Anonymous";
  } else {
    // User is signed out.
  }
});

// supabase > authentication > 익명 로그인 활성화했음
const loginAnonymous = async () => {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user?.is_anonymous) {
    await logout();
    document.getElementById(loginAnonymousBoxID).innerHTML = "login Anonymous";
    return;
  }
  const { error } = await supabase.auth.signInAnonymously();
  if (error) {
    console.warn("signInAnonymously error:", error);
    return;
  }
  const {
    data: { session },
  } = await supabase.auth.getSession();
  document.getElementById(loginAnonymousBoxID).innerHTML = makeLogoutBoxHTML("", session?.user?.id);
  window.location.reload();
};

// 구글 로그인하기
const loginGoogle = async () => {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // 이미 구글 로그인된 상태면 로그아웃
  if (user?.email) {
    await logout();
    return;
  }
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

// 로그인 버튼 이벤트는 한 번만 등록
document.getElementById(loginBoxID).addEventListener("click", loginGoogle);
document.getElementById(loginAnonymousBoxID).addEventListener("click", loginAnonymous);
