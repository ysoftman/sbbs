import "./common.js";
import "@fontsource/press-start-2p";
import "nes.css/css/nes.min.css";
import { supabase } from "./common.js";

const STORAGE_BUCKET = "images";

// 파일명을 HTML id로 사용할 수 있도록 변환
const toSafeId = (name) => name.replaceAll(/[^a-zA-Z0-9]/g, "_");

export const loadImages = async (htmlId, imageNames) => {
  document.getElementById(htmlId).innerHTML = "";
  let isImage = true;
  let item = "";
  for (const name of imageNames) {
    isImage = true;
    if (name.endsWith("mp4")) {
      isImage = false;
    }
    const msgId = toSafeId(name);
    const msgHtml =
      `<div class="msg-list" id="msg_list_${msgId}"></div>` +
      `<div class="img-message" id="msg_form_${msgId}" style="display:none">` +
      `<textarea class="nes-textarea" id="msg_${msgId}" rows="2" placeholder="message..."></textarea>` +
      `<button class="nes-btn is-primary" id="msg_save_${msgId}">save</button>` +
      `<span class="nes-text is-success" id="msg_status_${msgId}"></span>` +
      `</div>`;
    if (isImage) {
      item =
        `<div class="nes-container with-title">` +
        `<p class="title">${name} (<span id="${name}_img_size"></span>)</p>` +
        `<div class="img-content-row"><div id="${name}_img"></div><div class="img-side-msg">${msgHtml}</div></div></div>`;
    } else {
      item =
        `<div class="nes-container with-title">` +
        `<p class="title">${name}</p>` +
        `<div class="img-content-row"><div id="${name}_video"></div><div class="img-side-msg">${msgHtml}</div></div></div>`;
    }
    document.getElementById(htmlId).insertAdjacentHTML("beforeend", item);
  }
  // 로그인 상태 확인
  const {
    data: { user: currentUser },
  } = await supabase.auth.getUser();

  for (const name of imageNames) {
    // supabase storage 에 저장된 이미지 public url 불러오기
    const {
      data: { publicUrl },
    } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(name);
    const url = publicUrl;
    isImage = true;
    if (name.endsWith("mp4")) {
      isImage = false;
    }
    let id = name;
    if (isImage) {
      item = `<img class="thumbnail" loading="lazy" src=${url} onclick="const o=document.createElement('div');o.className='img-overlay';o.onclick=()=>o.remove();o.innerHTML='<img src=${url}>';document.body.appendChild(o);">`;
      id += "_img";
    } else {
      item = `<video width="640" controls autoplay muted><source type="video/mp4" src=${url}></video>`;
      id += "_video";
    }
    if (document.getElementById(id) == null) {
      continue;
    }
    document.getElementById(id).innerHTML = item;
    if (isImage) {
      getMeta(url, (_err, img) => {
        const imgSize = `<span>${img.naturalWidth}x${img.naturalHeight}</span>`;
        if (document.getElementById(`${name}_img_size`) == null) {
          return;
        }
        document.getElementById(`${name}_img_size`).innerHTML = imgSize;
      });
    }
    // 메시지 로드
    const msgId = toSafeId(name);
    await loadMessages(name, `msg_list_${msgId}`);
    // 로그인한 사용자만 메시지 입력 가능
    if (currentUser) {
      const formEl = document.getElementById(`msg_form_${msgId}`);
      if (formEl) formEl.style.display = "";
      const saveBtn = document.getElementById(`msg_save_${msgId}`);
      if (saveBtn) {
        saveBtn.addEventListener("click", async () => {
          const textarea = document.getElementById(`msg_${msgId}`);
          const statusEl = document.getElementById(`msg_status_${msgId}`);
          if (!textarea.value.trim()) return;
          const userName = currentUser.is_anonymous
            ? "Anonymous"
            : currentUser.user_metadata?.full_name || currentUser.email || "Unknown";
          await saveMessage(name, textarea.value, userName);
          textarea.value = "";
          statusEl.innerHTML = "saved!";
          setTimeout(() => {
            statusEl.innerHTML = "";
          }, 2000);
          await loadMessages(name, `msg_list_${msgId}`);
        });
      }
    }
  }
};

// 이미지 메시지 저장
const saveMessage = async (imageName, message, userName) => {
  const { error } = await supabase.from("image_messages").insert({
    image_name: imageName,
    message: message,
    user_name: userName,
  });
  if (error) {
    console.log("saveMessage error:", error);
    alert(`saveMessage error: ${error.message}`);
  }
};

