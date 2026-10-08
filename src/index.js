import "./common.js";
import "@phosphor-icons/web/fill";
import "./common.css";

import { getCurrentUser, isAdmin, supabase } from "./common.js";
import { loadImages, showOverlayByName } from "./image.js";
import { createDir, getImageDirs, getImageList, getViewCnt, setUploadDir, uploadDir, uploadFile } from "./storage.js";
import {
  emptyStateHtml,
  escapeHtml,
  formatCount,
  loadingIndicatorHtml,
  openDialog,
  showAlert,
  showDirPicker,
  skeletonHtml,
  toSafeId,
} from "./utils.js";

const LIST_PAGE_SIZE = 2;
const GRID_PAGE_SIZE = 12;
let viewMode = localStorage.getItem("sbbs-view-mode") || "list";
const getPageSize = () => (viewMode === "grid" ? GRID_PAGE_SIZE : LIST_PAGE_SIZE);

let currentDir = "";
let currentOffset = 0;
let allImagesLoaded = false;
// latest / my likes / 검색처럼 전체 목록을 먼저 받는 화면의 목록. 카테고리 화면은 storage 페이지네이션을 쓰므로 비어 있다.
let imagePool = [];
let loadedDir = "";
// loadImg/loadLatest 가 호출될 때마다 증가. 진행 중인 loadMoreImages 가 stale 인지 식별한다.
let loadGeneration = 0;
const staleChecker = (gen) => () => gen !== loadGeneration;
// 추가 로드 중인 generation. stale 요청이 새 화면의 추가 로드를 막지 않도록 generation 단위로 잠근다.
let loadingMoreGen = -1;

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
  imagePool = [];
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

  if (filesToLoad.length === 0) {
    imagesEl.innerHTML = emptyStateHtml("image", "Nothing here yet", "Upload an image to start this category.");
    updateSentinel();
    return;
  }

  const imgNames = filesToLoad.map((f) => f.name);
  const metaMap = buildMetaMap(filesToLoad);
  await loadImages("images", imgNames, metaMap, false, viewMode, staleChecker(gen));
  if (gen !== loadGeneration) return;
  updateSentinel();
}

async function loadMoreImages() {
  if (loadingMoreGen === loadGeneration || allImagesLoaded) return;
  const gen = loadGeneration;
  loadingMoreGen = gen;

  try {
    const pageSize = getPageSize();
    if (imagePool.length > 0) {
      // 풀 모드: 풀에서 다음 페이지 가져오기
      const next = imagePool.slice(currentOffset, currentOffset + pageSize);
      currentOffset += next.length;
      allImagesLoaded = currentOffset >= imagePool.length;
      if (next.length > 0) {
        const imgNames = next.map((f) => f.name);
        const metaMap = buildMetaMap(next);
        if (gen !== loadGeneration) return;
        await loadImages("images", imgNames, metaMap, true, viewMode, staleChecker(gen));
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
        await loadImages("images", imgNames, metaMap, true, viewMode, staleChecker(gen));
        if (gen !== loadGeneration) return;
      }
    }
  } finally {
    if (loadingMoreGen === gen) loadingMoreGen = -1;
    if (gen === loadGeneration) updateSentinel();
  }
}

// 스크롤 감지용 sentinel
const sentinel = document.createElement("div");
sentinel.id = "scroll-sentinel";
document.getElementById("images").after(sentinel);

// 검색 결과 바: 검색 화면에서만 목록 위에 결과 수, 검색어, 지우기 버튼을 보여준다 (표시 여부는 updateActiveDir 가 정한다)
const searchBar = document.createElement("div");
searchBar.className = "search-bar";
searchBar.hidden = true;
searchBar.innerHTML =
  '<span class="search-bar-text" role="status"></span>' +
  '<button type="button" class="btn search-bar-clear" title="clear search" aria-label="clear search"><i class="ph-fill ph-x-circle"></i></button>';
