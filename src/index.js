import "./common.js";
import "@phosphor-icons/web/fill";
import "./common.css";

import { getCurrentUser, isAdmin, supabase } from "./common.js";
import { loadImages, setLoadMoreHandler, showOverlayByName } from "./image.js";
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
const SEARCH_LIMIT = 50;
// PostgREST 는 like/ilike 패턴의 * 를 % 로 바꿔 전체가 매치되므로 검색어의 * 는 공백으로 바꾼다
const toSearchQuery = (raw) => raw.replace(/\*/g, " ").trim();
let viewMode = localStorage.getItem("sbbs-view-mode") || "list";
const getPageSize = () => (viewMode === "grid" ? GRID_PAGE_SIZE : LIST_PAGE_SIZE);

let currentDir = "";
let currentOffset = 0;
// 첫 화면을 불러오기 전에는 sentinel 이 보여도 추가 로드하지 않는다
let allImagesLoaded = true;
// latest / my likes / 검색처럼 전체 목록을 먼저 받는 화면의 목록. 카테고리 화면은 storage 페이지네이션을 쓰므로 비어 있다.
let imagePool = [];
// 카테고리 화면에서 지금까지 불러온 파일. 삭제·이동된 파일이 이 안에 있을 때만 storage offset 을 당긴다
const loadedNames = new Set();
// 삭제·이동으로 storage offset 을 당긴 횟수. 다음 페이지 요청 중에 바뀌었는지 확인하는 데 쓴다
let removedSeq = 0;
let loadedDir = "";
// 검색 화면의 검색어와 결과 수 (빈 상태 문구, 삭제·이동 후 결과 수 갱신용). truncated 는 limit 에 닿아 더 있을 수 있다는 뜻
let searchQuery = "";
let searchCount = 0;
let searchTruncated = false;
// loadImg/loadLatest 가 호출될 때마다 증가. 진행 중인 loadMoreImages 가 stale 인지 식별한다.
let loadGeneration = 0;
const staleChecker = (gen) => () => gen !== loadGeneration;
// 추가 로드 중인 generation 과 그 Promise. stale 요청이 새 화면의 추가 로드를 막지 않도록 generation 단위로 잠그고,
// 같은 화면에서 다시 부르면(스크롤 + 오버레이 다음 이미지) 새로 요청하지 않고 진행 중인 로드를 기다리게 한다.
let loadingMoreGen = -1;
let loadingMore = Promise.resolve();

const buildMetaMap = (files) => {
  const metaMap = {};
  for (const f of files) {
    metaMap[f.name] = { created_at: f.created_at, size: f.size };
  }
  return metaMap;
};

// 화면별 빈 상태. 처음 불러왔을 때와 마지막 항목이 삭제·이동됐을 때 같이 쓴다
const emptyViewHtml = (view) => {
  switch (view) {
    case "__latest__":
      return emptyStateHtml("image", "Nothing here yet", "Upload an image to get started.");
    case "__my_likes__":
      return emptyStateHtml("thumbs-up", "No likes yet", "Tap the thumbs-up on any image to save it here.");
    case "__search__":
      return emptyStateHtml(
        "magnifying-glass",
        `No results for "${escapeHtml(searchQuery)}"`,
        "Search matches file names and comments. Try a shorter word.",
      );
    default:
      return emptyStateHtml("image", "Nothing here yet", "Upload an image to start this category.");
  }
};

// 목록 조회 실패. 비어 있는 것과 구분되게 보여주고 다시 시도할 수 있게 한다
const showLoadError = (retry) => {
  const imagesEl = document.getElementById("images");
  imagesEl.innerHTML = emptyStateHtml("warning-circle", "Couldn't load", "Check your connection and try again.");
  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "btn btn-primary";
  retryBtn.innerHTML = '<i class="ph-fill ph-arrow-clockwise"></i> retry';
  retryBtn.addEventListener("click", () => retry());
  imagesEl.querySelector(".empty-state").append(retryBtn);
};