// 이미지 메시지 최근 10개 조회
const loadMessages = async (imageName, listId) => {
  const el = document.getElementById(listId);
  if (!el) {
    console.log("loadMessages: element not found:", listId);
    return;
  }
  const { data, error } = await supabase
    .from("image_messages")
    .select("id, message, user_name, created_at")
    .eq("image_name", imageName)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) {
    console.log("loadMessages error:", error);
    el.innerHTML = `<div class="msg-item"><span class="nes-text is-error">${error.message}</span></div>`;
    return;
  }
  if (!data || data.length === 0) {
    return;
  }
  el.innerHTML = data
    .map((row) => {
      const date = new Date(row.created_at).toLocaleString();
      const user = row.user_name || "Unknown";
      return `<div class="msg-item"><span class="nes-text is-disabled">${date}</span> <span class="nes-text is-primary">${user}</span> ${row.message}</div>`;
    })
    .join("");
};

// get image width height
export const getImgMetaSync = (url) => {
  return new Promise((resolver, reject) => {
    const img = new Image();
    img.onload = () => resolver(img);
    img.onerror = (err) => reject(err);
    img.src = url;
  });
};
export const getMeta = (url, cb) => {
  const img = new Image();
  img.onload = () => cb(null, img);
  img.onerror = (err) => cb(err);
  img.src = url;
};

// supabase storage 디렉토리 목록 조회
export const getImageDirs = async (path) => {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(path, {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) {
    console.log("getImageDirs error:", error);
    return [];
  }
  // 폴더는 id가 null인 항목
  const dirs = data
    .filter((item) => item.id === null)
    .map((item) => {
      if (path === "" || path === "/") return item.name;
      return `${path}/${item.name}`;
    });
  return dirs;
};

// supabase storage 에 저장된 이미지 list
export const getImageList = async (path) => {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(path, {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) {
    console.log("getImageList error:", error);
    return [];
  }
  // 파일은 id가 null이 아닌 항목
  const files = data
    .filter((item) => item.id !== null)
    .map((item) => {
      if (path === "" || path === "/") return item.name;
      return `${path}/${item.name}`;
    });
  return files;
};

// supabase database(index 테이블) 문서 생성
export const setVisitDoc = async (docName) => {
  const { error } = await supabase.from("index").upsert({
    name: docName,
    visit_cnt: 1,
  });
  if (error) {
    console.log("setVisitDoc error:", error);
  }
};

// supabase database 방문카운트 조회 및 증가
// RPC(stored procedure) 를 사용해 원자적 증가 처리
export const getVisitCnt = async (docName, htmlId) => {
  // rpc 함수 increment_visit_cnt 호출 (supabase SQL editor 에서 생성 필요)
  const { data, error } = await supabase.rpc("increment_visit_cnt", {
    doc_name: docName,
  });
  if (error) {
    console.log("getVisitCnt error:", error);
    // rpc 실패시 직접 조회 시도
    const { data: row } = await supabase.from("index").select("visit_cnt").eq("name", docName).single();
    if (row) {
      document.getElementById(htmlId).innerHTML = `${row.visit_cnt}`;
    }
    return;
  }
  document.getElementById(htmlId).innerHTML = `${data}`;
};

const version = `last_version: ${__LAST_VERSION_TAG__}<br>last_commit_hash: ${__LAST_COMMIT_HASH__}<br>last_commit_date: ${__LAST_COMMIT_DATE__}<br>last_commit_message: ${__LAST_COMMIT_MESSAGE__}<br>`;
document.getElementById("version").innerHTML = version;

document.getElementById("btn_version").addEventListener("click", () => {
  const el = document.getElementById("version_info");
  el.style.display = el.style.display === "none" ? "" : "none";
});

async function loadImg(path) {
  const imgNames = await getImageList(path);
  // image div 태그를 구성해 이미지 순서를 보장
  await loadImages("images", imgNames);
}

const imgDirs = await getImageDirs("");
for (const dir of imgDirs) {
  const item = `<button class="nes-btn is-primary" id='load_${dir}'>${dir}</button>`;
  document.getElementById("load_img_buttons").insertAdjacentHTML("beforeend", item);
  document.getElementById(`load_${dir}`).addEventListener("click", () => {
    if (document.getElementById("images") != null) {
      document.getElementById("images").innerHTML = "";
    }
    loadImg(dir);
  });
}

getVisitCnt("ysoftman", "visitcnt");

if (imgDirs.length > 0) {
  loadImg(imgDirs[0]);
}
