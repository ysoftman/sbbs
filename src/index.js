import "./common.js";
import "nes.css/css/nes.min.css";
import "@phosphor-icons/web/fill";
import "./common.css";

import { getCurrentUser, supabase } from "./common.js";
import { loadImages, showOverlayByName } from "./image.js";
import { getImageDirs, getImageList, getViewCnt, setUploadDir, uploadDir, uploadFile } from "./storage.js";
import { escapeHtml, formatCount, loadingIndicatorHtml, showAlert, toSafeId } from "./utils.js";

const LIST_PAGE_SIZE = 2;
const GRID_PAGE_SIZE = 12;
let viewMode = localStorage.getItem("sbbs-view-mode") || "list";
const getPageSize = () => (viewMode === "grid" ? GRID_PAGE_SIZE : LIST_PAGE_SIZE);

let currentDir = "";
let currentOffset = 0;
let isLoadingMore = false;
let allImagesLoaded = false;
let latestPool = [];
let loadedDir = "";
// loadImg/loadLatest 가 호출될 때마다 증가. 진행 중인 loadMoreImages 가 stale 인지 식별한다.
let loadGeneration = 0;

const buildMetaMap = (files) => {
  const metaMap = {};
  for (const f of files) {
    metaMap[f.name] = { created_at: f.created_at, size: f.size };
  }
  return metaMap;
};

async function loadImg(path) {
  loadGeneration++;
  const gen = loadGeneration;
  currentDir = path;
  currentOffset = 0;
  // 로딩 중 loadMoreImages 가 발화하지 않도록 true
  allImagesLoaded = true;
  latestPool = [];
  const imagesEl = document.getElementById("images");
  imagesEl.innerHTML = "";
  // sentinel 을 로딩 인디케이터로 사용 (중앙 정렬, 단일 표시)
  showSentinelLoading();

  const pageSize = getPageSize();
  const imgFiles = await getImageList(path, 0, pageSize + 1);
  // 그 사이에 다른 화면 전환이 일어났다면 결과 폐기
  if (gen !== loadGeneration) return;
  const hasMore = imgFiles.length > pageSize;
  const filesToLoad = hasMore ? imgFiles.slice(0, pageSize) : imgFiles;
  allImagesLoaded = !hasMore;
  currentOffset = filesToLoad.length;

  const imgNames = filesToLoad.map((f) => f.name);
  const metaMap = buildMetaMap(filesToLoad);
  await loadImages("images", imgNames, metaMap, false, viewMode);
  if (gen !== loadGeneration) return;
  updateSentinel();
}

async function loadMoreImages() {
  if (isLoadingMore || allImagesLoaded) return;
  isLoadingMore = true;
  const gen = loadGeneration;

  try {
    const pageSize = getPageSize();
    if (loadedDir === "__latest__" && latestPool.length > 0) {
      // 최신순 모드: 풀에서 다음 페이지 가져오기
      const next = latestPool.slice(currentOffset, currentOffset + pageSize);
      currentOffset += next.length;
      allImagesLoaded = currentOffset >= latestPool.length;
      if (next.length > 0) {
        const imgNames = next.map((f) => f.name);
        const metaMap = buildMetaMap(next);
        if (gen !== loadGeneration) return;
        await loadImages("images", imgNames, metaMap, true, viewMode);
        if (gen !== loadGeneration) return;
      }
    } else {
      const imgFiles = await getImageList(currentDir, currentOffset, pageSize + 1);
      // fetch 사이에 화면 전환됐으면 폐기 (이전 카테고리 결과를 새 화면에 append 하는 것 방지)
      if (gen !== loadGeneration) return;
      const hasMore = imgFiles.length > pageSize;
      const filesToLoad = hasMore ? imgFiles.slice(0, pageSize) : imgFiles;
      allImagesLoaded = !hasMore;
      currentOffset += filesToLoad.length;

      if (filesToLoad.length > 0) {
        const imgNames = filesToLoad.map((f) => f.name);
        const metaMap = buildMetaMap(filesToLoad);
        await loadImages("images", imgNames, metaMap, true, viewMode);
        if (gen !== loadGeneration) return;
      }
    }
  } finally {
    isLoadingMore = false;
    if (gen === loadGeneration) updateSentinel();
  }
}

// 스크롤 감지용 sentinel
const sentinel = document.createElement("div");
sentinel.id = "scroll-sentinel";
document.getElementById("images").after(sentinel);