document.getElementById("images").before(searchBar);
const searchBarText = searchBar.querySelector(".search-bar-text");
searchBar.querySelector(".search-bar-clear").addEventListener("click", () => {
  document.getElementById("search_input").value = "";
  loadLatest();
  // 누른 버튼이 사라지므로 포커스를 latest 탭으로 옮긴다
  document.getElementById("btn_latest").focus({ preventScroll: true });
});

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
  document.getElementById("images").innerHTML = emptyStateHtml(
    "folder-open",
    "No categories yet",
    "Upload an image to create the first one.",
  );
}

getViewCnt("ysoftman", "viewcnt");

// 전체 이미지 수 표시
const refreshImageCount = () =>
  supabase
    .from("image_info")
    .select("id", { count: "exact", head: true })
    .then(({ count }) => {
      document.getElementById("imgcnt").textContent = formatCount(count);
    });
refreshImageCount();

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
    const item = `<a class="btn btn-primary" draggable="true" data-dir="${safeDir}" id="load_${toSafeId(dir)}" href="#${encodeURIComponent(dir)}">${safeDir}</a>`;
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

// 탭 줄(.cat-tabs)은 한 줄 가로 스크롤이라 선택된 탭이 화면 밖에 있을 수 있다.
// scrollIntoView 는 페이지 세로 스크롤까지 움직일 수 있어 탭 줄의 가로 스크롤만 직접 맞춘다.
// 가장자리 페이드에 가리지 않도록 탭 줄의 scroll-padding 안쪽까지 들인다.
const revealTab = (tab) => {
  const tabs = tab.closest(".cat-tabs");
  if (!tabs) return;
  const style = getComputedStyle(tabs);
  const tabsRect = tabs.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  const left = tabsRect.left + (Number.parseFloat(style.scrollPaddingLeft) || 0);
  const right = tabsRect.right - (Number.parseFloat(style.scrollPaddingRight) || 0);
  // scrollLeft 는 정수 px 로 맞춰지므로 소수점 이동은 바깥쪽으로 올려 탭이 경계에 걸치지 않게 한다
  let delta = 0;
  if (tabRect.left < left) delta = Math.floor(tabRect.left - left);
  else if (tabRect.right > right) delta = Math.ceil(tabRect.right - right);
  if (delta === 0) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  tabs.scrollBy({ left: delta, behavior: reduceMotion ? "auto" : "smooth" });
};

const revealActiveTab = () => {
  const activeTab = document.querySelector("#img_buttons_row .btn-active");
  if (activeTab) revealTab(activeTab);
};

// 탭 줄 폭이 바뀌면(admin 의 category 버튼이 늦게 나타나 줄이 좁아짐, 창 크기 변경) 활성 탭이 다시 가려지므로 다시 맞춘다.
// 아이콘 폰트가 늦게 로드되면 줄 폭은 그대로인 채 탭 위치만 밀리므로 폰트 로드 뒤에도 한 번 맞춘다.
// 크기 변화가 없으면 호출되지 않으므로 사용자가 직접 스크롤한 위치는 건드리지 않는다.
new ResizeObserver(revealActiveTab).observe(document.querySelector(".cat-tabs"));
document.fonts?.ready.then(revealActiveTab);