async function loadImg(path) {
  loadGeneration++;
  const gen = loadGeneration;
  currentDir = path;
  currentOffset = 0;
  // 로딩 중 loadMoreImages 가 발화하지 않도록 true
  allImagesLoaded = true;
  imagePool = [];
  loadedNames.clear();
  const imagesEl = document.getElementById("images");
  imagesEl.innerHTML = "";
  // sentinel 을 로딩 인디케이터로 사용 (중앙 정렬, 단일 표시)
  showSentinelLoading();

  const pageSize = getPageSize();
  const imgFiles = await getImageList(path, 0, pageSize + 1);
  // 그 사이에 다른 화면 전환이 일어났다면 결과 폐기
  if (gen !== loadGeneration) return;
  if (imgFiles === null) {
    showLoadError(() => loadImg(path));
    updateSentinel();
    return;
  }
  const hasMore = imgFiles.length > pageSize;
  const filesToLoad = hasMore ? imgFiles.slice(0, pageSize) : imgFiles;
  allImagesLoaded = !hasMore;
  currentOffset = filesToLoad.length;

  if (filesToLoad.length === 0) {
    imagesEl.innerHTML = emptyViewHtml(path);
    updateSentinel();
    return;
  }

  const imgNames = filesToLoad.map((f) => f.name);
  for (const name of imgNames) loadedNames.add(name);
  const metaMap = buildMetaMap(filesToLoad);
  await loadImages("images", imgNames, metaMap, false, viewMode, staleChecker(gen));
  if (gen !== loadGeneration) return;
  updateSentinel();
}

// 다음 페이지를 #images 에 붙인다. 진행 중이면 그 로드를 기다리고, 더 없으면 바로 resolve 한다 (image.js setLoadMoreHandler 계약)
function loadMoreImages() {
  if (loadingMoreGen === loadGeneration) return loadingMore;
  if (allImagesLoaded) return Promise.resolve();
  const gen = loadGeneration;
  loadingMoreGen = gen;
  loadingMore = appendNextPage(gen);
  return loadingMore;
}

