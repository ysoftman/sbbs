// ysoftman
import "./common.css"; // css, scss 중 마지막에 import 해야 올바르게 적용된다.
import { pixelArt } from "@dicebear/collection";
import { createAvatar } from "@dicebear/core";
import { createClient } from "@supabase/supabase-js";

import { supabasePublishableKey, supabaseUrl } from "./supabase_config.js";
import { showAlert } from "./utils.js";

export const supabase = createClient(supabaseUrl(), supabasePublishableKey());

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
  return `${avatars}${userName} (logout)`;
};

// 로그인한 사용자에 대한 정보가 필요한 앱 페이지마다 인증 상태 변경 리스너를 등록합니다.
// 사용자의 로그인 상태가 변경될 때마다 이 콜백이 호출됩니다.
supabase.auth.onAuthStateChange((_event, session) => {
  document.getElementById(loginBoxID).addEventListener("click", loginGoogle);
  document.getElementById(loginAnonymousBoxID).addEventListener("click", loginAnonymous);
  if (session?.user) {
    const user = session.user;
    console.log("user:", user);
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
    console.log("error: ", error);
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
  if (user?.email) {
    await logout();
    return;
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
  console.log("logout...");
  window.location.reload();
};