const sentinelLoadingHtml = loadingIndicatorHtml();

// 화면 전환 시 즉시 sentinel 에 중앙 정렬된 로딩 인디케이터 표시 (#images 는 비움)
const showSentinelLoading = () => {
  sentinel.style.display = "";
  sentinel.innerHTML = sentinelLoadingHtml;
};

const updateSentinel = () => {
  if (allImagesLoaded) {
    sentinel.style.display = "none";
    sentinel.innerHTML = "";
  } else {
    sentinel.style.display = "";
    sentinel.innerHTML = sentinelLoadingHtml;
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
  let hash = "";
  try {
    hash = decodeURIComponent(window.location.hash.slice(1));
  } catch (err) {
    console.warn("invalid hash:", err);
    return null;
  }
  if (!hash) return null;
  const lastSlash = hash.indexOf("/");
  if (lastSlash === -1) return { dir: hash, image: null };
  const dir = hash.substring(0, lastSlash);
  return { dir, image: hash };
};

const version = `version: ${escapeHtml(__LAST_VERSION_TAG__)}<br>commit: ${escapeHtml(__LAST_COMMIT_HASH__)}<br>date: ${escapeHtml(__LAST_COMMIT_DATE__)}<br>message: ${escapeHtml(__LAST_COMMIT_MESSAGE__)}<br>`;
document.getElementById("version").innerHTML = version;

document.getElementById("btn_version").addEventListener("click", () => {
  const el = document.getElementById("version_info");
  el.style.display = el.style.display === "none" ? "" : "none";
});

// 다크/라이트 테마 토글
const themeBtn = document.getElementById("btn_theme");
const applyTheme = (light) => {
  document.documentElement.classList.toggle("light", light);
  const icon = document.getElementById("theme_icon");
  icon.className = light ? "ph-fill ph-moon" : "ph-fill ph-sun";
  localStorage.setItem("sbbs-theme", light ? "light" : "dark");
};
applyTheme(localStorage.getItem("sbbs-theme") === "light");
themeBtn.addEventListener("click", () => {
  applyTheme(!document.documentElement.classList.contains("light"));
});

// 그리드/리스트 뷰 토글
const applyViewMode = (mode) => {
  viewMode = mode;
  document.getElementById("images").classList.toggle("grid-mode", mode === "grid");
  const icon = document.getElementById("view_toggle_icon");
  icon.className = mode === "grid" ? "ph-fill ph-list" : "ph-fill ph-grid-four";
  localStorage.setItem("sbbs-view-mode", mode);
};
applyViewMode(viewMode);

const reloadCurrentView = () => {
  if (loadedDir === "__latest__") {
    loadLatest();
  } else if (loadedDir === "__my_likes__") {
    document.getElementById("btn_my_likes").click();
  } else if (loadedDir === "__search__") {
    doSearch();
  } else {
    loadDirFromHash(parseHash(), true);
  }
};

document.getElementById("btn_view_toggle").addEventListener("click", () => {
  applyViewMode(viewMode === "list" ? "grid" : "list");
  reloadCurrentView();
});

const imgDirs = await getImageDirs("");
if (imgDirs.length === 0) {
  document.getElementById("images").innerHTML = '<p class="empty-state">No categories found</p>';
}

getViewCnt("ysoftman", "viewcnt");

// 전체 이미지 수 표시
supabase
  .from("image_info")
  .select("id", { count: "exact", head: true })
  .then(({ count }) => {
    document.getElementById("imgcnt").textContent = formatCount(count);
  });

// 카테고리 버튼 렌더링: 항상 전체 표시, 드래그로 순서 조정 (localStorage 저장)
const CAT_ORDER_KEY = "sbbs-cat-order";

const applySavedOrder = () => {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(CAT_ORDER_KEY)) || [];
  } catch {
    saved = [];
  }
  imgDirs.sort((a, b) => {
    const ia = saved.indexOf(a);
    const ib = saved.indexOf(b);
    return (ia === -1 ? saved.length : ia) - (ib === -1 ? saved.length : ib);
  });
};

const renderCategoryButtons = () => {
  applySavedOrder();
  const container = document.getElementById("load_img_buttons");
  container.innerHTML = "";
  for (const dir of imgDirs) {
    const safeDir = escapeHtml(dir);
    const item = `<a class="nes-btn is-primary" draggable="true" data-dir="${safeDir}" id="load_${toSafeId(dir)}" href="#${encodeURIComponent(dir)}">${safeDir}</a>`;
    container.insertAdjacentHTML("beforeend", item);
  }
};

