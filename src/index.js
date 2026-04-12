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
let latestPool = [];
let loadedDir = "";

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
  latestPool = [];
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

  try {
    if (loadedDir === "__latest__" && latestPool.length > 0) {
      // 최신순 모드: 풀에서 다음 페이지 가져오기
      const next = latestPool.slice(currentOffset, currentOffset + IMG_PAGE_SIZE);
      currentOffset += next.length;
      allImagesLoaded = currentOffset >= latestPool.length;
      if (next.length > 0) {
        const imgNames = next.map((f) => f.name);
        const metaMap = buildMetaMap(next);
        await loadImages("images", imgNames, metaMap, true);
      }
    } else {
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
    }
  } finally {
    isLoadingMore = false;
    updateSentinel();
  }
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

const updateActiveDir = (dir) => {
  for (const d of imgDirs) {
    const btn = document.getElementById(`load_${d}`);
    if (!btn) continue;
    btn.className = d === dir ? "nes-btn is-success" : "nes-btn is-primary";
  }
  document.getElementById("btn_latest").className =
    dir === "__latest__" ? "nes-btn is-success" : "nes-btn is-primary";
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

// 최신 이미지 로드 (전체 카테고리 통합, 최신순)
const loadLatest = async () => {
  history.replaceState(null, "", window.location.pathname);
  updateActiveDir("__latest__");
  loadedDir = "__latest__";
  currentOffset = 0;

  const imagesEl = document.getElementById("images");
  imagesEl.innerHTML =
    '<div class="loading-indicator">' +
    '<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>' +
    " loading" +
    "</div>";

  // 모든 카테고리에서 이미지 목록을 가져와서 최신순 정렬
  const allFiles = [];
  for (const dir of imgDirs) {
    const files = await getImageList(dir, 0, 1000);
    allFiles.push(...files);
  }
  allFiles.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (allFiles.length === 0) {
    imagesEl.innerHTML = '<p class="empty-state">No images found</p>';
    allImagesLoaded = true;
    updateSentinel();
    return;
  }

  latestPool = allFiles;
  const first = latestPool.slice(0, IMG_PAGE_SIZE);
  currentOffset = first.length;
  allImagesLoaded = latestPool.length <= IMG_PAGE_SIZE;
  const imgNames = first.map((f) => f.name);
  const metaMap = buildMetaMap(first);

  await loadImages("images", imgNames, metaMap);
  updateSentinel();
};

document.getElementById("btn_latest").addEventListener("click", loadLatest);

const hashInfo = parseHash();
if (!loadDirFromHash(hashInfo, true)) {
  // 기본 홈은 최신 이미지 표시
  loadLatest();
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
  history.replaceState(null, "", window.location.pathname);
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

// 검색 기능 (파일명 + 메시지 내용)
const doSearch = async () => {
  const query = document.getElementById("search_input").value.trim();
  if (!query) return;

  history.replaceState(null, "", window.location.pathname);
  updateActiveDir("__search__");
  loadedDir = "__search__";
  allImagesLoaded = true;
  currentOffset = 0;

  const imagesEl = document.getElementById("images");
  imagesEl.innerHTML =
    '<div class="loading-indicator">' +
    '<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>' +
    " searching" +
    "</div>";

  // 파일명 검색
  const { data: fileMatches } = await supabase
    .from("image_info")
    .select("file_path")
    .ilike("file_path", `%${query}%`)
    .order("created_at", { ascending: false })
    .limit(50);

  // 메시지 내용 검색
  const { data: msgMatches } = await supabase
    .from("image_messages")
    .select("image_name")
    .ilike("message", `%${query}%`)
    .order("created_at", { ascending: false })
    .limit(50);

  // 결과 합치기 (중복 제거, 파일명 검색 우선)
  const seen = new Set();
  const imgNames = [];
  for (const row of fileMatches || []) {
    if (!seen.has(row.file_path)) {
      seen.add(row.file_path);
      imgNames.push(row.file_path);
    }
  }
  for (const row of msgMatches || []) {
    if (!seen.has(row.image_name)) {
      seen.add(row.image_name);
      imgNames.push(row.image_name);
    }
  }

  if (imgNames.length === 0) {
    imagesEl.innerHTML = `<p class="empty-state">No results for "${query}"</p>`;
    updateSentinel();
    return;
  }

  await loadImages("images", imgNames, {});
  updateSentinel();
};

document.getElementById("btn_search").addEventListener("click", doSearch);
document.getElementById("search_input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
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
