// 시계 1개 = 저장 항목 1개 (크롬 동기화의 항목당 8KB 제한 회피). 저장 위치는 sync.js가 정한다
const FIELDS = [
  "list", "brand", "model", "price", "stars",
  "diameter", "thickness", "lug", "weight", "weightNote", "movement", "reserve", "material", "water", "released",
  "date", "method", "paid", "soldDate", "soldPrice", "soldNote",
  "note", "hidden",
];
const MAX_IMGS = 10;
/** 시계의 사진 목록 — 예전에 한 장만 저장한 img도 받는다 */
const imgsOf = (w) => w?.imgs ?? (w?.img ? [w.img] : []);
/** 주소만 남기고 중복을 빼 최대 장수로 자른다 */
const cleanImgs = (list) =>
  [...new Set(list.map((v) => clip(v, 2000)).filter((v) => /^https:\/\/\S+$/.test(v)))].slice(0, MAX_IMGS);

const $ = (id) => document.getElementById(id);
const dialog = $("dialog");
const form = $("form");

// 새로고침해도 탭이 유지되도록 URL 해시(#owned / #dream)에 보관
let currentList = location.hash === "#dream" ? "dream" : "owned";
let watches = [];
let editingId = null;

// 사진은 이 기기의 IndexedDB에 두고 시계엔 주소만 저장한다 — 다른 기기는 주소로 다시 받는다
const isUrl = (v) => v.startsWith("https://");