async function appendNextPage(gen) {
  let failed = false;
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
      // 요청 중에 이미 불러온 파일이 삭제·이동되면(removedSeq 증가) 응답이 당겨지기 전/후 어느 순서인지 알 수 없어
      // 한 장을 건너뛸 수 있으므로 그 응답은 버리고 당겨진 offset 으로 다시 요청한다 (연속 삭제에 대비해 최대 3번)
      let imgFiles = null;
      for (let tries = 0; tries < 3; tries++) {
        const seq = removedSeq;
        imgFiles = await getImageList(currentDir, currentOffset, pageSize + 1);
        // fetch 사이에 화면 전환됐으면 폐기 (이전 카테고리 결과를 새 화면에 append 하는 것 방지)
        if (gen !== loadGeneration) return;
        if (imgFiles === null || seq === removedSeq) break;
      }
      if (imgFiles === null) {
        failed = true;
        return;
      }
      const hasMore = imgFiles.length > pageSize;
      const filesToLoad = hasMore ? imgFiles.slice(0, pageSize) : imgFiles;
      allImagesLoaded = !hasMore;
      currentOffset += filesToLoad.length;

      if (filesToLoad.length > 0) {
        const imgNames = filesToLoad.map((f) => f.name);
        for (const name of imgNames) loadedNames.add(name);
        const metaMap = buildMetaMap(filesToLoad);
        await loadImages("images", imgNames, metaMap, true, viewMode, staleChecker(gen));
        if (gen !== loadGeneration) return;
      }
    }
  } catch (err) {
    console.warn("loadMoreImages error:", err);
    failed = true;
  } finally {
    if (loadingMoreGen === gen) loadingMoreGen = -1;
    if (gen === loadGeneration) {
      if (failed) showLoadMoreError();
      else updateSentinel();
    }
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
const searchQueryHtml = () => `<span class="t-strong">"${escapeHtml(searchQuery)}"</span>`;
// 결과 수 문구. 삭제·이동으로 결과가 줄면 다시 그린다
const renderSearchCount = () => {
  const count = `${searchCount}${searchTruncated ? "+" : ""}`;
  const noun = searchCount === 1 && !searchTruncated ? "result" : "results";
  searchBarText.innerHTML = `${count} ${noun} for ${searchQueryHtml()}`;
};
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

// 추가 로드 실패: sentinel 감시를 멈춰 재요청이 반복되지 않게 하고, 다시 시도 버튼으로만 이어서 불러온다.
// 다음 updateSentinel(성공한 로드, 화면 전환)이 감시를 다시 건다.
const showLoadMoreError = () => {
  scrollObserver.unobserve(sentinel);
  sentinel.style.display = "";
  sentinel.innerHTML =
    '<div class="load-more-error">Couldn\'t load more' +
    '<button type="button" class="btn"><i class="ph-fill ph-arrow-clockwise"></i> retry</button></div>';
  sentinel.querySelector("button").addEventListener("click", () => {
    showSentinelLoading();
    loadMoreImages();
  });
};

// 오버레이에서 목록 끝의 다음 이미지로 넘길 때도 같은 추가 로드를 쓴다
setLoadMoreHandler(loadMoreImages);

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

// 다크/라이트 테마 토글. 초기 테마 클래스는 head 의 인라인 스크립트가 첫 페인트 전에 적용해 두었으므로
// 여기서는 아이콘만 현재 클래스 상태에 맞추고, 사용자가 토글할 때만 localStorage 에 저장한다.
const themeBtn = document.getElementById("btn_theme");
const syncThemeIcon = () => {
  const light = document.documentElement.classList.contains("light");
  document.getElementById("theme_icon").className = light ? "ph-fill ph-moon" : "ph-fill ph-sun";
};
syncThemeIcon();
themeBtn.addEventListener("click", () => {
  const light = !document.documentElement.classList.contains("light");
  document.documentElement.classList.toggle("light", light);
  localStorage.setItem("sbbs-theme", light ? "light" : "dark");
  syncThemeIcon();
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
    // 입력란에 아직 검색하지 않은 값(빈칸, * 만 등)이 있어도 지금 화면의 검색을 다시 불러온다
    document.getElementById("search_input").value = searchQuery;
    doSearch();
  } else {
    loadDirFromHash(parseHash(), true);
  }
};

document.getElementById("btn_view_toggle").addEventListener("click", () => {
  applyViewMode(viewMode === "list" ? "grid" : "list");
  reloadCurrentView();
});

const fetchedDirs = await getImageDirs("");
// 카테고리 목록을 못 받으면(null) imgDirs 가 비어 "비어 있음"으로 보이므로, 시작 화면을 불러오지 않고
// imgDirs 에 기대는 화면(latest)과 동작(업로드·카테고리 추가)도 오류로 처리한다. 다시 시도는 목록부터 다시 받도록 새로고침한다
const dirsFailed = fetchedDirs === null;
const imgDirs = fetchedDirs ?? [];
const showDirsError = () => showLoadError(() => window.location.reload());
if (dirsFailed) {
  showDirsError();
} else if (imgDirs.length === 0) {
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
  // 검색 화면에서 해시 링크로 넘어와도 ?q= 는 지우지 않는다. 해시만 바뀐 이동이어야 뒤로가기에서 hashchange 가 나
  // showViewFromUrl 이 검색 화면을 되살린다 (새로고침은 해시가 우선이라 카테고리 그대로)
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
  history.replaceState(history.state, "", window.location.pathname);
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

  if (dirsFailed) {
    showDirsError();
    updateSentinel();
    return;
  }

  // 모든 카테고리에서 이미지 목록을 동시에 가져와서 최신순 정렬 (카테고리당 최대 1000개)
  const lists = await Promise.all(imgDirs.map((dir) => getImageList(dir, 0, 1000)));
  if (gen !== loadGeneration) return;
  // 일부 카테고리만 실패하면 받은 것만 보여주고, 전부 실패하면 오류 상태
  const failedDirs = imgDirs.filter((_, i) => lists[i] === null);
  if (failedDirs.length > 0 && failedDirs.length === imgDirs.length) {
    showLoadError(loadLatest);
    updateSentinel();
    return;
  }
  if (failedDirs.length > 0) console.warn("loadLatest: failed to list", failedDirs);
  const allFiles = lists.filter(Boolean).flat();
  allFiles.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (allFiles.length === 0) {
    imagesEl.innerHTML = emptyViewHtml("__latest__");
    allImagesLoaded = true;
    updateSentinel();
    return;
  }

  await loadPool(gen, allFiles);
};

document.getElementById("btn_latest").addEventListener("click", loadLatest);

// URL 에 맞춰 화면을 고른다 (시작, hashchange 공통). 우선순위: 해시 딥링크(#dir, #dir/file) > 검색어(?q=) > 최신 이미지(기본 홈).
// 뒤로가기 등으로 해시가 없어지거나 모르는 카테고리가 되면 남은 URL 에 맞는 화면으로 돌아간다. 이미 그 화면이면 다시 불러오지 않는다
const showViewFromUrl = () => {
  if (loadDirFromHash(parseHash())) return;
  const query = toSearchQuery(new URLSearchParams(window.location.search).get("q") ?? "");
  if (query) {
    if (loadedDir === "__search__" && query === searchQuery) return;
    document.getElementById("search_input").value = query;
    doSearch();
  } else if (loadedDir !== "__latest__") {
    loadLatest();
  }
};

if (!dirsFailed) showViewFromUrl();

// hash 변경(카테고리 탭, 딥링크, 뒤로가기) 시 URL 에 맞는 화면으로 이동.
// 오버레이는 같은 URL 로 기록을 쌓고 back 하므로 정상적으로 닫을 때는 hashchange 가 나지 않는다
window.addEventListener("hashchange", () => showViewFromUrl());

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
  history.replaceState(history.state, "", window.location.pathname);
  updateActiveDir("__my_likes__");
  loadedDir = "__my_likes__";
  allImagesLoaded = true;
  currentOffset = 0;
  imagePool = [];

  const imagesEl = document.getElementById("images");
  imagesEl.innerHTML = skeletonHtml(viewMode);

  const user = await getCurrentUser();
  if (gen !== loadGeneration) return;
  if (!user) {
    imagesEl.innerHTML = "";
    return;
  }
  const { data: likes, error } = await supabase
    .from("image_likes")
    .select("image_name")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (gen !== loadGeneration) return;
  if (error) {
    console.warn("my likes error:", error);
    showLoadError(reloadCurrentView);
    updateSentinel();
    return;
  }

  if (!likes || likes.length === 0) {
    imagesEl.innerHTML = emptyViewHtml("__my_likes__");
    updateSentinel();
    return;
  }

  await loadPool(
    gen,
    likes.map((l) => ({ name: l.image_name })),
  );
});

