import "./common.js";
import "@fontsource/press-start-2p";
import "galmuri/dist/galmuri.css";
import "nes.css/css/nes.min.css";

import { supabase } from "./common.js";
import { loadImages } from "./image.js";
import { getImageDirs, getImageList, getViewCnt, setUploadDir, uploadDir, uploadFile } from "./storage.js";
import { showAlert } from "./utils.js";

const IMG_PAGE_SIZE = 2;
let currentDir = "";
let currentOffset = 0;
let isLoadingMore = false;
let allImagesLoaded = false;

const buildMetaMap = (files) => {
  const metaMap = {};
  for (const f of files) {
    metaMap[f.name] = { created_at: f.created_at, size: f.size };
  }
  return metaMap;
};

async function loadImg(path, scrollTarget) {
  currentDir = path;
  currentOffset = 0;
  allImagesLoaded = true;
  const imagesEl = document.getElementById("images");
  imagesEl.innerHTML =
    '<div class="loading-indicator">' +
    '<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>' +
    " loading" +
    "</div>";

  const imgFiles = await getImageList(path, 0, IMG_PAGE_SIZE + 1);
  const hasMore = imgFiles.length > IMG_PAGE_SIZE;
  const filesToLoad = hasMore ? imgFiles.slice(0, IMG_PAGE_SIZE) : imgFiles;
  allImagesLoaded = !hasMore;
  currentOffset = filesToLoad.length;

  const imgNames = filesToLoad.map((f) => f.name);
  const metaMap = buildMetaMap(filesToLoad);
  await loadImages("images", imgNames, metaMap);
  updateSentinel();
  if (scrollTarget) {
    const targetId = `${scrollTarget}_img`;
    const el = document.getElementById(targetId);
    if (el) {
      el.closest(".nes-container")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}

async function loadMoreImages() {
  if (isLoadingMore || allImagesLoaded) return;
  isLoadingMore = true;

  const imgFiles = await getImageList(currentDir, currentOffset, IMG_PAGE_SIZE + 1);
  const hasMore = imgFiles.length > IMG_PAGE_SIZE;
  const filesToLoad = hasMore ? imgFiles.slice(0, IMG_PAGE_SIZE) : imgFiles;
  allImagesLoaded = !hasMore;
  currentOffset += filesToLoad.length;

  if (filesToLoad.length > 0) {
    const imgNames = filesToLoad.map((f) => f.name);
    const metaMap = buildMetaMap(filesToLoad);
    await loadImages("images", imgNames, metaMap, true);
  }
  isLoadingMore = false;
  updateSentinel();
}

// 스크롤 감지용 sentinel
const sentinel = document.createElement("div");
sentinel.id = "scroll-sentinel";
document.getElementById("images").after(sentinel);

const updateSentinel = () => {
  if (allImagesLoaded) {
    sentinel.style.display = "none";
    sentinel.innerHTML = "";
  } else {
    sentinel.style.display = "";
    sentinel.innerHTML =
      '<div class="loading-indicator">' +
      '<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>' +
      " loading" +
      "</div>";
    // 이미지가 적어 sentinel이 이미 viewport 안에 있으면
    // IntersectionObserver가 재발화하지 않으므로 재등록하여 강제 평가
    scrollObserver.unobserve(sentinel);
    scrollObserver.observe(sentinel);
  }
};

const scrollObserver = new IntersectionObserver(
  (entries) => {
    if (entries[0].isIntersecting) loadMoreImages();
  },
  { rootMargin: "300px" },
);
scrollObserver.observe(sentinel);

// URL hash 에서 이미지 경로 파싱 (예: #dir/image.jpg → { dir: "dir", image: "dir/image.jpg" })
const parseHash = () => {
  const hash = decodeURIComponent(window.location.hash.slice(1));
  if (!hash) return null;
  const lastSlash = hash.indexOf("/");
  if (lastSlash === -1) return { dir: hash, image: null };
  const dir = hash.substring(0, lastSlash);
  return { dir, image: hash };
};

const version = `version: ${__LAST_VERSION_TAG__}<br>commit: ${__LAST_COMMIT_HASH__}<br>date: ${__LAST_COMMIT_DATE__}<br>message: ${__LAST_COMMIT_MESSAGE__}<br>`;
document.getElementById("version").innerHTML = version;

document.getElementById("btn_version").addEventListener("click", () => {
  const el = document.getElementById("version_info");
  el.style.display = el.style.display === "none" ? "" : "none";
});

const imgDirs = await getImageDirs("");
if (imgDirs.length === 0) {
  document.getElementById("images").innerHTML = '<p class="empty-state">No categories found</p>';
}
for (const dir of imgDirs) {
  const item = `<a class="nes-btn is-primary" id="load_${dir}" href="#${encodeURIComponent(dir)}">${dir}</a>`;
  document.getElementById("load_img_buttons").insertAdjacentHTML("beforeend", item);
}

getViewCnt("ysoftman", "viewcnt");

let loadedDir = "";

const updateActiveDir = (dir) => {
  for (const d of imgDirs) {
    const btn = document.getElementById(`load_${d}`);
    if (!btn) continue;
    btn.className = d === dir ? "nes-btn is-success" : "nes-btn is-primary";
  }
  const myLikesBtn = document.getElementById("btn_my_likes");
  if (!myLikesBtn.disabled) {
    myLikesBtn.className = dir === "__my_likes__" ? "nes-btn is-success" : "nes-btn is-error";
  }
};

const loadDirFromHash = (info, force = false) => {
  if (!info || !imgDirs.includes(info.dir)) return false;
  if (info.image) {
    const targetId = `${info.image}_img`;
    const el = document.getElementById(targetId);
    if (el) {
      el.closest(".nes-container")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    }
  }
  if (info.dir !== loadedDir || force) {
    loadedDir = info.dir;
    updateActiveDir(info.dir);
    loadImg(info.dir, info.image);
  }
  return true;
};

const hashInfo = parseHash();
if (!loadDirFromHash(hashInfo, true)) {
  if (imgDirs.length > 0) {
    loadedDir = imgDirs[0];
    updateActiveDir(imgDirs[0]);
    loadImg(imgDirs[0]);
  }
}

// hash 변경 시 카테고리 또는 이미지로 이동
window.addEventListener("hashchange", () => {
  loadDirFromHash(parseHash());
});

// 업로드 버튼 (로그인 사용자만 표시)
const {
  data: { user: currentUploadUser },
} = await supabase.auth.getUser();
if (currentUploadUser) {
  const uploadBtn = document.getElementById("btn_upload");
  uploadBtn.disabled = false;
  uploadBtn.className = "nes-btn is-warning";
}
// 구글 로그인 사용자만 "my likes" 버튼 활성화
if (currentUploadUser && !currentUploadUser.is_anonymous) {
  const myLikesBtn = document.getElementById("btn_my_likes");
  myLikesBtn.disabled = false;
  myLikesBtn.className = "nes-btn is-error";
}

document.getElementById("btn_my_likes").addEventListener("click", async () => {
  updateActiveDir("__my_likes__");
  loadedDir = "__my_likes__";
  allImagesLoaded = true;
  currentOffset = 0;

  const imagesEl = document.getElementById("images");
  imagesEl.innerHTML =
    '<div class="loading-indicator">' +
    '<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>' +
    " loading" +
    "</div>";

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: likes } = await supabase
    .from("image_likes")
    .select("image_name")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (!likes || likes.length === 0) {
    imagesEl.innerHTML = '<p class="empty-state">No liked images</p>';
    updateSentinel();
    return;
  }

  const imgNames = likes.map((l) => l.image_name);
  await loadImages("images", imgNames, {});
  updateSentinel();
});

// 업로드 카테고리 선택 팝업
const showUploadDirPicker = (dirs) => {
  const existing = document.getElementById("upload-dir-picker");
  if (existing) existing.remove();

  const picker = document.createElement("div");
  picker.id = "upload-dir-picker";
  picker.className = "upload-dir-picker";
  picker.innerHTML =
    '<div class="upload-dir-picker-inner nes-container is-dark">' +
    "<p>upload category</p>" +
    dirs
      .map(
        (dir) =>
          `<button class="nes-btn ${dir === currentDir ? "is-success" : "is-primary"} upload-dir-btn" data-dir="${dir}">${dir}</button>`,
      )
      .join(" ") +
    '<br><br><div class="new-dir-row">' +
    '<input class="nes-input is-dark new-dir-input" type="text" placeholder="new category" maxlength="50">' +
    '<button class="nes-btn is-warning new-dir-btn">create</button>' +
    "</div>" +
    '<br><button class="nes-btn is-error upload-dir-cancel">cancel</button>' +
    "</div>";
  document.body.appendChild(picker);

  picker.querySelector(".upload-dir-cancel").addEventListener("click", () => picker.remove());
  picker.addEventListener("click", (e) => {
    if (e.target === picker) picker.remove();
  });
  picker.addEventListener("keydown", (e) => {
    if (e.key === "Escape") picker.remove();
  });
  // 기존 카테고리 선택
  for (const btn of picker.querySelectorAll(".upload-dir-btn")) {
    btn.addEventListener("click", () => {
      setUploadDir(btn.dataset.dir);
      picker.remove();
      document.getElementById("file_input").click();
    });
  }
  // 새 카테고리 생성 후 업로드
  const newDirInput = picker.querySelector(".new-dir-input");
  picker.querySelector(".new-dir-btn").addEventListener("click", async () => {
    const newDir = newDirInput.value.trim();
    if (!newDir) return;
    if (!/^[a-zA-Z0-9_-]+$/.test(newDir)) {
      await showAlert("Category name must contain only alphanumeric characters, hyphens, and underscores");
      return;
    }
    setUploadDir(newDir);
    if (!imgDirs.includes(newDir)) {
      imgDirs.push(newDir);
      const item = `<a class="nes-btn is-primary" id="load_${newDir}" href="#${encodeURIComponent(newDir)}">${newDir}</a>`;
      document.getElementById("load_img_buttons").insertAdjacentHTML("beforeend", item);
    }
    picker.remove();
    document.getElementById("file_input").click();
  });
  newDirInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") picker.querySelector(".new-dir-btn").click();
  });
};

document.getElementById("btn_upload").addEventListener("click", () => {
  showUploadDirPicker(imgDirs);
});

document.getElementById("file_input").addEventListener("change", async (e) => {
  const files = e.target.files;
  if (!files || files.length === 0) return;
  const uploadBtn = document.getElementById("btn_upload");
  const originalText = uploadBtn.textContent;
  let uploaded = 0;
  for (let i = 0; i < files.length; i++) {
    uploadBtn.textContent = `uploading ${i + 1}/${files.length}`;
    uploadBtn.disabled = true;
    const success = await uploadFile(files[i]);
    if (success) uploaded++;
  }
  uploadBtn.textContent = originalText;
  uploadBtn.disabled = false;
  if (uploaded > 0) {
    await loadImg(uploadDir || currentDir);
  }
  e.target.value = "";
});