let imgDb;
async function imgStore(mode) {
  imgDb ??= new Promise((resolve, reject) => {
    const open = indexedDB.open("watch-box", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("images");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return (await imgDb).transaction("images", mode).objectStore("images");
}
const idb = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
const imgGet = async (key) => idb((await imgStore("readonly")).get(key));
const imgPut = async (key, blob) => idb((await imgStore("readwrite")).put(blob, key));
/** 더는 쓰이지 않는 사진을 기기에서 지운다. 실패해도 파일만 남을 뿐이라 무시 */
const imgDelete = (key) => imgStore("readwrite").then((store) => idb(store.delete(key))).catch(() => {});

/** 이미지를 줄여 JPEG로 만든다 */
async function shrink(source) {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
}

// 같은 주소를 동시에 여러 번 받지 않게 받는 중인 요청을 함께 쓴다
const fetching = new Map();
/** 사진을 기기에서, 없으면 주소로 받아 기기에 넣고 돌려준다. 못 구하면 null */
async function imageBlob(value) {
  const hit = await imgGet(value).catch(() => null);
  if (hit || !isUrl(value)) return hit ?? null;
  if (!fetching.has(value)) {
    fetching.set(
      value,
      (async () => {
        try {
          // GitHub 스토리지에 사본이 있으면 그쪽이 먼저 — 주소가 죽었어도 받을 수 있다
          const copy = await ghImage(value);
          if (copy) {
            await imgPut(value, copy);
            return copy;
          }
          const res = await fetch(value, { signal: AbortSignal.timeout(15000) });
          if (!res.ok) return null;
          const blob = await shrink(await res.blob());
          await imgPut(value, blob);
          return blob;
        } catch {
          return null;
        } finally {
          fetching.delete(value);
        }
      })(),
    );
  }
  return fetching.get(value);
}

/** 저장을 마친 시계들의 사진을 뒤에서 기기에 받아 둔다 — 나중에 주소가 죽어도 보이게 */
async function cacheImages(list) {
  const urls = [...new Set(list.flatMap(imgsOf).filter(isUrl))];
  const blobs = await Promise.all(urls.map(imageBlob));
  const missed = blobs.filter((blob) => !blob).length;
  if (missed) toast(`이미지 ${missed}개를 받지 못했습니다 (주소가 열리지 않음)`);
}

/** 브랜드명을 로고 파일 이름으로 — "A. Lange & Söhne" → "a-lange-sohne" */
const slug = (brand) =>
  brand
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** 사진을 기기에서 꺼내 보여 준다. keep이 false면(가져오기 후보) 기기에 없는 주소는 저장하지 않고 바로 연다 */
async function showImage(img, value, keep = true) {
  // 넘기는 사이 늦게 도착한 앞 사진이 덮어쓰지 않게 마지막 요청만 반영한다
  img.dataset.want = value;
  const blob = keep ? await imageBlob(value) : await imgGet(value).catch(() => null);
  if (img.dataset.want !== value) return;
  if (!blob) return keep || !isUrl(value) ? void img.dispatchEvent(new Event("error")) : void (img.src = value);
  img.src = URL.createObjectURL(blob);
  img.addEventListener("load", () => URL.revokeObjectURL(img.src), { once: true });
}

function toast(text) {
  const node = $("toast");
  node.textContent = text;
  // 나중에 열린 팝업 위로 오도록 매번 다시 띄운다
  if (node.matches(":popover-open")) node.hidePopover();
  node.showPopover();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.hidePopover(), 5000);
}

async function load() {
  watches = await dbAll();
  brandNames = null;
  render();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const won = (n) => `${Number(n).toLocaleString("ko-KR")}원`;

// 목록은 금액 낮은순 고정 — 보유는 구매가, 드림은 가격. 금액이 없으면 뒤로, 같으면 이름순
const amount = (w) => Number(w.list === "owned" ? w.paid : w.price) || 0;
// 선호도(별 0~3개). 별이 많을수록 앞에 둔다
const stars = (w) => Math.min(Number(w.stars) || 0, 3);

// 통계를 누르면 뜨는 팝업에서 고른 것만 보여 준다. 여러 개 고를 수 있고, 비어 있으면 전체
// 브랜드 통계 → 브랜드
const brandFilter = new Set();
/** 대소문자만 다른 브랜드는 하나로 묶는다 */
const brandKey = (w) => w.brand.toLowerCase();
/** 묶인 브랜드는 가장 많이 쓴 표기로 보여 준다 */
// 목록을 다시 읽을 때까지 한 번만 센다
let brandNames = null;
function brandName(key) {
  if (!brandNames) {
    const counts = new Map();
    for (const w of watches) {
      const spellings = counts.get(brandKey(w)) ?? new Map();
      spellings.set(w.brand, (spellings.get(w.brand) ?? 0) + 1);
      counts.set(brandKey(w), spellings);
    }
    brandNames = new Map([...counts].map(([k, spellings]) => [k, [...spellings].sort((a, b) => b[1] - a[1])[0][0]]));
  }
  return brandNames.get(key);
}
// 시계 통계 → 선호도(별 개수)
const starFilter = new Set();
const STARS = [3, 2, 1, 0];
const starLabel = (n) => (n ? "★".repeat(n) : "미지정");
// 합계 통계 → 가격대. 보유는 구매가, 드림은 가격 기준
const priceFilter = new Set();
// 가격대 상한(만 원). 금액이 없는 시계는 -1
const BANDS = [100, 300, 500, 1000, 3000, Infinity];
const bandOf = (w) => (amount(w) ? BANDS.findIndex((max) => amount(w) < max * 10000) : -1);
const bandLabel = (i) => {
  const man = (n) => `${n.toLocaleString("ko-KR")}만`;
  if (i < 0) return "금액 없음";
  if (i === 0) return `${man(BANDS[0])} 원 미만`;
  return BANDS[i] === Infinity ? `${man(BANDS[i - 1])} 원 이상` : `${man(BANDS[i - 1])}~${man(BANDS[i])} 원`;
};

// 숨긴 시계(숨김으로 바꾼 드림 시계, 판매 정보를 적은 보유 시계) — 목록·개수·합계·브랜드에서 뺀다. 통계 오른쪽에서 표시를 고르면 구분선 아래에 다시 넣고 통계에도 포함한다
/** 판매 정보(판매 연월·판매가·판매 비고 중 하나라도)를 적은 보유 시계는 판 것으로 보고 숨긴다 */
const isSold = (w) => w.list === "owned" && !!(w.soldDate || w.soldPrice || w.soldNote);
const isHidden = (w) => (w.list === "dream" ? !!w.hidden : isSold(w));
let showHidden = false;
const listed = (w) => showHidden || !isHidden(w);
// 숨김 상태에서 목록 아래 "숨긴 시계 보기"를 눌렀는지 — 흐리게 보여 주기만 하고 통계에는 넣지 않는다
let peekHidden = false;
const byRank = (a, b) =>
  stars(b) - stars(a) || (amount(a) || Infinity) - (amount(b) || Infinity) || `${a.brand} ${a.model}`.localeCompare(`${b.brand} ${b.model}`);

// 확장에 든 브랜드 로고(logos/<이름>.png)가 있는지 한 번 확인한 결과
const logoOk = new Map();

function render() {
  history.replaceState(null, "", `#${currentList}`);
  for (const tab of document.querySelectorAll(".tab")) {
    const list = tab.dataset.list;
    tab.classList.toggle("active", list === currentList);
    $(`count-${list}`).textContent = watches.filter((w) => w.list === list && listed(w)).length;
  }

  const inList = watches.filter((w) => w.list === currentList);
  const inTab = inList.filter(listed);
  const hiddenInList = inList.filter(isHidden);
  const brands = [...new Set(inTab.map(brandKey))].sort((a, b) => a.localeCompare(b));
  const bands = [...BANDS.keys(), -1].filter((i) => inTab.some((w) => bandOf(w) === i));
  // 이 탭에 없는 브랜드·가격대는 고른 목록에서 뺀다
  for (const b of [...brandFilter]) if (!brands.includes(b)) brandFilter.delete(b);
  for (const i of [...priceFilter]) if (!bands.includes(i)) priceFilter.delete(i);
  const matches = (w) =>
    (!brandFilter.size || brandFilter.has(brandKey(w))) &&
    (!starFilter.size || starFilter.has(stars(w))) &&
    (!priceFilter.size || priceFilter.has(bandOf(w)));
  const items = inTab.filter(matches).sort(byRank);

  const owned = currentList === "owned";
  /** 누르면 필터 팝업이 뜨는 통계. 필터가 걸려 있으면 강조 */
  const filterStat = (label, value, filter, name) => {
    const node = stat(label, value, "button");
    node.classList.toggle("active", filter.size > 0);
    node.addEventListener("click", () => $(`${name}-dialog`).showModal());
    return node;
  };
  const stats = [filterStat("시계", items.length, starFilter, "star")];
  // 보유는 구매가를 적은 시계가 있을 때만 합계를 보여 준다 (필터 중이면 풀 수 있게 항상)
  if (!owned || priceFilter.size || items.some((w) => Number(w.paid))) {
    const total = items.reduce((acc, w) => acc + amount(w), 0);
    stats.push(filterStat("합계", won(total), priceFilter, "price"));
  }
  stats.push(filterStat("브랜드", new Set(items.map(brandKey)).size, brandFilter, "brand"));
  $("stats").replaceChildren(...stats);

  // 걸려 있는 필터는 통계 아래에 태그로 나열하고, 태그를 누르면 그 조건만 푼다
  const tag = (kind, label, filter, value) => {
    const node = el("button", "tag");
    node.append(el("span", "tag-kind", kind), label, el("span", "tag-x", "×"));
    node.ariaLabel = `${kind} ${label} 필터 해제`;
    node.addEventListener("click", () => {
      filter.delete(value);
      render();
    });
    return node;
  };
  const tags = [
    ...brands.filter((b) => brandFilter.has(b)).map((b) => tag("브랜드", brandName(b), brandFilter, b)),
    ...bands.filter((i) => priceFilter.has(i)).map((i) => tag("가격대", bandLabel(i), priceFilter, i)),
    ...STARS.filter((n) => starFilter.has(n)).map((n) => tag("선호도", starLabel(n), starFilter, n)),
  ];
  if (tags.length) {
    const reset = el("button", "tag-reset", "모두 해제");
    reset.addEventListener("click", () => {
      for (const filter of [brandFilter, priceFilter, starFilter]) filter.clear();
      render();
    });
    tags.push(reset);
  }
  $("filters").hidden = !tags.length;
  $("filters").replaceChildren(...tags);

  /** 필터 칩 — 누를 때마다 고르거나 빼고, 값이 없는 "전체" 칩은 모두 푼다 */
  const chip = (label, filter, value) => {
    const on = value === undefined ? !filter.size : filter.has(value);
    const node = el("button", on ? "chip active" : "chip", label);
    node.addEventListener("click", () => {
      if (value === undefined) filter.clear();
      else if (!filter.delete(value)) filter.add(value);
      render();
    });
    return node;
  };
  const brandChip = (key) => {
    const brand = brandName(key);
    const node = chip(brand, brandFilter, key);
    // 로고가 있으면 이름 대신 로고로 보여 준다
    const src = `logos/${slug(brand)}.png`;
    const showLogo = () => {
      const img = el("img");
      img.alt = brand;
      img.src = src;
      node.replaceChildren(img);
      node.classList.add("logo");
      node.title = brand;
    };
    if (logoOk.get(src)) showLogo();
    else if (!logoOk.has(src)) {
      const probe = new Image();
      probe.onload = () => {
        logoOk.set(src, true);
        showLogo();
      };
      probe.onerror = () => logoOk.set(src, false);
      probe.src = src;
    }
    return node;
  };
  $("brands").replaceChildren(chip("전체", brandFilter), ...brands.map(brandChip));
  $("price-chips").replaceChildren(chip("전체", priceFilter), ...bands.map((i) => chip(bandLabel(i), priceFilter, i)));
  $("star-chips").replaceChildren(chip("전체", starFilter), ...STARS.map((n) => chip(starLabel(n), starFilter, n)));
  $("empty").textContent = inTab.length
    ? "조건에 맞는 시계가 없습니다"
    : hiddenInList.length ? "숨긴 시계만 있습니다"
    : owned ? "아직 등록된 보유 시계가 없습니다" : "아직 등록된 드림 워치가 없습니다";
  $("empty").hidden = items.length > 0;

  $("list").replaceChildren(
    ...items.filter((w) => !isHidden(w)).map(renderItem),
    ...hiddenSection(hiddenInList.filter(matches).sort(byRank)),
  );

  $("hidden-toggle").hidden = !hiddenInList.length;
  $("hidden-count").textContent = `숨긴 시계 ${hiddenInList.length}개`;
  for (const radio of document.getElementsByName("show-hidden")) radio.checked = !!radio.value === showHidden;
}

/** 목록 맨 아래의 숨긴 시계 묶음 — 구분선과 카드. 표시 상태면 일반 카드로, 숨김 상태면 "보기"를 눌렀을 때만 흐리게 보여 준다 */
function hiddenSection(items) {
  if (!items.length) return [];
  const divider = el("li", "divider", showHidden ? "숨긴 시계" : "");
  if (showHidden) return [divider, ...items.map(renderItem)];
  const peek = el("button", "", peekHidden ? "숨긴 시계 접기" : `숨긴 시계 ${items.length}개 보기`);
  peek.addEventListener("click", () => {
    peekHidden = !peekHidden;
    render();
  });
  divider.append(peek);
  const cards = peekHidden ? items.map(renderItem) : [];
  for (const card of cards) card.classList.add("faded");
  return [divider, ...cards];
}
$("hidden-toggle").addEventListener("change", (e) => {
  showHidden = !!e.target.value;
  render();
});

function stat(label, value, tag = "div") {
  const node = el(tag, "stat");
  node.append(el("div", "stat-label", label), el("div", "stat-value", String(value)));
  return node;
}

function renderItem(w) {
  const li = el("li", "card");
  li.tabIndex = 0;
  li.addEventListener("click", () => openForm(w));
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter") openForm(w);
  });

  // 이미지가 없거나 로드 실패하면 브랜드 첫 글자 다이얼로 대체
  const photo = el("div", "photo");
  const dial = el("div", "dial", w.brand.charAt(0).toUpperCase());
  const [cover] = imgsOf(w);
  if (cover) {
    const img = el("img");
    img.alt = "";
    img.addEventListener("error", () => img.replaceWith(dial));
    photo.append(img);
    showImage(img, cover);
  } else {
    photo.append(dial);
  }
  if (w.note) photo.append(el("div", "note", w.note));
  li.append(photo);

  const body = el("div", "body");
  const title = el("div", "title");
  title.append(el("div", "model", w.model));
  if (stars(w)) title.append(el("div", "stars", "★".repeat(stars(w))));
  body.append(el("div", "brand", brandName(brandKey(w))), title);
  // 카드엔 핵심 스펙과 구매 정보(보유만)만, 나머지는 정보 팝업에서
  const lines = [
    [w.diameter && `${w.diameter}mm`, w.water && `방수 ${w.water}m`],
    w.list === "owned" ? [w.date?.slice(0, 7), w.method] : [],
    isSold(w) ? [["판매", w.soldDate].filter(Boolean).join(" "), w.soldPrice && won(w.soldPrice), w.soldNote] : [],
  ];
  for (const parts of lines) {
    const line = parts.filter(Boolean).join(" · ");
    if (line) body.append(el("div", "meta", line));
  }
  li.append(body);

  const foot = el("div", "foot");
  // 보유 시계는 구매가를 먼저, 없으면 가격을 보여 준다
  const shown = (w.list === "owned" && w.paid) || w.price;
  foot.append(shown ? el("div", "price", won(shown)) : el("div", "price none", "가격 미정"));
  li.append(foot);

  return li;
}

// 금액 칸은 입력 중에도 천 단위 쉼표로 보여 주고, 저장할 때 숫자만 남긴다
const MONEY = ["price", "paid", "soldPrice"];
const commas = (v) => {
  const digits = String(v ?? "").replace(/\D/g, "");
  return digits ? Number(digits).toLocaleString("ko-KR") : "";
};
for (const f of MONEY) {
  form.elements[f].addEventListener("input", (e) => (e.target.value = commas(e.target.value)));
}

// 별을 누르면 그 개수로, 같은 별을 다시 누르면 0개로
function paintStars() {
  const value = Number(form.elements.stars.value) || 0;
  for (const button of $("stars").children) button.classList.toggle("on", Number(button.dataset.star) <= value);
}
$("stars").addEventListener("click", (e) => {
  const star = e.target.dataset.star;
  if (!star) return;
  form.elements.stars.value = form.elements.stars.value === star ? "" : star;
  paintStars();
});

/** 정보 팝업 위쪽에 사진을 크게 보여 준다 — 여러 장이면 좌우 버튼으로 넘긴다. 사진이 없으면 숨김 */
let heroImgs = [];
let heroAt = 0;
function showHero(imgs, at = 0) {
  const hero = $("hero");
  heroImgs = imgs;
  heroAt = at;
  hero.hidden = !imgs.length;
  hero.replaceChildren();
  showThumbs(imgs, at);
  if (!imgs.length) return;
  const img = el("img");
  img.alt = "";
  // 한 장뿐인데 못 불러오면 숨기고, 여러 장이면 넘길 수 있게 남겨 둔다
  img.addEventListener("error", () => (hero.hidden = imgs.length < 2));
  // 순서 바꾸기·빼기는 평소엔 접어 두고, 이 버튼을 눌렀을 때만 작은 사진 줄을 편다
  const edit = el("button", "hero-edit", editingImgs ? "편집 닫기" : "이미지 편집");
  edit.type = "button";
  edit.addEventListener("click", (e) => {
    e.stopPropagation();
    editingImgs = !editingImgs;
    showHero(imgs, at);
  });
  hero.append(img, edit);
  if (imgs.length > 1) {
    const nav = (className, label, text, step) => {
      const button = el("button", className, text);
      button.type = "button";
      button.ariaLabel = label;
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        showHero(imgs, (at + step + imgs.length) % imgs.length);
      });
      return button;
    };
    hero.append(
      nav("hero-prev", "이전 이미지", "‹", -1),
      nav("hero-next", "다음 이미지", "›", 1),
      el("div", "hero-count", `${at + 1} / ${imgs.length}`),
    );
  }
  showImage(img, imgs[at]);
}