// 검색 기능 (파일명 + 메시지 내용). 시작 시 ?q= 로 바로 부를 수 있도록 함수 선언(호이스팅)으로 둔다
async function doSearch() {
  const input = document.getElementById("search_input");
  const query = toSearchQuery(input.value);
  if (!query) {
    // * 만 넣은 것처럼 정리하면 비는 입력은 검색하지 않고, 입력란을 지금 화면의 검색어로 되돌려 결과 바와 맞춘다
    if (input.value.trim()) input.value = loadedDir === "__search__" ? searchQuery : "";
    return;
  }
  // 입력란도 실제로 검색한 값으로 맞춘다 (예: "cat*" → "cat")
  input.value = query;
  loadGeneration++;
  const gen = loadGeneration;

  // 새로고침·공유해도 같은 검색이 열리도록 검색어를 URL 에 남긴다 (해시는 지운다)
  history.replaceState(history.state, "", `${window.location.pathname}?q=${encodeURIComponent(query)}`);
  updateActiveDir("__search__");
  loadedDir = "__search__";
  searchQuery = query;
  allImagesLoaded = true;
  currentOffset = 0;
  imagePool = [];

  const safeQuery = searchQueryHtml();
  searchBarText.innerHTML = `Searching for ${safeQuery}…`;
  const imagesEl = document.getElementById("images");
  imagesEl.innerHTML = skeletonHtml(viewMode);

  // 파일명(display_name 은 원본 파일명이라 검색어를 그대로 매칭) + 메시지 내용 검색을 동시에.
  // 검색어의 %, _, \ 는 ilike 와일드카드/이스케이프 문자이므로 글자 그대로 찾도록 \ 로 이스케이프한다
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const [{ data: fileMatches, error: fileErr }, { data: msgMatches, error: msgErr }] = await Promise.all([
    supabase
      .from("image_info")
      .select("file_path")
      .ilike("display_name", pattern)
      .order("created_at", { ascending: false })
      .limit(SEARCH_LIMIT),
    supabase
      .from("image_messages")
      .select("image_name")
      .ilike("message", pattern)
      .order("created_at", { ascending: false })
      .limit(SEARCH_LIMIT),
  ]);
  if (gen !== loadGeneration) return;
  // 한쪽이라도 실패하면 결과가 빠졌을 수 있으므로 "결과 없음" 대신 오류 상태
  if (fileErr || msgErr) {
    console.warn("search error:", fileErr || msgErr);
    searchBarText.innerHTML = `Couldn't search for ${safeQuery}`;
    showLoadError(reloadCurrentView);
    updateSentinel();
    return;
  }

  // 결과 합치기 (Set 이 삽입 순서를 유지하므로 중복 제거 + 파일명 검색 우선)
  const imgNames = [
    ...new Set([...(fileMatches || []).map((r) => r.file_path), ...(msgMatches || []).map((r) => r.image_name)]),
  ];
  // 한쪽이라도 limit 에 닿았으면 더 있을 수 있으므로 + 를 붙인다
  searchCount = imgNames.length;
  searchTruncated = fileMatches?.length === SEARCH_LIMIT || msgMatches?.length === SEARCH_LIMIT;
  renderSearchCount();

  if (imgNames.length === 0) {
    imagesEl.innerHTML = emptyViewHtml("__search__");
    updateSentinel();
    return;
  }

  await loadPool(
    gen,
    imgNames.map((name) => ({ name })),
  );
}

