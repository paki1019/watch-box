// sync.js(GitHub 스토리지 동기화)를 가짜 저장소·가짜 크롬 저장소로 두 기기 시나리오에 돌려 본다. 실행: node test/sync.test.js
const vm = require("vm"), fs = require("fs"), crypto = require("crypto");
const src = fs.readFileSync(process.argv[2] ?? require("path").join(__dirname, "../sync.js"), "utf8");
// 가짜 GitHub 저장소
const repo = { files: new Map(), private: true, calls: 0 };
const sha = (buf) => crypto.createHash("sha1").update(buf).digest("hex");
const json = (status, body) => ({ ok: status < 300, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
async function fakeFetch(url, init = {}) {
  repo.calls++;
  const path = url.replace("https://api.github.com/repos/o/r", "");
  if (init.headers.Authorization !== "Bearer good") return json(401, {});
  if (path === "") return json(200, { private: repo.private, default_branch: "main", permissions: { push: true } });
  if (path.startsWith("/git/trees/")) {
    if (!repo.files.size) return json(409, {});
    return json(200, { tree: [...repo.files].map(([p, f]) => ({ path: p, type: "blob", sha: f.sha })) });
  }
  const file = decodeURI(path.replace("/contents/", ""));
  const cur = repo.files.get(file);
  if (!init.method || init.method === "GET") {
    if (!cur) return json(404, {});
    return { ok: true, status: 200, json: async () => JSON.parse(cur.buf.toString()), arrayBuffer: async () => cur.buf.buffer.slice(cur.buf.byteOffset, cur.buf.byteOffset + cur.buf.length) };
  }
  const body = JSON.parse(init.body);
  if (init.method === "PUT") {
    // 올리는 순간 다른 기기가 먼저 바꾼 상황을 한 번 흉내 낸다
    if (repo.race === file) {
      repo.race = null;
      const buf = Buffer.from(JSON.stringify(repo.raceWith));
      repo.files.set(file, { buf, sha: sha(buf) });
      return json(409, {});
    }
    if (cur && body.sha !== cur.sha) return json(409, {});
    if (!cur && body.sha) return json(422, {});
    const buf = Buffer.from(body.content, "base64");
    repo.files.set(file, { buf, sha: sha(buf) });
    return json(200, { content: { sha: sha(buf) } });
  }
  if (init.method === "DELETE") {
    if (!cur) return json(404, {});
    if (body.sha !== cur.sha) return json(409, {});
    repo.files.delete(file);
    return json(200, {});
  }
}
const area = (data, quota) => ({
  data,
  async get(q) {
    if (q == null) return { ...data };
    const keys = Array.isArray(q) ? q : [q];
    return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
  },
  async set(o) {
    const next = { ...data, ...structuredClone(o) };
    if (quota && JSON.stringify(next).length > quota) throw new Error("QUOTA_BYTES quota exceeded");
    Object.assign(data, structuredClone(o));
  },
  async remove(q) { for (const k of Array.isArray(q) ? q : [q]) delete data[k]; },
});
const syncData = {}; // 두 기기가 공유하는 크롬 계정
function device(name) {
  const ctx = vm.createContext({
    chrome: { storage: { sync: area(syncData, 3000), local: area({}) } },
    fetch: fakeFetch, crypto: globalThis.crypto, TextEncoder, btoa, Blob, setTimeout: () => 0, clearTimeout() {}, console,
    imageBlob: async (url) => (url.includes("dead") ? null : new Blob([`img:${url}`])),
  });
  vm.runInContext(src + "\n;globalThis.api = { ghInit, ghConnect, ghDisconnect, ghSync, dbAll, dbSet, dbRemove, ghImage, state: ghState, status: ghStatus, mode: () => dbArea() };", ctx);
  return { name, api: ctx.api, ctx, local: ctx.chrome.storage.local.data };
}
const w = (id, model, t, imgs = []) => ({ id, brand: "B", model, imgs, updatedAt: t });
const names = async (d) => (await d.api.dbAll()).map((x) => `${x.id}:${x.model}`).sort().join(",");
let fails = 0;
const check = (label, got, want) => { const ok = got === want; if (!ok) fails++; console.log(ok ? "PASS" : "FAIL", label, ok ? "" : `\n   got  ${got}\n   want ${want}`); };

(async () => {
  const A = device("A");
  await A.api.ghInit();
  check("기본은 크롬 계정", A.api.mode(), "sync");
  await A.api.dbSet({ "w:1": w("1", "one", 1, ["https://x/a.jpg"]), "w:2": w("2", "two", 1, ["https://x/dead.jpg"]), "w:3": w("3", "three", 1) });
  check("크롬 계정에 저장", Object.keys(syncData).sort().join(","), "w:1,w:2,w:3");

  await A.api.ghConnect("o/r", "bad").then(() => check("잘못된 토큰 거부", "연결됨", "오류"), (e) => check("잘못된 토큰 거부", /토큰/.test(e.message), true));
  repo.private = false;
  await A.api.ghConnect("o/r", "good").then(() => check("공개 저장소 거부", "연결됨", "오류"), (e) => check("공개 저장소 거부", /비공개/.test(e.message), true));
  repo.private = true;
  check("실패 후에도 크롬 계정 유지", A.api.mode() + "|" + Object.keys(syncData).sort().join(","), "sync|w:1,w:2,w:3");

  await A.api.ghConnect("o/r", "good");
  await A.api.ghSync();
  check("연결 후 GitHub 모드", A.api.mode(), "local");
  check("크롬 계정에는 연결 정보만", Object.keys(syncData).join(","), "gh");
  check("저장소에 시계 3개", [...repo.files.keys()].filter((p) => p.startsWith("watches/")).sort().join(","), "watches/1.json,watches/2.json,watches/3.json");
  check("열리는 이미지만 사본 1개", [...repo.files.keys()].filter((p) => p.startsWith("images/")).length, 1);
  check("A 목록 유지", await names(A), "1:one,2:two,3:three");
  check("오류 없음", A.api.status.error, "");

  const B = device("B");
  await B.api.ghInit();
  check("B도 GitHub 모드로 시작", B.api.mode(), "local");
  await B.api.ghSync();
  check("B가 3개 받음", await names(B), "1:one,2:two,3:three");
  const img = await B.api.ghImage("https://x/a.jpg");
  check("B가 이미지 사본 받음", img && (await img.text()), "img:https://x/a.jpg");
  check("사본 없는 이미지는 null", await B.api.ghImage("https://x/dead.jpg"), null);

  await B.api.dbSet({ "w:2": w("2", "two-B", 5) });
  await B.api.ghSync();
  await A.api.ghSync();
  check("B의 수정이 A에 도착", await names(A), "1:one,2:two-B,3:three");

  await A.api.dbRemove("3");
  await A.api.ghSync();
  await B.api.ghSync();
  check("A의 삭제가 B에 반영", await names(B), "1:one,2:two-B");
  check("저장소에는 지운 표시로 남음", JSON.parse(repo.files.get("watches/3.json").buf.toString()).deleted, true);

  // 충돌: 둘 다 1번을 고침. B가 나중
  await A.api.dbSet({ "w:1": w("1", "one-A", 10, ["https://x/a.jpg"]) });
  await B.api.dbSet({ "w:1": w("1", "one-B", 20, ["https://x/a.jpg"]) });
  await A.api.ghSync();
  await B.api.ghSync();
  await A.api.ghSync();
  check("충돌은 나중에 고친 쪽(B)", (await names(A)) + "|" + (await names(B)), "1:one-B,2:two-B|1:one-B,2:two-B");
  check("충돌 뒤 오류 없음", A.api.status.error + B.api.status.error, "");

  // 충돌: A가 나중에 고쳤는데 B가 먼저 올림
  await B.api.dbSet({ "w:2": w("2", "two-B2", 30) });
  await A.api.dbSet({ "w:2": w("2", "two-A2", 40) });
  await B.api.ghSync();
  await A.api.ghSync();
  await B.api.ghSync();
  check("늦게 올려도 나중에 고친 쪽(A)", (await names(A)) + "|" + (await names(B)), "1:one-B,2:two-A2|1:one-B,2:two-A2");

  // 지우기와 수정이 겹치면 나중에 한 쪽이 이김
  await B.api.dbSet({ "w:2": w("2", "two-old", 50) });
  await A.api.dbRemove("2");
  await B.api.ghSync();
  await A.api.ghSync();
  await B.api.ghSync();
  check("수정보다 나중에 지웠으면 지워짐", (await names(A)) + "|" + (await names(B)), "1:one-B|1:one-B");
  await B.api.dbSet({ "w:2": w("2", "two-B3", Date.now() + 5000) });
  await B.api.ghSync();
  await A.api.ghSync();
  check("지운 뒤에 고쳤으면 되살아남", await names(A), "1:one-B,2:two-B3");

  // 새 시계 추가 + 이미지 빼기 → 고아 사본 삭제
  await A.api.dbSet({ "w:4": w("4", "four", 60, ["https://x/b.jpg"]), "w:1": w("1", "one-B", 61, []) });
  await A.api.ghSync();
  check("이미지 사본 교체 (a 삭제, b 추가)", [...repo.files.keys()].filter((p) => p.startsWith("images/")).length, 1);
  await B.api.ghSync();
  check("B에 새 시계 도착", await names(B), "1:one-B,2:two-B3,4:four");

  // 토큰 만료
  const before = await names(A);
  A.api.state; // 토큰을 바꿔 치기
  await A.api.ghDisconnect().catch(() => {});
  check("해제 후 크롬 계정 모드", A.api.mode(), "sync");
  check("해제 후 크롬 계정에 시계 복귀 (지운 표시 3 포함)", Object.keys(syncData).sort().join(","), "w:1,w:2,w:3,w:4");
  check("해제 후 목록 동일", await names(A), before);
  check("저장소 파일은 남김", repo.files.has("watches/1.json"), true);

  // 해제한 동안 지운 시계는 다시 연결해도 되살아나지 않음
  await A.api.dbRemove("4");
  check("크롬 계정 모드에서 지움", await names(A), "1:one-B,2:two-B3");
  await A.api.ghConnect("o/r", "good");
  await A.api.ghSync();
  check("재연결 후에도 지운 채로", await names(A), "1:one-B,2:two-B3");
  await B.api.ghInit();
  await B.api.ghSync();
  check("다른 기기에도 삭제 반영", await names(B), "1:one-B,2:two-B3");
  check("재연결 후 오류 없음", A.api.status.error, "");

  // 올리는 사이 다른 기기가 먼저 바꿈 → 오류 없이 다시 받아 나중 것으로 맞춤
  repo.race = "watches/1.json";
  repo.raceWith = w("1", "one-race", Date.now() + 99999);
  await A.api.dbSet({ "w:1": w("1", "one-mine", Date.now()) });
  await A.api.ghSync();
  check("올리는 중 충돌은 자동으로 다시 맞춤", A.api.status.error + "|" + (await names(A)), "|1:one-race,2:two-B3");
  // 죽은 이미지 주소는 한 번만 시도
  let tries = 0;
  A.ctx.imageBlob = async (url) => (url.includes("dead") ? (tries++, null) : new Blob([`img:${url}`]));
  await A.api.dbSet({ "w:5": w("5", "five", Date.now(), ["https://x/dead2.jpg"]) });
  await A.api.ghSync(); await A.api.ghSync(); await A.api.ghSync();
  check("죽은 주소는 한 번만 받아 봄", tries, 1);
  await A.api.dbRemove("5");
  await A.api.ghSync();

  // 용량 초과로 해제 실패
  const big = {}; for (let i = 10; i < 40; i++) big[`w:${i}`] = w(String(i), "x".repeat(200), 100 + i);
  await A.api.dbSet(big);
  await A.api.ghSync();
  await A.api.ghDisconnect().then(() => check("용량 초과면 해제 실패", "해제됨", "오류"), (e) => check("용량 초과면 해제 실패", /QUOTA/.test(e.message), true));
  check("해제 실패 시 GitHub 모드 유지", A.api.mode() + "|" + (await A.api.dbAll()).length, "local|32");
  console.log(fails ? `\n실패 ${fails}건` : "\n전부 통과", `(API 호출 ${repo.calls}회)`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("예외", e); process.exit(2); });