/** 큰 사진 아래의 작은 사진 줄 — 누르면 그 사진을 보여 주고, 끌어다 놓으면 순서를 바꾸고, ×로 뺀다. 바뀐 목록은 주소 칸에 반영한다 */
let editingImgs = false;
function showThumbs(imgs, at) {
  const thumbs = $("thumbs");
  thumbs.hidden = !imgs.length || !editingImgs;
  thumbs.replaceChildren();
  const apply = (next, show) => {
    form.elements.imgs.value = next.join("\n");
    showHero(next, Math.min(show, next.length - 1));
  };
  let from = -1;
  imgs.forEach((url, i) => {
    const cell = el("div", i === at ? "thumb on" : "thumb");
    cell.draggable = true;
    cell.title = "끌어서 순서 바꾸기 (맨 앞이 대표)";
    const img = el("img");
    img.alt = "";
    const remove = el("button", "", "×");
    remove.type = "button";
    remove.title = "이 이미지 빼기";
    remove.ariaLabel = `이미지 ${i + 1} 빼기`;
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      apply(imgs.filter((_, j) => j !== i), i < at ? at - 1 : at);
    });
    cell.append(img, remove);
    cell.addEventListener("click", () => showHero(imgs, i));
    cell.addEventListener("dragstart", () => (from = i));
    cell.addEventListener("dragover", (e) => {
      e.preventDefault();
      cell.classList.add("over");
    });
    cell.addEventListener("dragleave", () => cell.classList.remove("over"));
    cell.addEventListener("drop", (e) => {
      e.preventDefault();
      if (from < 0 || from === i) return cell.classList.remove("over");
      const next = [...imgs];
      next.splice(i, 0, ...next.splice(from, 1));
      apply(next, i);
    });
    thumbs.append(cell);
    showImage(img, url);
  });
}

const formImgs = () => cleanImgs(form.elements.imgs.value.split("\n"));

// 정보 팝업의 사진을 누르면 보던 장부터 더 크게 보여 준다 — 좌우 버튼·방향키로 넘긴다
const viewer = $("viewer");
let viewerImgs = [];
let viewerAt = 0;
function showViewer(step = 0) {
  viewerAt = (viewerAt + step + viewerImgs.length) % viewerImgs.length;
  showImage($("viewer-img"), viewerImgs[viewerAt]);
  $("viewer-count").textContent = `${viewerAt + 1} / ${viewerImgs.length}`;
  for (const id of ["viewer-prev", "viewer-next", "viewer-count"]) $(id).hidden = viewerImgs.length < 2;
}
$("hero").addEventListener("click", () => {
  viewerImgs = heroImgs;
  viewerAt = heroAt;
  showViewer();
  viewer.showModal();
});
$("viewer-prev").addEventListener("click", () => showViewer(-1));
$("viewer-next").addEventListener("click", () => showViewer(1));
viewer.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") showViewer(-1);
  if (e.key === "ArrowRight") showViewer(1);
});
// 사진이나 바깥을 누르면 닫는다
viewer.addEventListener("click", (e) => {
  if (e.target === viewer || e.target === $("viewer-img")) viewer.close();
});

// 팝업을 연 뒤 수정한 내용이 있는지 가리기 위해 열 때의 입력값을 기억한다
const formState = () => JSON.stringify([...FIELDS, "imgs"].map((f) => form.elements[f].value));
let openedState = "";

function openForm(watch) {
  editingId = watch.id;
  editingImgs = false;
  form.reset();
  for (const f of FIELDS) form.elements[f].value = MONEY.includes(f) ? commas(watch[f]) : watch[f] ?? "";
  // 예전에 일자까지 저장된 구매일은 연월만 남긴다
  form.elements.date.value = (watch.date ?? "").slice(0, 7);
  paintStars();
  form.elements.imgs.value = imgsOf(watch).join("\n");
  showHero(imgsOf(watch));
  openedState = formState();
  dialog.showModal();
  dialog.scrollTop = 0;
}

/** 저장할 모양으로 — 예전 img는 imgs로 옮기고, 이제 안 쓰는 srcs는 버린다 */
function stored(watch) {
  const { img, srcs, ...rest } = watch;
  return { ...rest, imgs: imgsOf(watch), updatedAt: Date.now() };
}