document.getElementById("btn_search").addEventListener("click", doSearch);
document.getElementById("search_input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});

// 업로드 대상 카테고리 선택. 카테고리 목록을 못 받았으면 고를 수 없으므로 알리고 끝낸다 (image.js 이동 picker 와 같은 문구)
const pickUploadDir = (onSelect) => {
  if (dirsFailed) {
    showAlert("failed to load categories");
    return;
  }
  showDirPicker("upload category", imgDirs, (dir) => {
    setUploadDir(dir);
    onSelect();
  });
};

document.getElementById("btn_upload").addEventListener("click", (e) => {
  if (e.currentTarget.classList.contains("needs-google")) return;
  // 카테고리 선택 후 파일 선택창 열기
  pickUploadDir(() => document.getElementById("file_input").click());
});

// admin 전용: 빈 카테고리 추가. 카테고리명은 Storage 경로가 되므로 기존 카테고리처럼 ASCII 소문자/숫자/- 만 허용한다.
const CATEGORY_NAME = /^[a-z0-9-]+$/;
const addCategoryBtn = document.getElementById("btn_add_category");
isAdmin().then((admin) => {
  if (admin) addCategoryBtn.style.display = "";
});
addCategoryBtn.addEventListener("click", async () => {
  // 기존 목록을 모르면 중복 확인과 탭 갱신을 할 수 없다
  if (dirsFailed) {
    await showAlert("failed to load categories");
    return;
  }
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
  ["←/→", "prev/next image (in overlay)"],
  ["/", "focus search"],
  ["v", "toggle grid/list view"],
  ["t", "toggle theme"],
  ["⌘/Ctrl+V", "upload copied image (google login)"],
  ["drag & drop", "upload dropped files (google login)"],
  ["⌘/Ctrl+Enter", "save comment"],
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

const uploadFiles = async (files) => {
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
      history.replaceState(history.state, "", `#${encodeURIComponent(dir)}`);
      loadDirFromHash({ dir, image: null }, true);
      refreshImageCount();
    }
  } finally {
    uploadBtn.innerHTML = originalHtml;
    uploadBtn.disabled = false;
  }
};

document.getElementById("file_input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (files.length > 0) await uploadFiles(files);
});

// 붙여넣기·끌어다 놓기 업로드: 카테고리 선택 후 업로드 버튼과 같은 흐름을 탄다
const pickDirAndUpload = (files) => pickUploadDir(() => uploadFiles(files));

// 클립보드 이미지(copy image) 붙여넣기 업로드
document.addEventListener("paste", (e) => {
  if (isTypingInField() || hasOpenOverlay()) return;
  const uploadBtn = document.getElementById("btn_upload");
  if (uploadBtn.disabled || uploadBtn.classList.contains("needs-google")) return;
  const files = [...e.clipboardData.files];
  if (files.length === 0) return;
  e.preventDefault();
  pickDirAndUpload(files);
});

