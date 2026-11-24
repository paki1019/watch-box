// 시계 정보 저장 계층. 기본은 크롬 계정 동기화(storage.sync, 약 100KB).
// 고급 기능인 GitHub 스토리지를 연결하면 기기의 작업 사본(storage.local)을 쓰고, 내 비공개 저장소와 맞춘다:
//   watches/<id>.json  시계 하나에 파일 하나
//   images/<주소 해시>.jpg  이미지 사본 — 주소가 죽어도 여기서 받는다
const PREFIX = "w:";
const GH_KEY = "gh"; // storage.sync: { repo, token } — 다른 기기에도 전달된다
const GH_STATE = "ghState"; // storage.local: 이 기기가 저장소와 어디까지 맞췄는지

let gh = null;
// shas: 마지막으로 맞춘 파일 버전, dirty: 올려야 할 시계
const ghState = { shas: {}, dirty: new Set(), syncedAt: 0 };
// 저장소에 사본이 있는 이미지 경로
let ghImgPaths = new Set();
// pulled: 이번 동기화에서 저장소로부터 받은 변경 수
const ghStatus = { busy: false, error: "", note: "", pulled: 0 };
let onGhStatus = () => {};

// 주소 끝에 ?demo 를 붙여 열면 빈 상태로 써 볼 수 있다 — 이 탭의 메모리에만 저장하고 실제 데이터는 건드리지 않는다
const DEMO = typeof location !== "undefined" && new URLSearchParams(location.search).has("demo");
const demoData = {};
const demoArea = {
  async get(query) {
    if (query == null) return { ...demoData };
    return Object.fromEntries([query].flat().filter((key) => key in demoData).map((key) => [key, demoData[key]]));
  },
  async set(entries) {
    Object.assign(demoData, structuredClone(entries));
    setTimeout(load);
  },
  async remove(query) {
    for (const key of [query].flat()) delete demoData[key];
    setTimeout(load);
  },
};

const dbArea = () => (gh ? "local" : "sync");
const db = () => (DEMO ? demoArea : chrome.storage[dbArea()]);
const idOf = (key) => key.slice(PREFIX.length);
const watchKeys = (all) => Object.keys(all).filter((k) => k.startsWith(PREFIX));

// 지운 시계는 없애지 않고 "지웠음" 표시만 남긴다 — 다른 기기의 수정과 겹치면 나중에 한 쪽이 이기게 하려고
const TOMB_DAYS = 30;
const tomb = (id) => ({ id, deleted: true, updatedAt: Date.now() });

/** 지운 표시를 뺀 시계 목록 */
async function dbAll() {
  const all = await db().get(null);
  return watchKeys(all)
    .map((k) => all[k])
    .filter((w) => !w.deleted);
}

async function dbSet(entries) {
  await db().set(entries);
  if (!gh) return;
  for (const key of Object.keys(entries)) ghState.dirty.add(idOf(key));
  await ghPersist();
  ghSoon();
}

/** 시계를 지운다 — 지운 표시로 바꿔 저장한다 */
const dbRemove = (id) => dbSet({ [PREFIX + id]: tomb(id) });

const ghPersist = () =>
  chrome.storage.local.set({
    [GH_STATE]: { shas: ghState.shas, dirty: [...ghState.dirty], syncedAt: ghState.syncedAt },
  });

/** 시작할 때 연결 정보와 이 기기의 맞춤 상태를 읽는다 */
async function ghInit() {
  if (DEMO) return;
  const { [GH_KEY]: conf } = await chrome.storage.sync.get(GH_KEY);
  gh = conf?.repo && conf?.token ? { repo: conf.repo, token: conf.token } : null;
  const { [GH_STATE]: saved } = await chrome.storage.local.get(GH_STATE);
  ghState.shas = saved?.shas ?? {};
  ghState.dirty = new Set(saved?.dirty);
  ghState.syncedAt = saved?.syncedAt ?? 0;
  // 크롬 계정은 용량이 작으므로 오래된 지운 표시는 치운다 (저장소에는 계속 남긴다)
  if (!gh) {
    const all = await chrome.storage.sync.get(null);
    const old = watchKeys(all).filter((k) => all[k].deleted && Date.now() - (all[k].updatedAt ?? 0) > TOMB_DAYS * 86400000);
    if (old.length) await chrome.storage.sync.remove(old);
  }
}

const ghReason = (status) =>
  status === 401 ? "GitHub 토큰이 만료됐거나 잘못됐습니다"
  : status === 403 ? "토큰에 이 저장소의 Contents 읽기·쓰기 권한이 없거나 요청 한도를 넘었습니다"
  : status === 404 ? "저장소를 찾을 수 없습니다 (이름이 틀렸거나 토큰이 이 저장소를 볼 수 없음)"
  : status === 409 || status === 422 ? "다른 기기에서 같은 파일이 바뀌었습니다. 다시 동기화하면 맞춰집니다"
  : `GitHub 응답 ${status}`;