const updateActiveDir = (dir) => {
  for (const d of imgDirs) {
    const btn = document.getElementById(`load_${toSafeId(d)}`);
    if (!btn) continue;
    btn.className = d === dir ? "btn btn-active" : "btn btn-primary";
  }
  document.getElementById("btn_latest").className = dir === "__latest__" ? "btn btn-active" : "btn btn-primary";
  const myLikesBtn = document.getElementById("btn_my_likes");
  if (!myLikesBtn.classList.contains("needs-google")) {
    myLikesBtn.className = dir === "__my_likes__" ? "btn btn-active" : "btn btn-primary";
  }
  revealActiveTab();
  // 검색 결과 바는 검색 화면에서만. 다른 화면으로 가면 바로 숨긴다
  searchBar.hidden = dir !== "__search__";
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

// 전체 목록(pool)의 첫 페이지를 그린다. 나머지는 loadMoreImages 가 pool 에서 페이지 단위로 꺼낸다.
// pool 항목은 { name, created_at?, size? } (my likes / 검색은 name 만 있다)
const loadPool = async (gen, pool) => {
  imagePool = pool;
  const first = pool.slice(0, getPageSize());
  currentOffset = first.length;
  allImagesLoaded = currentOffset >= pool.length;
  const imgNames = first.map((f) => f.name);
  await loadImages("images", imgNames, buildMetaMap(first), false, viewMode, staleChecker(gen));
  if (gen !== loadGeneration) return;
  updateSentinel();
};

// 최신 이미지 로드 (전체 카테고리 통합, 최신순)
const loadLatest = async () => {
  loadGeneration++;
  const gen = loadGeneration;
  history.replaceState(null, "", window.location.pathname);
  updateActiveDir("__latest__");
  loadedDir = "__latest__";
  currentOffset = 0;
  imagePool = [];
  // 로딩 중 loadMoreImages 가 발화하지 않도록 true
  allImagesLoaded = true;

  const imagesEl = document.getElementById("images");
  imagesEl.innerHTML = "";
  // sentinel 을 로딩 인디케이터로 사용 (중앙 정렬, 단일 표시)
  showSentinelLoading();

  // 모든 카테고리에서 이미지 목록을 동시에 가져와서 최신순 정렬 (카테고리당 최대 1000개)
  const allFiles = (await Promise.all(imgDirs.map((dir) => getImageList(dir, 0, 1000)))).flat();
  if (gen !== loadGeneration) return;
  allFiles.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (allFiles.length === 0) {
    imagesEl.innerHTML = emptyStateHtml("image", "Nothing here yet", "Upload an image to get started.");
    allImagesLoaded = true;
    updateSentinel();
    return;
  }

  await loadPool(gen, allFiles);
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

  const myLikesBtn = document.getElementById("btn_my_likes");
  myLikesBtn.classList.remove("is-disabled", "needs-google");
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
  imagePool = [];

  const imagesEl = document.getElementById("images");
  imagesEl.innerHTML = skeletonHtml(viewMode);

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
    imagesEl.innerHTML = emptyStateHtml("thumbs-up", "No likes yet", "Tap the thumbs-up on any image to save it here.");
    updateSentinel();
    return;
  }

  await loadPool(
    gen,
    likes.map((l) => ({ name: l.image_name })),
  );
});

// 검색 기능 (파일명 + 메시지 내용)
const SEARCH_LIMIT = 50;
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
  imagePool = [];

  const safeQuery = `<span class="t-strong">"${escapeHtml(query)}"</span>`;
  searchBarText.innerHTML = `Searching for ${safeQuery}…`;
  const imagesEl = document.getElementById("images");
  imagesEl.innerHTML = skeletonHtml(viewMode);

  // 파일명(display_name 은 원본 파일명이라 검색어를 그대로 매칭) + 메시지 내용 검색을 동시에
  const [{ data: fileMatches }, { data: msgMatches }] = await Promise.all([
    supabase
      .from("image_info")
      .select("file_path")
      .ilike("display_name", `%${query}%`)
      .order("created_at", { ascending: false })
      .limit(SEARCH_LIMIT),
    supabase
      .from("image_messages")
      .select("image_name")
      .ilike("message", `%${query}%`)
      .order("created_at", { ascending: false })
      .limit(SEARCH_LIMIT),
  ]);
  if (gen !== loadGeneration) return;

  // 결과 합치기 (Set 이 삽입 순서를 유지하므로 중복 제거 + 파일명 검색 우선)
  const imgNames = [
    ...new Set([...(fileMatches || []).map((r) => r.file_path), ...(msgMatches || []).map((r) => r.image_name)]),
  ];
  // 한쪽이라도 limit 에 닿았으면 더 있을 수 있으므로 + 를 붙인다
  const truncated = fileMatches?.length === SEARCH_LIMIT || msgMatches?.length === SEARCH_LIMIT;
  const count = `${imgNames.length}${truncated ? "+" : ""}`;
  searchBarText.innerHTML = `${count} ${imgNames.length === 1 && !truncated ? "result" : "results"} for ${safeQuery}`;

  if (imgNames.length === 0) {
    imagesEl.innerHTML = emptyStateHtml(
      "magnifying-glass",
      `No results for "${escapeHtml(query)}"`,
      "Search matches file names and comments. Try a shorter word.",
    );
    updateSentinel();
    return;
  }

  await loadPool(
    gen,
    imgNames.map((name) => ({ name })),
  );
};