function save(watch) {
  return dbSet({ [PREFIX + watch.id]: stored(watch) });
}

/** 저장 실패 사유를 읽을 수 있는 말로 — 크롬 동기화는 전체 약 100KB, 시계 하나 8KB까지 */
function saveError(e) {
  const message = String(e?.message ?? e);
  if (/QUOTA_BYTES_PER_ITEM/.test(message)) return "저장 실패: 이 시계의 정보가 너무 깁니다. 메모나 이미지 주소를 줄여 주세요";
  if (/QUOTA_BYTES/.test(message)) return "저장 실패: 동기화 용량이 가득 찼습니다. 안 쓰는 시계나 이미지를 줄여 주세요";
  if (/MAX_WRITE|MAX_SUSTAINED/.test(message)) return "저장 실패: 짧은 시간에 너무 많이 저장했습니다. 잠시 뒤 다시 시도해 주세요";
  return `저장 실패: ${message}`;
}

form.addEventListener("submit", async (e) => {
  // 저장에 성공했을 때만 닫는다 — 실패하면 입력한 내용을 그대로 둔 채 알린다
  e.preventDefault();
  const watch = { id: editingId };
  for (const f of FIELDS) {
    const value = form.elements[f].value.trim();
    watch[f] = MONEY.includes(f) ? value.replace(/\D/g, "") : value;
  }
  watch.imgs = formImgs();
  if (watch.list !== "dream") watch.hidden = "";
  const old = watches.find((w) => w.id === watch.id);
  const oldImgs = imgsOf(old);
  try {
    await save(watch);
  } catch (err) {
    return toast(saveError(err));
  }
  dialog.close();
  oldImgs.filter((v) => !watch.imgs.includes(v)).forEach(imgDelete);
  currentList = watch.list;
  render();
  cacheImages([watch]);
});

// 보유/드림 구분은 프롬프트에 심어 AI가 JSON에 그대로 담아 오게 한다
const prompt = (list) => `위 시계의 정보를 아래 JSON 배열 형식으로만 정리해줘. 설명 없이 코드 블록 하나로 출력해.

[
  {
    "list": "${list}",
    "brand": "",
    "model": "",
    "price": null,
    "diameter": null,
    "thickness": null,
    "lug": null,
    "weight": null,
    "weightNote": "",
    "movement": "",
    "reserve": null,
    "material": "",
    "water": null,
    "released": null,
    "note": "",
    "imgs": []
  }
]

필드 규칙:
- list: "${list}" 그대로 둘 것
- brand: 브랜드 영문 정식 표기
- model: 모델명 (브랜드명 제외). 레퍼런스 번호가 있는 모델이면 모델명 뒤에 붙여 표기 (예: Submariner 124060), 없으면 모델명만
- price: 한국 원화 기준 정수, 모르면 null
- diameter, thickness, lug: 케이스 직경, 두께, 러그 투 러그. mm 단위 숫자, 확인 못 하면 null. 러그 투 러그는 공식 표기가 없으면 시계 매체 리뷰의 실측값 사용
- weight: 무게. g 단위 숫자, 확인 못 하면 null. 공식 표기가 없으면 시계 매체 리뷰의 실측값 사용
- weightNote: weight를 잰 기준 (예: 브레이슬릿 포함, 헤드만, 러버 스트랩 포함). 30자 이내, weight가 null이거나 기준을 모르면 빈 문자열
- movement: 구동 방식과 칼리버 (예: 오토매틱 Cal. 3230)
- reserve: 파워리저브. 시간 단위 숫자, 확인 못 하면 null
- material: 케이스 소재 (예: 스테인리스 스틸)
- water: 방수 성능. m 단위 숫자, 확인 못 하면 null
- released: 이 레퍼런스가 처음 출시된 연도. 4자리 숫자, 확인 못 하면 null. 모델 라인의 최초 출시 연도가 아님
- note: 위 항목 외 특징 한두 문장 (200자 이내)
- imgs: 필수. 웹 검색으로 찾은 이 시계 사진의 이미지 파일 직접 주소(https)를 담은 배열. 가져온 뒤 직접 골라낼 것이므로 후보를 넉넉히, 가능하면 6개 이상(최대 ${MAX_IMGS}개) 담을 것. 브랜드 공식 사이트를 먼저 보고, 모자라면 공인 판매처·시계 매체에서 보충
  1) 첫 번째는 반드시 시계 하나만 정면으로 찍힌 흰색 배경의 제품 사진 (다이얼이 정면, 시계 전체가 잘리지 않음). 공식 사이트의 해당 레퍼런스 제품 페이지 대표 이미지에서 먼저 찾고, 없을 때만 밝은 단색 배경의 정면 사진으로 대체. 케이스백·측면·클로즈업·연출 사진은 첫 번째로 쓰지 말 것
  2) 순서: 두 번째는 케이스백(뒷면), 세 번째부터는 그 외 각도 (측면, 다이얼 클로즈업, 브레이슬릿·버클, 비스듬한 각도). 케이스백이 없으면 건너뛸 것. 두 번째부터는 흰색 배경이 아니어도 됨
  3) 모두 같은 레퍼런스·같은 색상의 사진만. 착용샷, 여러 개가 함께 찍힌 사진, 로고·문구·가격·워터마크가 덧붙은 이미지는 제외. 같은 사진을 크기만 달리해 여러 번 넣지 말 것
  4) 주소에 크기 지정(w=, width=, resize, 300x300 등)이 있으면 가장 큰 버전의 주소로
값 채우는 방법:
- 기억으로 답하지 말고 웹 검색으로 확인할 것. 브랜드 공식 사이트의 스펙 → 공인 판매처 → 시계 매체 리뷰 순으로 찾기
- 검색해도 출처에서 확인하지 못한 항목만 비울 것 (숫자는 null, 문자는 ""). 검색해 보지 않고 비우지 말 것
- 비슷한 모델·이전 세대·다른 사이즈의 값으로 추정하지 말고, 같은 레퍼런스의 값만 쓸 것
- 출력 전에 imgs의 첫 번째 사진이 1)을 만족하는지 다시 확인하고, 뒤쪽에 더 맞는 사진이 있으면 맨 앞으로 옮길 것
- 확실하지 않은 값은 지어내지 말 것. 단 imgs는 비워두지 말고, 주소를 지어내지도 말 것`;

const importDialog = $("import-dialog");
let importItems = [];

const clip = (v, max) => String(v ?? "").trim().slice(0, max);
/** "41mm", 41 같은 값에서 숫자만 뽑아 정보 창과 같은 자릿수로 맞춘 문자열로 */
const num = (v, digits = 2) => {
  const found = String(v ?? "").match(/\d+(\.\d+)?/)?.[0];
  return found ? String(Number(Number(found).toFixed(digits))) : "";
};
const dedupKey = (w) => `${w.brand}|${w.model}`.toLowerCase();

/** 코드 펜스·앞뒤 설명이 섞인 텍스트에서 JSON 부분만 골라 시계 목록으로 변환 */
function parseWatches(text) {
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
  if (start < 0 || end < start) throw new Error("JSON을 찾지 못했습니다");

  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("JSON 형식이 올바르지 않습니다");
  }

  const items = (Array.isArray(data) ? data : [data])
    .filter((raw) => raw && typeof raw === "object")
    .map((raw) => ({
      // 전체 복사로 뽑은 JSON처럼 구분·구매 정보가 들어 있으면 그대로 살린다
      list: ["owned", "dream"].includes(raw.list)
        ? raw.list
        : currentList,
      brand: clip(raw.brand, 50),
      model: clip(raw.model, 80),
      price:
        typeof raw.price === "number"
          ? String(Math.round(raw.price))
          : String(raw.price ?? "").replace(/\D/g, ""),
      diameter: num(raw.diameter),
      thickness: num(raw.thickness),
      lug: num(raw.lug),
      weight: num(raw.weight),
      weightNote: clip(raw.weightNote, 30),
      movement: clip(raw.movement, 60),
      reserve: num(raw.reserve, 0),
      material: clip(raw.material, 40),
      water: num(raw.water, 0),
      released: String(raw.released ?? "").match(/\b(18|19|20)\d{2}\b/)?.[0] ?? "",
      date: /^\d{4}-\d{2}/.test(raw.date) ? raw.date.slice(0, 7) : "",
      method: clip(raw.method, 30),
      paid: String(raw.paid ?? "").replace(/\D/g, ""),
      soldDate: /^\d{4}-\d{2}/.test(raw.soldDate) ? raw.soldDate.slice(0, 7) : "",
      soldPrice: String(raw.soldPrice ?? "").replace(/\D/g, ""),
      soldNote: clip(raw.soldNote, 40),
      imgs: cleanImgs([raw.imgs, raw.img].flat()),
      note: clip(raw.note, 500),
      stars: ["1", "2", "3"].includes(String(raw.stars)) ? String(raw.stars) : "",
      hidden: raw.hidden ? "1" : "",
    }))
    .filter((w) => w.brand && w.model);
  if (!items.length) throw new Error("브랜드·모델이 있는 항목이 없습니다");
  return items;
}