function ghApi(path, { method = "GET", body, raw = false, conf = gh } = {}) {
  return fetch(`https://api.github.com/repos/${conf.repo}${path}`, {
    method,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${conf.token}`,
      Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body && JSON.stringify(body),
  });
}
const ghOk = (res) => {
  if (!res.ok) throw Object.assign(new Error(ghReason(res.status)), { status: res.status });
  return res;
};
// 파일을 올리는 사이 다른 기기가 같은 파일을 바꿨을 때의 응답
const ghConflict = (e) => e.status === 409 || e.status === 422;

/** 저장소의 파일 목록 (경로 → 버전). 빈 저장소면 빈 목록 */
async function ghTree() {
  gh.branch ??= (await ghOk(await ghApi("")).json()).default_branch;
  const res = await ghApi(`/git/trees/${encodeURIComponent(gh.branch)}?recursive=1`);
  if (res.status === 409 || res.status === 404) return new Map();
  const { tree } = await ghOk(res).json();
  return new Map(tree.filter((t) => t.type === "blob").map((t) => [t.path, t.sha]));
}

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** 파일을 올리고 새 버전을 돌려준다. sha는 덮어쓸 때의 기존 버전 */
async function ghPut(path, bytes, sha) {
  const res = await ghApi(`/contents/${encodeURI(path)}`, {
    method: "PUT",
    body: { message: `Update ${path}`, content: base64(bytes), ...(sha && { sha }) },
  });
  return (await ghOk(res).json()).content.sha;
}

async function ghDel(path, sha) {
  const res = await ghApi(`/contents/${encodeURI(path)}`, { method: "DELETE", body: { message: `Remove ${path}`, sha } });
  if (res.status !== 404) ghOk(res);
}

async function ghImgPath(url) {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(url));
  return `images/${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}.jpg`;
}

/** 저장소에 사본이 있는 이미지를 받아 온다. 없거나 못 받으면 null */
async function ghImage(url) {
  if (!gh) return null;
  const path = await ghImgPath(url);
  if (!ghImgPaths.has(path)) return null;
  const res = await ghApi(`/contents/${path}`, { raw: true }).catch(() => null);
  return res?.ok ? new Blob([await res.arrayBuffer()], { type: "image/jpeg" }) : null;
}

/** 저장소와 한 번 맞춘다 — 받을 것을 받고 올릴 것을 올린다. 같은 시계가 양쪽에서 바뀌었으면(지운 것도 수정으로 친다) 나중에 한 쪽을 남긴다 */
async function ghSyncOnce(withImages = true) {
  ghStatus.busy = true;
  ghStatus.note = "시계 정보를 맞추는 중";
  onGhStatus();
  const tree = await ghTree();
  ghImgPaths = new Set([...tree.keys()].filter((p) => p.startsWith("images/")));
  const remote = new Map();
  for (const [path, sha] of tree) {
    const id = /^watches\/(.+)\.json$/.exec(path)?.[1];
    if (id) remote.set(id, sha);
  }
  const all = await chrome.storage.local.get(null);
  const local = new Map(watchKeys(all).map((k) => [idOf(k), all[k]]));

  // 받기
  for (const [id, sha] of remote) {
    if (ghState.shas[id] === sha && local.has(id)) continue;
    const theirs = await ghOk(await ghApi(`/contents/watches/${id}.json`, { raw: true })).json();
    const mine = local.get(id);
    ghState.shas[id] = sha;
    if (mine && ghState.dirty.has(id) && (mine.updatedAt ?? 0) >= (theirs.updatedAt ?? 0)) continue;
    await chrome.storage.local.set({ [PREFIX + id]: theirs });
    local.set(id, theirs);
    ghState.dirty.delete(id);
    ghStatus.pulled++;
  }
  // 저장소에서 파일이 사라진 시계 (누군가 저장소에서 직접 지움)
  for (const id of [...local.keys()]) {
    if (remote.has(id)) continue;
    if (ghState.shas[id] && !ghState.dirty.has(id)) {
      await chrome.storage.local.remove(PREFIX + id);
      local.delete(id);
    } else {
      ghState.dirty.add(id);
    }
    delete ghState.shas[id];
  }
  await ghPersist();

  // 올리기
  for (const id of [...ghState.dirty]) {
    const watch = (await chrome.storage.local.get(PREFIX + id))[PREFIX + id];
    ghState.dirty.delete(id);
    if (!watch) continue;
    try {
      ghState.shas[id] = await ghPut(`watches/${id}.json`, new TextEncoder().encode(JSON.stringify(watch, null, 2)), ghState.shas[id]);
    } catch (e) {
      ghState.dirty.add(id);
      throw e;
    }
  }
  await ghPersist();

  if (withImages) await ghSyncImages(tree);
  ghState.syncedAt = Date.now();
  await ghPersist();
}

/** 시계에 쓰인 이미지 중 저장소에 없는 것을 올리고, 어느 시계도 안 쓰는 사본은 지운다 */
// 받아 오지 못한 이미지 주소 — 죽은 주소를 동기화할 때마다 다시 기다리지 않게 페이지를 연 동안 기억한다
const ghImgFailed = new Set();
async function ghSyncImages(tree) {
  const watches = await dbAll();
  const want = new Map();
  for (const url of new Set(watches.flatMap((w) => w.imgs ?? []))) {
    if (url.startsWith("https://")) want.set(await ghImgPath(url), url);
  }
  const missing = [...want].filter(([path, url]) => !ghImgPaths.has(path) && !ghImgFailed.has(url));
  let done = 0;
  for (const [path, url] of missing) {
    ghStatus.note = `이미지 사본을 올리는 중 ${++done}/${missing.length}`;
    onGhStatus();
    const blob = await imageBlob(url).catch(() => null);
    if (!blob) {
      ghImgFailed.add(url);
      continue;
    }
    // 다른 기기가 방금 같은 사본을 올렸으면 이미 있는 것이므로 넘어간다
    await ghPut(path, new Uint8Array(await blob.arrayBuffer())).catch((e) => {
      if (!ghConflict(e)) throw e;
    });
    ghImgPaths.add(path);
  }
  // 시계가 하나도 없을 때는 지우지 않는다 — 목록을 못 읽은 경우에 사본을 날리지 않게
  if (!watches.length) return;
  for (const path of [...ghImgPaths]) {
    if (want.has(path) || !tree.has(path)) continue;
    await ghDel(path, tree.get(path)).catch((e) => {
      if (!ghConflict(e)) throw e;
    });
    ghImgPaths.delete(path);
  }
}

// 동기화는 한 번에 하나만 돌린다. 도는 중에 다시 요청되면 끝난 뒤 한 번 더
let ghRunning = null;
let ghAgain = false;
function ghSync() {
  if (!gh) return Promise.resolve();
  if (ghRunning) {
    ghAgain = true;
    return ghRunning;
  }
  ghRunning = (async () => {
    ghStatus.pulled = 0;
    try {
      let retries = 0;
      do {
        ghAgain = false;
        try {
          await ghSyncOnce();
        } catch (e) {
          // 올리는 사이 다른 기기가 먼저 바꿨으면 다시 받아서 맞춘다
          if (!ghConflict(e) || ++retries > 2) throw e;
          ghAgain = true;
        }
      } while (ghAgain);
      ghStatus.error = "";
    } catch (e) {
      ghStatus.error = e.message;
    } finally {
      ghStatus.busy = false;
      ghStatus.note = "";
      ghRunning = null;
      onGhStatus();
    }
  })();
  return ghRunning;
}
let ghTimer;
const ghSoon = () => {
  clearTimeout(ghTimer);
  ghTimer = setTimeout(ghSync, 2000);
};

/** GitHub 스토리지로 전환 — 크롬 계정에 있던 시계를 기기 작업 사본으로 옮겨 저장소에 올리고, 크롬 계정에서는 비운다. 이미 연결돼 있으면 토큰만 바꾼다 */
async function ghConnect(repo, token) {
  const conf = { repo, token };
  const prev = gh;
  await ghRunning;
  const info = await ghOk(await ghApi("", { conf })).json();
  if (!info.private) throw new Error("비공개 저장소만 연결할 수 있습니다. 공개 저장소에 올리면 시계 정보와 구매가가 모두에게 보입니다");
  if (info.permissions?.push === false) throw new Error("토큰에 이 저장소의 쓰기 권한이 없습니다 (Contents: Read and write 필요)");

  const synced = await chrome.storage.sync.get(null);
  const keys = watchKeys(synced);
  const local = await chrome.storage.local.get(keys);
  const copy = {};
  for (const key of keys) {
    if (!local[key] || (local[key].updatedAt ?? 0) < (synced[key].updatedAt ?? 0)) copy[key] = synced[key];
  }
  await chrome.storage.local.set(copy);
  gh = conf;
  for (const key of keys) ghState.dirty.add(idOf(key));
  await ghPersist();
  try {
    await ghSyncOnce(false);
  } catch (e) {
    gh = prev;
    throw e;
  } finally {
    ghStatus.busy = false;
    ghStatus.note = "";
  }
  ghStatus.error = "";
  await chrome.storage.sync.set({ [GH_KEY]: conf });
  await chrome.storage.sync.remove(keys);
  // 이미지 사본은 뒤에서 올린다
  ghSync();
}

/** 크롬 계정 동기화로 되돌린다. 저장소의 파일은 그대로 둔다. 크롬 계정 용량을 넘으면 실패하고 아무것도 바꾸지 않는다 */
async function ghDisconnect() {
  await ghRunning;
  const all = await chrome.storage.local.get(null);
  const keys = watchKeys(all);
  // 지운 표시도 함께 옮긴다 — 해제한 동안에도 지운 것이 기억되게. 오래된 것은 뺀다
  const fresh = keys.filter((k) => !all[k].deleted || Date.now() - (all[k].updatedAt ?? 0) <= TOMB_DAYS * 86400000);
  await chrome.storage.sync.set(Object.fromEntries(fresh.map((k) => [k, all[k]])));
  gh = null;
  await chrome.storage.sync.remove(GH_KEY);
  await chrome.storage.local.remove([...keys, GH_STATE]);
  ghState.shas = {};
  ghState.dirty.clear();
  ghState.syncedAt = 0;
  ghImgPaths = new Set();
}