// 파일 끌어다 놓기 업로드. 페이지 안에서 시작한 드래그(카테고리 탭 순서 변경, 이미지 끌기)는 dragstart 로 걸러낸다
// (Chrome 은 페이지 안 이미지를 끌 때도 types 에 "Files" 를 넣는다).
// dragenter/dragleave 는 자식 요소를 지날 때마다 오므로 깊이를 세어 안내 표시가 깜빡이지 않게 한다.
let internalDrag = false;
let fileDragDepth = 0;
const isFileDrag = (e) => !internalDrag && e.dataTransfer?.types.includes("Files");
const endFileDrag = () => {
  fileDragDepth = 0;
  document.body.classList.remove("is-file-dragover");
};
document.addEventListener("dragstart", () => {
  internalDrag = true;
});
document.addEventListener("dragend", () => {
  internalDrag = false;
  endFileDrag();
});
document.addEventListener("dragenter", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  fileDragDepth++;
  if (!hasOpenOverlay()) document.body.classList.add("is-file-dragover");
});
document.addEventListener("dragleave", (e) => {
  if (!isFileDrag(e)) return;
  fileDragDepth = Math.max(0, fileDragDepth - 1);
  if (fileDragDepth === 0) endFileDrag();
});
document.addEventListener("dragover", (e) => {
  if (!isFileDrag(e)) return;
  // 막지 않으면 브라우저가 파일을 열어 페이지를 떠난다. 오버레이/다이얼로그가 열려 있으면 놓을 수 없음으로 표시한다
  e.preventDefault();
  e.dataTransfer.dropEffect = hasOpenOverlay() ? "none" : "copy";
});
document.addEventListener("drop", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  endFileDrag();
  if (hasOpenOverlay()) return;
  const uploadBtn = document.getElementById("btn_upload");
  if (uploadBtn.disabled) return;
  if (uploadBtn.classList.contains("needs-google")) {
    showAlert("Google login required");
    return;
  }
  const files = [...e.dataTransfer.files];
  if (files.length > 0) pickDirAndUpload(files);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") endFileDrag();
});

// 파일이 삭제·이동되면 image.js 가 카드를 지운 직후 알린다. 목록에 없던 딥링크 파일이어도 알리므로, 불러온 범위에 있었는지는 여기서 가린다.
// 이미지 수와 페이지 위치를 맞춘다.
// 카테고리 화면은 storage offset 이 한 칸 당겨지므로, 이미 불러온 파일이면 줄이지 않을 경우 다음 페이지에서 한 장을 건너뛴다.
// 풀 화면(latest/my likes/검색)은 offset 이 받아 둔 pool 의 인덱스라 그린 범위는 보정이 필요 없고, 아직 안 그린 항목만 pool 에서 뺀다.
document.addEventListener("sbbs:item-removed", async (e) => {
  refreshImageCount();
  const name = e.detail?.name;
  if (imagePool.length === 0) {
    if (loadedNames.delete(name)) {
      currentOffset = Math.max(0, currentOffset - 1);
      removedSeq++;
    }
  } else {
    const idx = imagePool.findIndex((f) => f.name === name);
    if (idx !== -1 && loadedDir === "__search__") {
      searchCount = Math.max(0, searchCount - 1);
      renderSearchCount();
    }
    if (idx >= currentOffset) {
      imagePool.splice(idx, 1);
      // 남은 게 없어졌으면 sentinel 을 숨긴다 (진행 중인 로드는 끝날 때 스스로 다시 맞춘다)
      if (currentOffset >= imagePool.length) {
        allImagesLoaded = true;
        updateSentinel();
      }
    }
  }
  if (document.querySelector(getItemSelector())) return;
  // 화면에 남은 항목이 없으면 다음 페이지를 불러오고(진행 중이면 기다림), 더 없으면 빈 상태를 보여준다
  const gen = loadGeneration;
  await loadMoreImages();
  if (gen !== loadGeneration || !allImagesLoaded || document.querySelector(getItemSelector())) return;
  document.getElementById("images").innerHTML = emptyViewHtml(loadedDir);
});