// 가져올 사진은 미리보기에서 실제로 열어 보고, 안 열리거나 너무 작은 것은 뺀다
const MIN_IMG = 600;
// 주소가 달라도 같은 사진인지 가리려고 사진을 작게 줄인 밝기 지문을 만든다.
// 크기·여백이 달라도 같게 나오도록 흰 여백을 잘라 낸 내용 부분만 HASH×HASH칸으로 평균 낸다
const HASH = 16;
const HASH_SRC = 128;
// 칸별 밝기 차이의 평균(0~255)이 이 값 이하면 같은 사진으로 본다
const SAME_IMG = 12;
/** 사진의 생김새 지문. 못 받아 오면 null */
async function imgHash(url) {
  try {
    const blob =
      (await imgGet(url).catch(() => null)) ?? (await (await fetch(url, { signal: AbortSignal.timeout(10000) })).blob());
    const bitmap = await createImageBitmap(blob);
    const ctx = new OffscreenCanvas(HASH_SRC, HASH_SRC).getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, HASH_SRC, HASH_SRC);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, HASH_SRC, HASH_SRC);
    const { data } = ctx.getImageData(0, 0, HASH_SRC, HASH_SRC);
    const gray = new Float32Array(HASH_SRC * HASH_SRC);
    for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
    // 흰색이 아닌 내용이 들어 있는 범위. 너무 작으면(거의 흰 사진) 전체를 쓴다
    let [x0, y0, x1, y1] = [HASH_SRC, HASH_SRC, -1, -1];
    for (let y = 0; y < HASH_SRC; y++) {
      for (let x = 0; x < HASH_SRC; x++) {
        if (gray[y * HASH_SRC + x] > 235) continue;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
    if (x1 - x0 < HASH || y1 - y0 < HASH) [x0, y0, x1, y1] = [0, 0, HASH_SRC - 1, HASH_SRC - 1];
    const cells = [];
    for (let cy = 0; cy < HASH; cy++) {
      for (let cx = 0; cx < HASH; cx++) {
        const left = x0 + Math.floor(((x1 - x0 + 1) * cx) / HASH);
        const right = x0 + Math.floor(((x1 - x0 + 1) * (cx + 1)) / HASH);
        const top = y0 + Math.floor(((y1 - y0 + 1) * cy) / HASH);
        const bottom = y0 + Math.floor(((y1 - y0 + 1) * (cy + 1)) / HASH);
        let sum = 0;
        for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) sum += gray[y * HASH_SRC + x];
        cells.push(sum / ((bottom - top) * (right - left)));
      }
    }
    return cells;
  } catch {
    return null;
  }
}
const sameImg = (a, b) => !!a && !!b && a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length <= SAME_IMG;

/** 시계별로 저장할 사진 — 고른 순서대로의 주소 목록 */
let importOrders = [];

/**
 * 시계 하나의 사진 고르기 화면(사진 고르기 팝업에 끼워 넣는다). 누른 순서대로 번호가 붙고(1번이 대표) 다시 누르면 빠진다.
 * order는 고른 주소 목록, kept는 이미 저장돼 있던 사진, onChange는 고른 사진이 바뀔 때 부른다
 */
function pickPanel(w, order, kept, onChange) {
  // 주소 → { state: "loading" | "ok" | "small" | "broken", size, kept, hash, dup }
  const picks = new Map();
  const cells = new Map();
  const drop = (url) => {
    const at = order.indexOf(url);
    if (at >= 0) order.splice(at, 1);
  };
  const paint = () => {
    for (const [url, cell] of cells) {
      const pick = picks.get(url);
      const no = order.indexOf(url) + 1;
      cell.classList.toggle("on", no > 0);
      cell.classList.toggle("cover", no === 1);
      cell.querySelector(".pick-no").textContent = no || "";
      const size = pick.size ? `${pick.size}px` : "";
      cell.querySelector(".pick-note").textContent =
        pick.state === "loading" ? "확인 중" : pick.state === "broken" ? "안 열림" : pick.dup ? `중복 ${size}` : size;
    }
    onChange();
  };
  // 다 열어 본 뒤 새 사진 중 앞 사진과 같은 것, 작은 것을 빼고(쓸 사진이 하나도 없으면 가장 큰 한 장은 남김), 최대 장수를 넘는 뒤쪽 새 사진도 뺀다
  const settle = () => {
    const all = w.imgs.map((url) => ({ url, ...picks.get(url) }));
    if (all.some((p) => p.state === "loading" || p.hash === undefined)) return paint();
    all.forEach((p, at) => {
      if (p.kept || p.state === "broken") return;
      p.dup = all.slice(0, at).some((q) => q.state !== "broken" && sameImg(p.hash, q.hash));
      picks.get(p.url).dup = p.dup;
      if (p.dup) drop(p.url);
    });
    const small = all.filter((p) => !p.kept && p.state === "small" && !p.dup).sort((a, b) => b.size - a.size);
    if (!all.some((p) => p.kept || (p.state === "ok" && !p.dup))) small.shift();
    for (const p of small) drop(p.url);
    for (const url of order.filter((url) => !kept.has(url)).reverse().slice(0, Math.max(0, order.length - MAX_IMGS))) drop(url);
    paint();
  };

  const row = (label, urls) => {
    const node = el("div", "picks-row");
    if (label) node.append(el("div", "picks-label", label));
    for (const url of urls) {
      // 기존 사진은 자동으로 빼지 않는다 — 빼면 저장할 때 기기에서도 지워지므로 직접 고를 때만
      const pick = { state: "loading", size: 0, kept: kept.has(url) };
      picks.set(url, pick);
      // 기존 사진이 있는 시계는 기존 것만 골라 두고, 새 사진은 직접 누를 때만 넣는다
      if (pick.kept || !kept.size) order.push(url);
      const img = el("img");
      img.alt = "";
      img.addEventListener("load", () => {
        pick.size = Math.max(img.naturalWidth, img.naturalHeight);
        pick.state = pick.size < MIN_IMG ? "small" : "ok";
        settle();
      }, { once: true });
      img.addEventListener("error", () => {
        pick.state = "broken";
        if (!pick.kept) drop(url);
        settle();
      }, { once: true });
      const toggle = el("button", "pick-img");
      toggle.type = "button";
      toggle.title = "누른 순서대로 번호가 붙습니다 (1번이 대표). 다시 누르면 빠집니다";
      toggle.append(img, el("span", "pick-no"));
      toggle.addEventListener("click", () => {
        if (order.includes(url)) drop(url);
        else if (pick.state === "broken" && !pick.kept) return;
        else if (order.length >= MAX_IMGS) return toast(`이미지는 ${MAX_IMGS}개까지 넣을 수 있습니다`);
        else order.push(url);
        paint();
      });
      // 마우스를 올리거나 포커스한 사진을 팝업 오른쪽에 크게 보여 준다
      for (const type of ["mouseenter", "focus"]) toggle.addEventListener(type, () => showImage($("pick-big"), url, false));
      const cell = el("div", "pick");
      cell.append(toggle, el("div", "pick-note"));
      cells.set(url, cell);
      node.append(cell);
      showImage(img, url, false);
      imgHash(url).then((hash) => {
        pick.hash = hash;
        settle();
      });
    }
    return node;
  };

  const clear = el("button", "", "선택 해제");
  clear.type = "button";
  clear.addEventListener("click", () => {
    order.length = 0;
    paint();
  });
  const head = el("div", "picks-head", "누른 순서대로 저장 · 1번이 대표");
  head.append(clear);
  const strip = el("div", "picks");
  strip.append(head);
  // 덮어쓸 시계는 기존 사진과 새 사진을 묶음을 나눠 보여 준다
  const fresh = w.imgs.filter((url) => !kept.has(url));
  if (kept.size) strip.append(row("기존", [...kept]));
  if (fresh.length) strip.append(row(kept.size ? "새 이미지" : "", fresh));
  paint();
  return strip;
}