{
  const container = document.getElementById("load_img_buttons");
  let dragged = null;
  container.addEventListener("dragstart", (e) => {
    dragged = e.target.closest("a[data-dir]");
    if (dragged) e.dataTransfer.effectAllowed = "move";
  });
  container.addEventListener("dragover", (e) => {
    const over = e.target.closest("a[data-dir]");
    if (!dragged || !over || over === dragged) return;
    e.preventDefault();
    const rect = over.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    container.insertBefore(dragged, before ? over : over.nextSibling);
  });
  container.addEventListener("dragend", () => {
    if (!dragged) return;
    dragged = null;
    const order = [...container.querySelectorAll("a[data-dir]")].map((a) => a.dataset.dir);
    localStorage.setItem(CAT_ORDER_KEY, JSON.stringify(order));
    applySavedOrder();
  });
}

renderCategoryButtons();

const updateActiveDir = (dir) => {
  for (const d of imgDirs) {
    const btn = document.getElementById(`load_${toSafeId(d)}`);
    if (!btn) continue;
    btn.className = d === dir ? "nes-btn is-success" : "nes-btn is-primary";
  }
  document.getElementById("btn_latest").className = dir === "__latest__" ? "nes-btn is-success" : "nes-btn is-primary";
  const myLikesBtn = document.getElementById("btn_my_likes");
  if (!myLikesBtn.classList.contains("needs-google")) {
    myLikesBtn.className = dir === "__my_likes__" ? "nes-btn is-success" : "nes-btn is-error";
  }
};

const loadDirFromHash = (info, force = false) => {
  if (!info || !imgDirs.includes(info.dir)) return false;
  if (info.dir !== loadedDir || force) {
    loadedDir = info.dir;
    updateActiveDir(info.dir);
    loadImg(info.dir);
  }
  // 딥링크 대상은 목록 어디에 있든(페이지네이션 밖이어도) 바로 오버레이로 보여준다
  if (info.image) showOverlayByName(info.image);
  return true;
};