document.getElementById("btn_search").addEventListener("click", doSearch);
document.getElementById("search_input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});

document.getElementById("btn_upload").addEventListener("click", (e) => {
  if (e.currentTarget.classList.contains("needs-google")) return;
  // 카테고리 선택 후 파일 선택창 열기
  showDirPicker("upload category", imgDirs, (dir) => {
    setUploadDir(dir);
    document.getElementById("file_input").click();
  });
});

// admin 전용: 빈 카테고리 추가. 카테고리명은 Storage 경로가 되므로 기존 카테고리처럼 ASCII 소문자/숫자/- 만 허용한다.
const CATEGORY_NAME = /^[a-z0-9-]+$/;
const addCategoryBtn = document.getElementById("btn_add_category");
isAdmin().then((admin) => {
  if (admin) addCategoryBtn.style.display = "";
});
addCategoryBtn.addEventListener("click", async () => {
  const { dialog, closed } = openDialog(
    "<p>new category</p>" +
      '<form method="dialog">' +
      '<input class="input dialog-input" placeholder="a-z, 0-9, -" autocomplete="off" autofocus>' +
      '<div class="dialog-buttons"><button class="btn btn-primary" value="ok">add</button>' +
      '<button class="btn" value="">cancel</button></div></form>',
  );
  if ((await closed) !== "ok") return;
  const dir = dialog.querySelector("input").value.trim();
  if (!dir) return;
  if (!CATEGORY_NAME.test(dir)) {
    await showAlert("Use lowercase letters, digits and - only");
    return;
  }
  if (imgDirs.includes(dir)) {
    await showAlert(`"${dir}" already exists`);
    return;
  }
  if (!(await createDir(dir))) return;
  imgDirs.push(dir);
  renderCategoryButtons();
  // hashchange 로 새 카테고리(빈 상태 안내)로 이동
  location.hash = encodeURIComponent(dir);
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
  const rows = SHORTCUTS_HELP.map(
    ([k, desc]) => `<div class="sc-row"><kbd class="sc-key">${k}</kbd><span class="sc-desc">${desc}</span></div>`,
  ).join("");
  openDialog(
    "<p>keyboard shortcuts</p>" +
      `<div class="sc-list">${rows}</div>` +
      '<form method="dialog" class="dialog-buttons"><button class="btn btn-primary" autofocus>close</button></form>',
  );
};

// viewport 중앙에 가장 가까운 이미지 컨테이너
const getItemSelector = () => (viewMode === "grid" ? "#images .grid-card" : "#images .card");

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

// 계정 메뉴(popover)가 열려 있는 동안에도 단축키를 막는다.
// :popover-open 셀렉터는 미지원 브라우저에서 SyntaxError 이므로 toggle 이벤트로 열림 상태를 따라간다.
let accountMenuOpen = false;
document.getElementById("account_menu")?.addEventListener("toggle", (e) => {
  accountMenuOpen = e.newState === "open";
});

const hasOpenOverlay = () => accountMenuOpen || document.querySelector(".img-overlay, dialog[open]") !== null;

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
  // 아이콘까지 되돌리도록 textContent 가 아닌 innerHTML 을 보관한다
  const originalHtml = uploadBtn.innerHTML;
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
      // loadImg 만 부르면 loadedDir/활성 버튼/hash 가 이전 화면(latest 등)에 머무르므로 라우팅을 거친다
      const dir = uploadDir || currentDir;
      history.replaceState(null, "", `#${encodeURIComponent(dir)}`);
      loadDirFromHash({ dir, image: null }, true);
      refreshImageCount();
    }
  } finally {
    uploadBtn.innerHTML = originalHtml;
    uploadBtn.disabled = false;
    e.target.value = "";
  }
});