function previewImport() {
  const text = $("import-text").value.trim();
  const error = $("import-error");
  importItems = [];
  error.hidden = true;
  if (text) {
    try {
      importItems = parseWatches(text);
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    }
  }

  const existing = new Map(watches.map((w) => [dedupKey(w), w]));
  importOrders = importItems.map(() => []);
  $("import-list").replaceChildren(
    ...importItems.map((w, i) => {
      const dup = existing.has(dedupKey(w));
      // 덮어쓸 시계는 저장돼 있던 사진을 앞에 두고 새 사진과 함께 고르게 한다
      const old = existing.get(dedupKey(w));
      const kept = new Set(imgsOf(old));
      w.imgs = [...kept, ...w.imgs.filter((url) => !kept.has(url))];
      const box = el("input");
      box.type = "checkbox";
      box.checked = true;
      box.addEventListener("change", updateImportSave);

      const row = el("label", "row");
      row.append(
        box,
        el("span", "row-main", `${w.brand} ${w.model}`),
        el("span", "row-sub", w.price && won(w.price)),
        el("span", dup ? "badge dup" : "badge", dup ? "덮어쓰기" : w.list === "owned" ? "보유" : "드림"),
      );
      const li = el("li");
      li.append(row);
      if (w.imgs.length) {
        // 사진은 별도 팝업에서 고르고, 목록엔 대표 사진과 고른 장수만 보여 준다
        const order = importOrders[i];
        const open = el("button", "picks-open");
        open.type = "button";
        const thumb = el("img");
        thumb.alt = "";
        const count = el("span");
        open.append(thumb, count);
        let cover;
        const panel = pickPanel(w, order, kept, () => {
          count.textContent = `이미지 ${order.length}개 선택 · 고르기`;
          thumb.hidden = !order.length;
          if (order[0] && order[0] !== cover) showImage(thumb, order[0], false);
          cover = order[0];
        });
        open.addEventListener("click", () => {
          $("pick-title").textContent = `${w.brand} ${w.model}`;
          $("pick-panel").replaceChildren(panel);
          if (order[0]) showImage($("pick-big"), order[0], false);
          $("pick-dialog").showModal();
        });
        li.append(open);
      }
      return li;
    }),
  );
  updateImportSave();
}

function updateImportSave() {
  const n = $("import-list").querySelectorAll("input:checked").length;
  $("import-save").disabled = n === 0;
  $("import-save").textContent = n ? `${n}개 저장` : "저장";
}

function openImport(text = "") {
  $("import-text").value = text;
  previewImport();
  importDialog.showModal();
}

/** 보유 시계에 적어 둔 가격은 덮어쓰기로 바꾸지 않는다 — 가져온 가격은 현재 시세라 다를 수 있다 */
const keptPrice = (old) => (old.list === "owned" && old.price ? { price: old.price } : {});

async function saveImport() {
  const boxes = [...$("import-list").querySelectorAll("input")];
  const picked = importItems
    .map((w, i) => ({ ...w, imgs: importOrders[i].slice(0, MAX_IMGS) }))
    .filter((_, i) => boxes[i].checked);
  // 이미 등록된 시계는 덮어쓴다 — 구분은 유지, 가져온 값이 빈 필드는 기존 값 유지, 사진은 미리보기에서 남긴 그대로
  const byKey = new Map(watches.map((w) => [dedupKey(w), w]));
  const entries = {};
  const replaced = [];
  let firstList;
  for (const w of picked) {
    const old = byKey.get(dedupKey(w));
    const filled = Object.fromEntries(Object.entries(w).filter(([, v]) => v.length));
    const merged = old
      ? { ...old, ...filled, imgs: w.imgs, list: old.list, ...keptPrice(old) }
      : { ...w, id: crypto.randomUUID() };
    replaced.push(...imgsOf(old).filter((v) => !imgsOf(merged).includes(v)));
    entries[PREFIX + merged.id] = stored(merged);
    firstList ??= merged.list;
  }
  try {
    await dbSet(entries);
  } catch (e) {
    $("import-error").textContent = saveError(e);
    $("import-error").hidden = false;
    return;
  }
  currentList = firstList;
  importDialog.close();
  render();
  replaced.forEach(imgDelete);
  cacheImages(Object.values(entries));
}

$("import").addEventListener("click", () => openImport());
$("import-text").addEventListener("input", previewImport);
$("import-save").addEventListener("click", saveImport);
$("import-cancel").addEventListener("click", () => importDialog.close());
$("pick-close").addEventListener("click", () => $("pick-dialog").close());

// 숨은 기능: 가져오기 제목을 누르면 저장된 시계 전체를 JSON으로 복사
const exportDialog = $("export-dialog");
$("import-title").addEventListener("click", () => {
  $("export-text").textContent = `저장된 시계 ${watches.length}개의 정보를 JSON으로 복사할까요?`;
  exportDialog.showModal();
});
$("export-no").addEventListener("click", () => exportDialog.close());
$("export-yes").addEventListener("click", async () => {
  await navigator.clipboard.writeText(JSON.stringify(watches, null, 2));
  exportDialog.close();
  toast("복사했습니다");
});
/** 정보 팝업에 열린 시계를 다시 채우는 프롬프트 — 덮어쓰기로 매칭되도록 표기를 고정시킨다 */
function refreshPrompt() {
  const w = watches.find((x) => x.id === editingId);
  return `${prompt(w.list).replace("위 시계의", `시계 '${w.brand} ${w.model}'의`)}
brand는 "${w.brand}", model은 "${w.model}"로 위 규칙보다 우선해서 글자 그대로 사용해.`;
}

function copyButton(id, getText) {
  const button = $(id);
  const label = button.textContent;
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(getText());
    button.textContent = "복사됨";
    setTimeout(() => (button.textContent = label), 1500);
  });
}
const promptDialog = $("prompt-dialog");
$("copy-prompt").addEventListener("click", () => promptDialog.showModal());
/** 팝업 바깥(배경)을 눌렀는지 */
const onBackdrop = (target, e) => {
  const box = target.getBoundingClientRect();
  return e.target === target && !(e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom);
};
// 팝업 안에서 누른 채 바깥으로 끌고 나가 놓은 것(글자 선택, 사진 끌기)은 바깥 클릭으로 치지 않는다
let pressedOutside = false;
document.addEventListener("pointerdown", (e) => (pressedOutside = e.target instanceof HTMLDialogElement && onBackdrop(e.target, e)), true);
const clickedOutside = (target, e) => pressedOutside && onBackdrop(target, e);
// 프롬프트 고르기·필터·사진 고르기·도움말·버전 팝업은 바깥을 누르면 닫는다
for (const target of [promptDialog, $("brand-dialog"), $("star-dialog"), $("price-dialog"), $("pick-dialog"), $("help-dialog"), $("about-dialog"), $("welcome-dialog")]) {
  target.addEventListener("click", (e) => {
    if (clickedOutside(target, e)) target.close();
  });
}
for (const name of ["brand", "star", "price"]) {
  $(`${name}-close`).addEventListener("click", () => $(`${name}-dialog`).close());
}
// 정보 팝업도 바깥을 누르면 닫되, 수정한 내용이 있으면 닫지 않는다
dialog.addEventListener("click", (e) => {
  if (!clickedOutside(dialog, e)) return;
  if (formState() === openedState) dialog.close();
  else toast("수정한 내용이 있습니다. 저장하거나 취소를 눌러 주세요");
});
for (const button of promptDialog.querySelectorAll("[data-prompt]")) {
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(prompt(button.dataset.prompt));
    promptDialog.close();
    toast(`${button.textContent}용 프롬프트를 복사했습니다`);
  });
}
copyButton("copy-refresh", refreshPrompt);