// 최신 이미지 로드 (전체 카테고리 통합, 최신순)
const loadLatest = async () => {
  loadGeneration++;
  const gen = loadGeneration;
  history.replaceState(null, "", window.location.pathname);
  updateActiveDir("__latest__");
  loadedDir = "__latest__";
  currentOffset = 0;
  latestPool = [];
  // 로딩 중 loadMoreImages 가 발화하지 않도록 true
  allImagesLoaded = true;

  const imagesEl = document.getElementById("images");
  imagesEl.innerHTML = "";
  // sentinel 을 로딩 인디케이터로 사용 (중앙 정렬, 단일 표시)
  showSentinelLoading();

  // 모든 카테고리에서 이미지 목록을 가져와서 최신순 정렬
  const allFiles = [];
  for (const dir of imgDirs) {
    const files = await getImageList(dir, 0, 1000);
    if (gen !== loadGeneration) return;
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
  const pageSize = getPageSize();
  const first = latestPool.slice(0, pageSize);
  currentOffset = first.length;
  allImagesLoaded = latestPool.length <= pageSize;
  const imgNames = first.map((f) => f.name);
  const metaMap = buildMetaMap(first);

  await loadImages("images", imgNames, metaMap, false, viewMode);
  if (gen !== loadGeneration) return;
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

const currentUploadUser = await getCurrentUser();
// 비활성 버튼 클릭 시 로그인 안내 팝업
document.getElementById("img_buttons_row").addEventListener("click", (e) => {
  const btn = e.target.closest(".needs-google");
  if (btn) showAlert("Google login required");
});

// 구글 로그인 사용자: upload + my likes
if (currentUploadUser && !currentUploadUser.is_anonymous) {
  const uploadBtn = document.getElementById("btn_upload");
  uploadBtn.classList.remove("is-disabled", "needs-google");
  uploadBtn.classList.add("is-warning");

  const myLikesBtn = document.getElementById("btn_my_likes");
  myLikesBtn.classList.remove("is-disabled", "needs-google");
  myLikesBtn.classList.add("is-error");
}

document.getElementById("btn_my_likes").addEventListener("click", async () => {
  if (document.getElementById("btn_my_likes").classList.contains("needs-google")) return;
  loadGeneration++;
  const gen = loadGeneration;
  history.replaceState(null, "", window.location.pathname);
  updateActiveDir("__my_likes__");
  loadedDir = "__my_likes__";
  allImagesLoaded = true;
  currentOffset = 0;

  const imagesEl = document.getElementById("images");
  imagesEl.innerHTML = loadingIndicatorHtml();

  const user = await getCurrentUser();
  if (!user) {
    imagesEl.innerHTML = "";
    return;
  }
  const { data: likes } = await supabase
    .from("image_likes")
    .select("image_name")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (gen !== loadGeneration) return;

  if (!likes || likes.length === 0) {
    imagesEl.innerHTML = '<p class="empty-state">No liked images</p>';
    updateSentinel();
    return;
  }

  const imgNames = likes.map((l) => l.image_name);
  if (gen !== loadGeneration) return;
  await loadImages("images", imgNames, {}, false, viewMode);
  if (gen !== loadGeneration) return;
  updateSentinel();
});

// 검색 기능 (파일명 + 메시지 내용)
const doSearch = async () => {
  const query = document.getElementById("search_input").value.trim();
  if (!query) return;
  loadGeneration++;
  const gen = loadGeneration;

  history.replaceState(null, "", window.location.pathname);
  updateActiveDir("__search__");
  loadedDir = "__search__";
  allImagesLoaded = true;
  currentOffset = 0;

  const imagesEl = document.getElementById("images");
  imagesEl.innerHTML = loadingIndicatorHtml("searching");

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
  if (gen !== loadGeneration) return;

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
    imagesEl.innerHTML = `<p class="empty-state">No results for "${escapeHtml(query)}"</p>`;
    updateSentinel();
    return;
  }

  if (gen !== loadGeneration) return;
  await loadImages("images", imgNames, {}, false, viewMode);
  if (gen !== loadGeneration) return;
  updateSentinel();
};

document.getElementById("btn_search").addEventListener("click", doSearch);
document.getElementById("search_input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});

// 업로드 카테고리 선택 팝업
const showUploadDirPicker = () => {
  const existing = document.getElementById("upload-dir-picker");
  if (existing) existing.remove();

  const picker = document.createElement("div");
  picker.id = "upload-dir-picker";
  picker.className = "upload-dir-picker";
  const dirsHtml =
    imgDirs.length > 0
      ? imgDirs
          .map(
            (dir) =>
              `<button class="nes-btn is-primary upload-dir-btn" data-dir="${escapeHtml(dir)}">${escapeHtml(dir)}</button>`,
          )
          .join(" ")
      : '<span class="nes-text is-disabled">no categories</span>';

  picker.innerHTML =
    '<div class="upload-dir-picker-inner nes-container is-dark">' +
    "<p>upload category</p>" +
    `<div class="move-dir-list">${dirsHtml}</div>` +
    '<br><button class="nes-btn is-error upload-dir-cancel">cancel</button>' +
    "</div>";
  document.body.appendChild(picker);
  picker.tabIndex = -1;
  picker.focus();

  picker.querySelector(".upload-dir-cancel").addEventListener("click", () => picker.remove());
  picker.addEventListener("click", (e) => {
    if (e.target === picker) picker.remove();
  });
  picker.addEventListener("keydown", (e) => {
    if (e.key === "Escape") picker.remove();
  });
  // 카테고리 선택 후 파일 선택창 열기
  for (const btn of picker.querySelectorAll(".upload-dir-btn")) {
    btn.addEventListener("click", () => {
      setUploadDir(btn.dataset.dir);
      picker.remove();
      document.getElementById("file_input").click();
    });
  }
};

document.getElementById("btn_upload").addEventListener("click", (e) => {
  if (e.currentTarget.classList.contains("needs-google")) return;
  showUploadDirPicker();
});

// 키보드 단축키
const SHORTCUTS_HELP = [
  ["j", "next image"],
  ["k", "previous image"],
  ["g", "scroll to top"],
  ["G", "scroll to bottom"],
  ["l", "toggle like (nearest image)"],
  ["/", "focus search"],
  ["v", "toggle grid/list view"],
  ["t", "toggle theme"],
  ["?", "show this help"],
  ["Esc", "close dialog/overlay"],
];

const showShortcutsHelp = () => {
  const existing = document.getElementById("shortcuts-help");
  if (existing) {
    existing.remove();
    return;
  }
  const overlay = document.createElement("div");
  overlay.id = "shortcuts-help";
  overlay.className = "dialog-overlay";
  const rows = SHORTCUTS_HELP.map(
    ([k, desc]) => `<div class="sc-row"><kbd class="sc-key">${k}</kbd><span class="sc-desc">${desc}</span></div>`,
  ).join("");
  overlay.innerHTML =
    '<div class="dialog-inner nes-container is-dark">' +
    "<p>keyboard shortcuts</p>" +
    `<div class="sc-list">${rows}</div>` +
    '<div class="dialog-buttons"><button class="nes-btn is-primary sc-close">close</button></div>' +
    "</div>";
  document.body.appendChild(overlay);
  overlay.tabIndex = -1;
  overlay.focus();
  const close = () => overlay.remove();
  overlay.querySelector(".sc-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
};

// viewport 중앙에 가장 가까운 이미지 컨테이너
const getItemSelector = () => (viewMode === "grid" ? "#images .grid-card" : "#images .nes-container");

const findNearestContainer = () => {
  const containers = document.querySelectorAll(getItemSelector());
  if (containers.length === 0) return null;
  const viewportCenter = window.innerHeight / 2;
  let best = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of containers) {
    const rect = c.getBoundingClientRect();
    const dist = Math.abs(rect.top + rect.height / 2 - viewportCenter);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
};

const scrollToContainer = (el) => {
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
};

const scrollToSibling = (direction) => {
  const containers = Array.from(document.querySelectorAll(getItemSelector()));
  if (containers.length === 0) return;
  const current = findNearestContainer();
  const idx = containers.indexOf(current);
  const nextIdx = Math.max(0, Math.min(containers.length - 1, idx + direction));
  scrollToContainer(containers[nextIdx]);
};

const isTypingInField = () => {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
};

const hasOpenOverlay = () => document.querySelector(".img-overlay, .dialog-overlay, .upload-dir-picker") !== null;

document.getElementById("btn_help")?.addEventListener("click", showShortcutsHelp);

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingInField()) return;
  // overlay 가 열려 있으면 overlay 자체 keydown 에 맡김 (Esc 등)
  if (hasOpenOverlay()) return;

  switch (e.key) {
    case "j":
      e.preventDefault();
      scrollToSibling(1);
      break;
    case "k":
      e.preventDefault();
      scrollToSibling(-1);
      break;
    case "g":
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: "smooth" });
      break;
    case "G":
      e.preventDefault();
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
      break;
    case "l": {
      e.preventDefault();
      const c = findNearestContainer();
      const heart = c?.querySelector(".like-heart.clickable");
      if (heart) heart.click();
      break;
    }
    case "/":
      e.preventDefault();
      document.getElementById("search_input")?.focus();
      break;
    case "v":
      e.preventDefault();
      document.getElementById("btn_view_toggle")?.click();
      break;
    case "t":
      e.preventDefault();
      document.getElementById("btn_theme")?.click();
      break;
    case "?":
      e.preventDefault();
      showShortcutsHelp();
      break;
  }
});

// scroll to top 버튼: 일정 스크롤 이상일 때만 표시
const scrollTopBtn = document.getElementById("btn_scroll_top");
if (scrollTopBtn) {
  scrollTopBtn.hidden = false;
  const SCROLL_THRESHOLD = 400;
  const updateScrollTopBtn = () => {
    if (window.scrollY > SCROLL_THRESHOLD) {
      scrollTopBtn.classList.add("is-visible");
    } else {
      scrollTopBtn.classList.remove("is-visible");
    }
  };
  window.addEventListener("scroll", updateScrollTopBtn, { passive: true });
  scrollTopBtn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  updateScrollTopBtn();
}

document.getElementById("file_input").addEventListener("change", async (e) => {
  const files = e.target.files;
  if (!files || files.length === 0) return;
  const uploadBtn = document.getElementById("btn_upload");
  const originalText = uploadBtn.textContent;
  let uploaded = 0;
  uploadBtn.disabled = true;
  try {
    for (let i = 0; i < files.length; i++) {
      uploadBtn.textContent = `uploading ${i + 1}/${files.length}`;
      let success = false;
      try {
        success = await uploadFile(files[i]);
      } catch (err) {
        console.warn("uploadFile error:", err);
        await showAlert(`Upload error: ${err.message || err}`);
      }
      if (success) uploaded++;
    }
    if (uploaded > 0) {
      await loadImg(uploadDir || currentDir);
    }
  } finally {
    uploadBtn.textContent = originalText;
    uploadBtn.disabled = false;
    e.target.value = "";
  }
});