$("cancel").addEventListener("click", () => dialog.close());
const confirmDialog = $("confirm-dialog");
$("delete").addEventListener("click", () => {
  const watch = watches.find((w) => w.id === editingId);
  $("confirm-text").textContent = `${watch.brand} ${watch.model} 시계를 삭제할까요? 되돌릴 수 없습니다.`;
  confirmDialog.showModal();
});
$("confirm-no").addEventListener("click", () => confirmDialog.close());
$("confirm-yes").addEventListener("click", async () => {
  imgsOf(watches.find((w) => w.id === editingId)).forEach(imgDelete);
  await dbRemove(editingId);
  confirmDialog.close();
  dialog.close();
});

// 제목을 누르면 버전·설치 또는 업데이트한 날·동기화 상태를 보여 준다
$("title").addEventListener("click", async () => {
  // 버전은 파일에서 읽는다 — 확장을 다시 불러오기 전에는 크롬이 예전 버전을 들고 있다
  const [{ installedAt }, { version }] = await Promise.all([
    chrome.storage.local.get("installedAt"),
    fetch(chrome.runtime.getURL("manifest.json")).then((r) => r.json()),
  ]);
  const rows = [
    ["버전", version],
    ["업데이트일", installedAt ? new Date(installedAt).toLocaleDateString("ko-KR") : "-"],
  ];
  // 동기화는 신호등과 방식만 — 자세한 상태는 동기화 설정에서
  syncUsed = await chrome.storage.sync.getBytesInUse(null);
  const [color, text] = syncSignal();
  const light = el("span", "light");
  light.dataset.state = color;
  const open = el("button", "about-sync");
  open.type = "button";
  open.title = `${text} — 누르면 동기화 설정`;
  open.append(light, `${gh ? "GitHub 스토리지" : "크롬 계정"} ›`);
  open.addEventListener("click", openSync);
  const sync = el("dd");
  sync.append(open);
  $("about").replaceChildren(...rows.flatMap(([label, value]) => [el("dt", "", label), el("dd", "", value)]), el("dt", "", "동기화"), sync);
  $("about-dialog").showModal();
});
$("about-close").addEventListener("click", () => $("about-dialog").close());

$("help").addEventListener("click", () => {
  $("about-dialog").close();
  $("help-dialog").showModal();
  $("help-dialog").scrollTop = 0;
});
$("help-close").addEventListener("click", () => $("help-dialog").close());

$("welcome-close").addEventListener("click", () => $("welcome-dialog").close());
$("welcome-import").addEventListener("click", () => {
  $("welcome-dialog").close();
  openImport();
});
$("welcome-help").addEventListener("click", () => {
  $("welcome-dialog").close();
  $("help-dialog").showModal();
  $("help-dialog").scrollTop = 0;
});

/** 화면에 보이지 않는 자세한 도움말을 AI에 붙여넣어 물어볼 수 있는 프롬프트로 만든다 */
function helpPrompt() {
  const lines = [];
  for (const node of $("help-full").content.children) {
    if (node.tagName === "H3") lines.push("", `## ${node.textContent}`);
    else [...node.children].forEach((li, i) => lines.push(`${node.tagName === "OL" ? `${i + 1}.` : "-"} ${li.textContent.trim()}`));
  }
  return `너는 크롬 확장 프로그램 "Watch Box"의 사용 안내 도우미야. Watch Box는 보유 시계와 드림 워치(갖고 싶은 시계)를 관리하는 프로그램이고, 만든 사람은 OBJECT_a야. 아래 [도움말]만을 근거로 내 질문에 답해 줘.

규칙:
- 도움말에 없는 기능은 지어내지 말고 도움말에 없는 내용이라고 말할 것. 이어서 도움말의 [문의] 창구를 알려 주고, 내가 원하면 그대로 붙여넣을 수 있는 문의 글 초안을 써 줄 것
- 화면의 버튼·항목 이름은 도움말에 적힌 그대로 쓸 것
- 답은 짧게, 따라 할 순서가 있으면 번호 목록으로
- 이 메시지에는 Watch Box가 무엇인지 두 문장 이내로 소개하고, 처음 쓰는 사람이 할 일 3단계를 알려 준 뒤 무엇이 궁금한지 물어볼 것

[도움말]${lines.join("\n")}`;
}
copyButton("copy-help", helpPrompt);

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    currentList = tab.dataset.list;
    render();
  });
}

// 이 페이지의 저장·삭제와 다른 기기에서 온 동기화 변경을 모두 여기서 반영
chrome.storage.onChanged.addListener((changes, area) => {
  // 다른 기기에서 동기화 방식을 바꿨으면 새 방식으로 다시 연다
  if (area === "sync" && changes[GH_KEY]) {
    const next = changes[GH_KEY].newValue;
    if ((next?.repo ?? "") !== (gh?.repo ?? "") || (next?.token ?? "") !== (gh?.token ?? "")) return location.reload();
  }
  // 동기화로 시계가 여러 개 연달아 바뀌어도 화면은 한 번만 다시 그린다
  if (area === dbArea() && Object.keys(changes).some((key) => key.startsWith(PREFIX))) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 50);
  }
});
let reloadTimer = 0;

// 동기화 설정 — 크롬 계정(기본)과 GitHub 스토리지(고급)를 오간다
const syncDialog = $("sync-dialog");
// 크롬 계정 사용량 — 설정 창을 열 때 한 번 재 둔다
let syncUsed = 0;
/** 신호등: 초록 정상, 노랑 진행 중·주의, 빨강 오류 */
function syncSignal() {
  if (!gh) {
    const pct = Math.round((syncUsed / chrome.storage.sync.QUOTA_BYTES) * 100);
    if (pct >= 95) return ["red", `크롬 계정 용량이 거의 찼습니다 (${pct}%). 곧 저장이 실패합니다`];
    if (pct >= 80) return ["yellow", `크롬 계정 용량 ${pct}% 사용 — 여유가 많지 않습니다`];
    return ["green", `크롬 계정 용량 ${pct}% 사용`];
  }
  if (ghStatus.busy) return ["yellow", ghStatus.note || "동기화 중"];
  if (ghStatus.error) return ["red", `오류: ${ghStatus.error}`];
  const pending = ghState.dirty.size;
  if (pending) return ["yellow", `아직 올리지 않은 변경 ${pending}건`];
  if (!ghState.syncedAt) return ["yellow", "아직 동기화 전"];
  return ["green", `동기화됨 — ${new Date(ghState.syncedAt).toLocaleString("ko-KR")}`];
}
// 연결 해제는 한 번 더 눌러야 실행된다
let confirmingOff = false;
function paintSync() {
  const on = !!gh;
  if (on) {
    const repo = el("a", "", gh.repo);
    repo.href = `https://github.com/${gh.repo}`;
    repo.target = "_blank";
    $("sync-mode").replaceChildren("GitHub 스토리지 ", repo);
  } else {
    $("sync-mode").textContent = "크롬 계정 동기화 (기본)";
  }
  const [color, text] = syncSignal();
  $("sync-light").dataset.state = color;
  $("sync-status").textContent = text;
  $("sync-status").classList.toggle("error", color === "red");
  // 연결된 뒤에는 저장소를 못 바꾸고 토큰만 바꿀 수 있다 (만료된 토큰 교체용)
  $("sync-repo").disabled = on;
  $("sync-on").textContent = on ? "토큰 바꾸기" : "연결";
  // 연결된 뒤에는 토큰 칸을 고쳤을 때만 바꾸기 버튼이 나온다
  $("sync-on").hidden = on && $("sync-token").value.trim() === gh.token;
  $("sync-off").hidden = !on;
  $("sync-off").textContent = confirmingOff ? "해제 확인" : "연결 해제";
  $("sync-guide").hidden = on;
  $("sync-now").hidden = !on || ghStatus.busy;
}
/** 연결돼 있으면 저장소와 토큰 칸을 저장된 값으로 채운다 (토큰은 가려서 보인다) */
function fillSync() {
  $("sync-repo").value = gh?.repo ?? "";
  $("sync-token").value = gh?.token ?? "";
}
$("sync-token").addEventListener("input", paintSync);
// 동기화 알림 — 금방 끝나는 동기화는 조용히 넘기고, 오래 걸리면 진행 상황을, 끝나면 결과를 알린다
let shownSyncError = "";
let syncNoticeTimer = 0;
let syncNoticed = false;
onGhStatus = () => {
  paintSync();
  if (ghStatus.busy) {
    if (syncNoticed) toast(ghStatus.note || "동기화 중…");
    else if (!syncNoticeTimer) {
      syncNoticeTimer = setTimeout(() => {
        syncNoticeTimer = 0;
        if (!ghStatus.busy) return;
        syncNoticed = true;
        toast(ghStatus.note || "동기화 중…");
      }, 1500);
    }
    return;
  }
  clearTimeout(syncNoticeTimer);
  syncNoticeTimer = 0;
  if (ghStatus.error) {
    if (ghStatus.error !== shownSyncError) toast(`GitHub 동기화 실패: ${ghStatus.error}`);
  } else if (ghStatus.pulled) toast(`저장소에서 변경 ${ghStatus.pulled}건을 받았습니다`);
  else if (syncNoticed) toast("동기화 완료");
  syncNoticed = false;
  shownSyncError = ghStatus.error;
};
const syncFail = (text) => {
  $("sync-status").textContent = text;
  $("sync-status").classList.add("error");
};
async function openSync() {
  $("about-dialog").close();
  if (DEMO) return toast("체험 모드에서는 동기화 설정을 바꿀 수 없습니다");
  syncUsed = await chrome.storage.sync.getBytesInUse(null);
  fillSync();
  paintSync();
  syncDialog.showModal();
}
$("sync-close").addEventListener("click", () => syncDialog.close());
$("sync-now").addEventListener("click", () => ghSync());
$("sync-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const changing = !!gh;
  const repo = $("sync-repo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$|\/$/g, "");
  const token = $("sync-token").value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return syncFail("저장소는 계정/저장소 형식으로 적어 주세요 (예: my-account/watch-box-data)");
  if (!token) return syncFail("토큰을 넣어 주세요");
  $("sync-on").disabled = true;
  $("sync-status").classList.remove("error");
  $("sync-status").textContent = changing ? "새 토큰을 확인하는 중…" : "연결하는 중… 시계 정보를 저장소로 옮깁니다";
  try {
    await ghConnect(repo, token);
  } catch (err) {
    return syncFail(`연결 실패: ${err.message}`);
  } finally {
    $("sync-on").disabled = false;
  }
  await load();
  fillSync();
  paintSync();
  toast(changing ? "토큰을 바꿨습니다" : "GitHub 스토리지에 연결했습니다. 이미지 사본은 뒤에서 올립니다");
});
$("sync-off").addEventListener("click", async () => {
  if (!confirmingOff) {
    confirmingOff = true;
    paintSync();
    $("sync-status").textContent = "한 번 더 누르면 크롬 계정 동기화로 되돌립니다. 저장소의 파일은 그대로 남습니다";
    return setTimeout(() => {
      confirmingOff = false;
      paintSync();
    }, 6000);
  }
  confirmingOff = false;
  try {
    await ghDisconnect();
  } catch (err) {
    return syncFail(
      /QUOTA/.test(err.message)
        ? "크롬 계정 용량(약 100KB)을 넘어 되돌릴 수 없습니다. 시계를 줄이거나 GitHub 스토리지를 계속 쓰세요"
        : `연결 해제 실패: ${err.message}`,
    );
  }
  await load();
  syncUsed = await chrome.storage.sync.getBytesInUse(null);
  fillSync();
  paintSync();
  toast("크롬 계정 동기화로 되돌렸습니다. 저장소의 파일은 그대로 있습니다");
});

/** GitHub 저장소와 토큰을 만드는 과정을 AI에게 안내받는 프롬프트 */
const syncGuidePrompt = () => `크롬 확장 프로그램 "Watch Box"의 고급 기능인 GitHub 스토리지를 연결하려고 해. 나는 GitHub를 잘 모르니까, 아래 [해야 할 일]을 한 단계씩 따라 할 수 있게 안내해 줘.

안내 방법:
- 한 번에 한 단계만 알려 주고, 내가 "다음"이라고 하면 다음 단계로 넘어갈 것
- 단계마다 어느 화면에서 무엇을 누르는지 메뉴 이름을 그대로 적어 줄 것. GitHub 화면이 영어면 영어 메뉴 이름으로
- 내가 화면이 다르다고 하면 지금 보이는 것을 물어보고 맞춰서 안내할 것
- 토큰은 비밀번호와 같으니 너에게 붙여넣지 말라고 먼저 알려 줄 것

[해야 할 일]
1. github.com 계정 만들기 (이미 있으면 로그인)
2. 새 저장소 만들기: 이름은 자유 (예: watch-box-data), 반드시 Private(비공개)로. README 추가 여부는 상관없음
3. 세분화된 개인 액세스 토큰 만들기: 프로필 사진 → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token
   - Token name: 자유 (예: Watch Box)
   - Expiration: 원하는 기간. 만료되면 동기화가 멈추고, 새 토큰을 만들어 다시 연결해야 함
   - Repository access: Only select repositories → 2에서 만든 저장소 하나만 선택
   - Permissions → Repository permissions → Contents: Read and write (Metadata: Read-only는 자동으로 붙음). 다른 권한은 주지 않음
   - Generate token을 누르고 나온 토큰(github_pat_로 시작)을 복사. 이 화면을 벗어나면 다시 볼 수 없음
4. Watch Box에서 왼쪽 위 Watch Box 제목을 누르고, 뜨는 창의 동기화 줄을 눌러 동기화 설정을 열고, 저장소 칸에 "계정이름/저장소이름" (예: my-account/watch-box-data), 토큰 칸에 복사한 토큰을 넣고 연결
5. 연결되면 시계 정보가 저장소의 watches 폴더로, 이미지 사본이 images 폴더로 올라감. 같은 크롬 계정을 쓰는 다른 기기는 자동으로 같은 저장소를 쓰게 됨

참고로 알려 줄 것:
- 저장소가 Public이면 Watch Box가 연결을 거부함. 시계 정보와 구매가가 모두에게 보이기 때문
- 토큰은 크롬 계정 동기화에 저장되어 내 다른 기기로 전달됨
- 되돌리려면 동기화 설정에서 연결 해제. 저장소의 파일은 지워지지 않음`;
copyButton("sync-guide", syncGuidePrompt);

// AI 화면의 우클릭 메뉴로 넘어온 선택 텍스트가 있으면 가져오기 창을 연다
async function init() {
  await ghInit();
  await load();
  // GitHub 스토리지는 변경이 알아서 오지 않으므로 열 때와 다시 볼 때 맞춘다
  if (gh) ghSync();
  document.addEventListener("visibilitychange", () => {
    if (gh && document.visibilityState === "visible" && Date.now() - ghState.syncedAt > 60000) ghSync();
  });
  const { pendingImport } = await chrome.storage.session.get("pendingImport");
  if (pendingImport) {
    await chrome.storage.session.remove("pendingImport");
    openImport(pendingImport);
  } else if (!watches.length && !gh) {
    // 등록된 시계가 하나도 없으면 시작 안내를 띄운다
    $("welcome-dialog").showModal();
  }
  if (DEMO) toast("체험 모드 — 빈 상태로 열었습니다. 여기서 저장한 내용은 탭을 닫으면 사라지고 실제 데이터는 바뀌지 않습니다");
}

init();
