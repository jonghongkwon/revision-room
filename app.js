import { GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "fb/auth";
import {
  S, h, db, auth, toast, fmt, tsDate, errMsg, myName, writeLog, snapList, cut, sigOf, keyed, patchChildren,
  scheduleRender, setRenderer, restoreFocus, autosize, editArea, editInput, selectBox, setField, confirmButton,
  ownerOptions, itemLabel, itemById, reviewerName, codesOf, codeText, lsSet, saveOpen, copyText, STATUS,
  doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc, collection, query, orderBy, limit, onSnapshot,
  serverTimestamp, writeBatch
} from "./core.js?v=4";
import { renderMs, unmountMs, M, scrollToBlock, blockLabel, linksForItem, itemShortName, msMarkdownSummary } from "./ms.js?v=4";
import { renderFiles } from "./files.js?v=4";
import { renderChat } from "./chat.js?v=4";
import { plainOf } from "./markup.js?v=4";

const J_STATUS = ["후보", "검토 중", "유력", "제외", "확정"];
const TABS = [
  ["items", "심사평 대응"], ["ms", "원고 검토"], ["chat", "회의·대화"], ["tasks", "할 일·일정"],
  ["journals", "후보 저널"], ["files", "자료실"], ["docs", "메모·자료"], ["log", "수정 기록"], ["members", "멤버"]
];
const ITEM_FIELDS = [
  ["location", "제출본 위치", false],
  ["current", "제출본 현재 서술", false],
  ["overlap", "연결된 다른 항목", false],
  ["response", "대응 방향", true],
  ["refs", "추가로 필요한 문헌·자료", false],
  ["note", "메모", false]
];

/* ---------- 로그인 ---------- */
function renderLogin(msg) {
  S.shell = null;
  document.getElementById("app").replaceChildren(h("div", { class: "center" },
    h("h2", { text: "리젝 대응 작업실" }),
    h("p", { class: "muted", text: "3D DRAM ALD 리뷰 (MS #APR26-RV-01180) 팀 공동 작업 페이지입니다." }),
    msg ? h("p", { text: msg }) : null,
    h("button", { class: "primary", text: "Google 계정으로 로그인", onclick: async () => {
      try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (e) { toast("로그인 실패: " + errMsg(e)); }
    } })));
}
function renderPending() {
  S.shell = null;
  document.getElementById("app").replaceChildren(h("div", { class: "center" },
    h("h2", { text: "승인 대기 중" }),
    h("p", { text: `${S.user.email} 계정으로 접근을 요청했습니다. 관리자가 승인하면 이 화면이 자동으로 바뀝니다.` }),
    h("button", { text: "로그아웃", onclick: () => signOut(auth) })));
}
async function enter(user) {
  S.user = user;
  S.isAdmin = false;
  try { await getDoc(doc(db, "admin", "probe")); S.isAdmin = true; } catch (e) { S.isAdmin = false; }
  const meRef = doc(db, "members", user.uid);
  let snap;
  try { snap = await getDoc(meRef); } catch (e) { renderLogin("회원 정보를 읽지 못했습니다: " + errMsg(e)); return; }
  if (!snap.exists()) {
    const base = { uid: user.uid, email: user.email || "", name: user.displayName || (user.email || "").split("@")[0], photo: user.photoURL || "", requestedAt: serverTimestamp(), lastSeen: serverTimestamp() };
    try { await setDoc(meRef, { ...base, approved: true, role: S.isAdmin ? "admin" : "member" }); }
    catch (e) {
      try { await setDoc(meRef, { ...base, approved: false, role: "member" }); }
      catch (e2) { renderLogin("접근 요청에 실패했습니다: " + errMsg(e2)); return; }
    }
  }
  S.unsubs.push(onSnapshot(meRef, s => {
    S.me = s.exists() ? { id: s.id, ...s.data() } : null;
    const ok = S.isAdmin || (S.me && S.me.approved);
    if (ok && !S.ready) { S.ready = true; startData(); }
    else if (!ok) { S.ready = false; stopData(); renderPending(); }
    else scheduleRender();
  }, e => renderLogin("접근 권한을 확인하지 못했습니다: " + errMsg(e))));
}
function stopData() {
  for (const u of S.unsubs.splice(1)) u();
  for (const k of Object.keys(S.commentUnsubs)) { S.commentUnsubs[k](); delete S.commentUnsubs[k]; }
  clearInterval(S.beat);
}
function startData() {
  const listen = (q, key, after) => S.unsubs.push(onSnapshot(q, snap => { S[key] = snapList(snap); if (after) after(); scheduleRender(); },
    e => toast(key + " 불러오기 실패: " + errMsg(e))));
  S.unsubs.push(onSnapshot(collection(db, "members"), snap => {
    const list = snapList(snap);
    const sig = sigOf(list.map(m => [m.id, m.name, m.email, m.approved]).sort());
    S.members = list;
    if (sig !== S.memberSig) { S.memberSig = sig; scheduleRender(); } else refreshHeader();
  }, e => toast("members 불러오기 실패: " + errMsg(e))));
  listen(query(collection(db, "items"), orderBy("order")), "items", syncCommentListeners);
  listen(query(collection(db, "tasks"), orderBy("order")), "tasks");
  listen(query(collection(db, "journals"), orderBy("createdAt")), "journals");
  listen(query(collection(db, "docs"), orderBy("order")), "docs");
  listen(query(collection(db, "log"), orderBy("at", "desc"), limit(150)), "log");
  listen(collection(db, "anns"), "anns");
  listen(collection(db, "revs"), "revs");
  listen(collection(db, "locks"), "locks");
  listen(query(collection(db, "chat"), orderBy("at", "desc"), limit(300)), "chat");
  listen(collection(db, "files"), "files");
  const beat = () => updateDoc(doc(db, "members", S.user.uid), { lastSeen: serverTimestamp() }).catch(() => {});
  beat();
  S.beat = setInterval(beat, 60000);
  if (!S.verTimer) {
    S.verTimer = setInterval(checkVersion, 90000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) checkVersion(); });
  }
  window.__importSeed = importSeed;
  window.__migrateV2 = migrateV2;
  scheduleRender();
}
function syncCommentListeners() {
  const ids = new Set(S.items.map(i => i.id));
  for (const id of ids) {
    if (S.commentUnsubs[id]) continue;
    S.commentUnsubs[id] = onSnapshot(query(collection(db, "items", id, "comments"), orderBy("createdAt")),
      snap => { S.comments[id] = snapList(snap); scheduleRender(); }, e => console.warn("comments", e));
  }
  for (const id of Object.keys(S.commentUnsubs)) if (!ids.has(id)) { S.commentUnsubs[id](); delete S.commentUnsubs[id]; delete S.comments[id]; }
}
onAuthStateChanged(auth, user => {
  for (const u of S.unsubs.splice(0)) u();
  stopData();
  S.ready = false; S.me = null;
  if (!user) { S.user = null; renderLogin(); return; }
  enter(user);
});

/* ---------- 화면 틀 ---------- */
function isOnline(m) { const d = tsDate(m.lastSeen); return d && (Date.now() - d.getTime() < 3 * 60 * 1000); }
function headerSig() {
  return sigOf([S.members.filter(m => m.approved).map(m => [m.id, m.name, isOnline(m)]), S.me && S.me.name, S.tab, S.isAdmin, S.members.filter(m => !m.approved).length]);
}
function renderHeader() {
  const people = S.members.filter(m => m.approved).map(m =>
    h("span", { class: "chip person" + (isOnline(m) ? " on" : "") + (m.uid === S.user.uid ? " me" : ""), title: m.email },
      h("span", { class: "dot" }), m.name + (m.uid === S.user.uid ? " (나)" : "")));
  const tabs = h("nav", { class: "tabs" }, TABS.filter(([k]) => k !== "members" || S.isAdmin).map(([k, label]) => {
    let extra = "";
    if (k === "members") { const p = S.members.filter(m => !m.approved).length; if (p) extra = ` (${p})`; }
    return h("button", { class: S.tab === k ? "active" : "", text: label + extra, onclick: () => { S.tab = k; lsSet("tab", k); scheduleRender(); } });
  }));
  const hd = h("header", { class: "top" },
    h("div", { class: "top-row" },
      h("div", { class: "brand" }, h("h1", { text: "리젝 대응 작업실" }), h("div", { class: "sub", text: "3D DRAM ALD 리뷰 · APR MS #APR26-RV-01180 · 2026-09-11 Reject" })),
      h("div", { class: "people" }, people),
      h("span", { class: "grow" }),
      h("span", { class: "people" }, h("span", { class: "muted", text: "내 표시 이름" }),
        editInput("members/" + S.user.uid, "name", S.me ? S.me.name : "", "멤버", "표시 이름", { style: "width:100px" })),
      h("button", { text: "AI용 복사", title: "대응 항목·할 일·저널·원고 수정 목록을 마크다운으로 복사", onclick: () => copyText(buildMarkdown(false)) }),
      h("button", { text: "AI용 복사(자료 포함)", onclick: () => copyText(buildMarkdown(true)) }),
      h("button", { text: "백업", title: "전체 데이터를 JSON으로 내려받기", onclick: exportAll }),
      h("button", { text: "로그아웃", onclick: () => signOut(auth) })),
    tabs);
  hd.dataset.sig = headerSig();
  return hd;
}
function refreshHeader() {
  const old = document.querySelector("header.top");
  const ae = document.activeElement;
  if (!old || !S.ready || (old.contains(ae) && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA"))) return;
  if (old.dataset.sig === headerSig()) return;
  old.replaceWith(renderHeader());
}

function render() {
  const app = document.getElementById("app");
  const active = document.activeElement;
  const activeKey = active && active.dataset ? active.dataset.key : null;
  const selStart = active && "selectionStart" in active ? active.selectionStart : null;
  const selEnd = active && "selectionEnd" in active ? active.selectionEnd : null;
  if (!S.shell || !app.contains(S.shell.main)) {
    const main = h("main");
    app.replaceChildren(renderHeader(), main);
    S.shell = { main, tab: null, root: null };
  } else refreshHeader();
  const sh = S.shell;
  if (sh.tab !== S.tab) {
    if (sh.tab === "ms") unmountMs();
    sh.main.replaceChildren();
    sh.main.className = S.tab === "ms" ? "full" : "";
    sh.root = S.tab === "ms" ? sh.main : h("div", { class: "wrap" });
    if (S.tab !== "ms") sh.main.append(sh.root);
    sh.tab = S.tab;
    window.scrollTo(0, 0);
  }
  const hd = document.querySelector("header.top");
  if (hd) document.documentElement.style.setProperty("--hh", hd.offsetHeight + "px");
  if (S.tab === "ms") renderMs(sh.root);
  else {
    patchChildren(sh.root, renderTab());
    sh.root.querySelectorAll("textarea.auto").forEach(t => { if (!t.dataset.sized) { autosize(t); t.dataset.sized = "1"; } });
  }
  restoreFocus(activeKey, selStart, selEnd);
}
setRenderer(render);

function renderTab() {
  switch (S.tab) {
    case "tasks": return renderTasks();
    case "journals": return renderJournals();
    case "docs": return renderDocs();
    case "log": return renderLog();
    case "chat": return renderChat();
    case "files": return renderFiles();
    case "members": return S.isAdmin ? renderMembers() : renderItems();
    default: return renderItems();
  }
}

/* ---------- 새 버전 알림 ---------- */
const APP_V = new URL(import.meta.url).searchParams.get("v") || "";
async function checkVersion() {
  if (!APP_V || document.getElementById("newver")) return;
  try {
    const t = await (await fetch("index.html?nc=" + Date.now(), { cache: "no-store" })).text();
    const m = t.match(/app\.js\?v=([0-9a-z]+)/);
    if (m && m[1] !== APP_V) document.body.prepend(h("div", { id: "newver", class: "newver" },
      "사이트가 새 버전으로 바뀌었습니다. 쓰던 내용이 저장된 것을 확인한 뒤 새로고침해 주세요. ",
      h("button", { text: "새로고침", onclick: () => location.reload() })));
  } catch (e) { /* 네트워크 오류는 무시 */ }
}

/* ---------- 심사평 대응 ---------- */
function mergedLine() {
  const merged = S.items.filter(it => sourcesOf(it).length > 1).sort((a, b) => (a.no || 0) - (b.no || 0));
  if (!merged.length) return null;
  return h("div", { class: "merged-line" }, "겹치는 지적을 합친 항목: ",
    merged.map((it, k) => h("span", null, k ? ", " : "", h("b", { text: `대응 ${it.no}` }), ` = ${sourcesOf(it).map(s => s.code).join(" + ")}`)));
}
function sourcesOf(it) {
  if (Array.isArray(it.sources) && it.sources.length) return it.sources;
  if (it.original || it.translation) return [{ rv: it.reviewer, label: itemLabel(it), original: it.original || "", translation: it.translation || "" }];
  return [];
}
function itemsSig() { return sigOf(S.items.map(i => [i.id, i.no, i.topic])); }
function renderItems() {
  const f = S.f;
  const q = f.q.trim().toLowerCase();
  const hasRv = (it, rv) => sourcesOf(it).some(s => s.rv === rv);
  const list = S.items.filter(it =>
    (!f.reviewer || (f.reviewer === "both" ? hasRv(it, "R1") && hasRv(it, "R2") : f.reviewer === "team" ? !sourcesOf(it).length : hasRv(it, f.reviewer))) &&
    (!f.status || (it.status || "미착수") === f.status) &&
    (!f.owner || (f.owner === "__none" ? (!it.owner || it.owner === "미정") : (it.owner || "") === f.owner)) &&
    (!q || JSON.stringify(it).toLowerCase().includes(q)));
  const counts = {};
  for (const it of S.items) { const s = it.status || "미착수"; counts[s] = (counts[s] || 0) + 1; }
  const allSrc = S.items.flatMap(sourcesOf);
  const r1 = allSrc.filter(s => s.rv === "R1").length, r2 = allSrc.filter(s => s.rv === "R2").length;
  const reviewerItems = S.items.filter(it => sourcesOf(it).length).length;
  const teamItems = S.items.length - reviewerItems;

  const summary = h("div", { class: "card summary" },
    h("div", { class: "sum-line" },
      h("strong", { text: `심사 의견 ${r1 + r2}건 → 대응 항목 ${reviewerItems}개` }),
      h("span", { class: "muted", text: ` (심사위원 1: ${r1}건, 심사위원 2: ${r2}건. 같은 내용의 지적은 한 항목으로 묶음${teamItems ? `. 팀이 추가한 항목 ${teamItems}개 별도` : ""})` })),
    h("div", { class: "muted", text: "심사위원 1·2는 편집자 결정 메일에 실린 Reviewer #1·#2입니다. 심사위원 1이 리젝 사유를 적은 사람입니다. R1-5는 심사위원 1의 5번 요구라는 뜻입니다." }),
    mergedLine(),
    h("details", { class: "src", open: S.open.has("overview") ? true : null, ontoggle: e => { if (e.target.open) S.open.add("overview"); else S.open.delete("overview"); saveOpen(); } },
      h("summary", { text: "대응 항목 한눈에 보기" }),
      h("table", { class: "t overview" },
        h("thead", null, h("tr", null, ["번호", "대응 항목", "출처 (원래 번호)", "상태", "담당", "원고 수정", "원고 표시", "댓글"].map(x => h("th", { text: x })))),
        h("tbody", null, S.items.map(it => {
          const L = linksForItem(it.id);
          return h("tr", { class: "clickable", onclick: () => { const el = document.getElementById("item-" + it.id); if (el) el.scrollIntoView({ block: "start" }); } },
            h("td", { text: it.no ? String(it.no) : "-" }), h("td", { text: it.topic || "" }),
            h("td", { class: sourcesOf(it).length > 1 ? "merged-cell" : "", text: sourcesOf(it).map(s => `${s.code || ""} (${s.label})`).join(" + ") || "팀 추가" }),
            h("td", { text: it.status || "미착수" }), h("td", { text: it.owner || "-" }),
            h("td", { text: String(L.revs.length) }), h("td", { text: String(L.anns.length) }),
            h("td", { text: String((S.comments[it.id] || []).length) }));
        })))));
  const nodes = [keyed(summary, "summary", sigOf([S.items.map(i => [i.id, i.no, i.topic, i.status, i.owner, sourcesOf(i).map(s => s.label)]), S.anns.map(a => a.itemId), S.revs.map(r => r.items), Object.values(S.comments).map(c => c.length), S.open.has("overview")]))];

  const bar = h("div", { class: "bar" },
    selectBox([["R1", "심사위원 1 의견이 있는 항목"], ["R2", "심사위원 2 의견이 있는 항목"], ["both", "두 심사위원 공통 항목"], ["team", "팀이 추가한 항목"]], f.reviewer, v => { f.reviewer = v; scheduleRender(); }, "모든 항목"),
    selectBox(STATUS, f.status, v => { f.status = v; scheduleRender(); }, "모든 상태"),
    selectBox([["__none", "담당 미지정"], ...ownerOptions()], f.owner, v => { f.owner = v; scheduleRender(); }, "모든 담당"),
    h("input", { type: "text", placeholder: "검색", value: f.q, dataset: { key: "filter#q" }, oninput: e => { f.q = e.target.value; scheduleRender(); } }),
    h("span", { class: "count", dataset: { role: "count" }, text: `${list.length} / ${S.items.length}개` }),
    h("span", { class: "grow" }),
    h("button", { text: "영어 원문 모두 펼치기", onclick: () => { S.items.forEach(i => sourcesOf(i).forEach((s, k) => S.open.add(i.id + ":en" + k))); saveOpen(); scheduleRender(); } }),
    h("button", { text: "모두 접기", onclick: () => { for (const k of [...S.open]) if (k.includes(":en")) S.open.delete(k); saveOpen(); scheduleRender(); } }),
    h("button", { text: "항목 추가", onclick: addItem }));
  nodes.push(keyed(bar, "bar", sigOf([f.reviewer, f.status, f.owner, ownerOptions(), list.length])));
  const stats = h("div", { class: "bar" }, STATUS.map(s => h("span", { class: "stat", text: `${s} ${counts[s] || 0}` })));
  nodes.push(keyed(stats, "stats", sigOf(counts)));
  if (!S.items.length) nodes.push(keyed(h("div", { class: "card", text: "아직 항목이 없습니다." }), "empty", "e"));
  for (const it of list) nodes.push(renderItemCard(it));
  return nodes;
}

function linkList(it) {
  const L = linksForItem(it.id);
  const chats = S.chat.filter(m => (m.items || []).includes(it.id));
  const box = h("div", { class: "links" }, h("div", { class: "links-title", text: `원고 반영 내역 · 수정 ${L.revs.length}건 · 표시 ${L.anns.length}건 · 관련 대화 ${chats.length}건` }));
  const go = bid => { S.tab = "ms"; lsSet("tab", "ms"); M.pendingScroll = bid; scheduleRender(); };
  for (const r of L.revs) box.append(h("div", { class: "link-line" },
    h("span", { class: "chip st " + (r.status === "수락" ? "ok" : r.status === "거절" ? "no" : "pend"), text: (r.kind === "insert" ? "새 문단 " : r.del ? "삭제 " : "수정 ") + (r.status || "제안") }),
    h("span", { text: cut(blockLabel(r.id), 70) }), h("span", { class: "meta", text: ` ${r.author} · ${fmt(r.updatedAt)}${r.note ? " · " + cut(r.note, 60) : ""}` }),
    h("button", { class: "small", text: "원고에서 보기", onclick: () => go(r.id) })));
  for (const a of L.anns) box.append(h("div", { class: "link-line" },
    h("span", { class: "chip t-" + a.type, text: ({ memo: "메모", reviewer: "리뷰어 지적", issue: "문제", bookmark: "책갈피" })[a.type] + (a.resolved ? " (해결)" : "") }),
    h("span", { text: "“" + cut(a.quote, 60) + "”" }), h("span", { class: "meta", text: ` ${a.text ? cut(a.text, 50) + " · " : ""}${a.name}` }),
    h("button", { class: "small", text: "원고에서 보기", onclick: () => go(a.bid) })));
  for (const m of chats) box.append(h("div", { class: "link-line" },
    h("span", { class: "chip" + (m.pinned ? " st ok" : ""), text: m.pinned ? "결정 사항" : "대화" }),
    h("span", { text: cut(m.text, 90) }), h("span", { class: "meta", text: ` ${m.name} · ${fmt(m.at)}` })));
  if (!L.revs.length && !L.anns.length && !chats.length) box.append(h("div", { class: "muted", text: "아직 없습니다. [원고 검토] 탭에서 수정하거나 표시할 때 이 항목을 선택하면 여기에 쌓입니다." }));
  return box;
}

function renderItemCard(it) {
  const path = "items/" + it.id;
  const label = it.no ? `대응 ${it.no}` : "대응";
  const st = it.status || "미착수";
  const srcs = sourcesOf(it);
  const cmts = S.comments[it.id] || [];
  const L = linksForItem(it.id);
  const sig = sigOf([it, cmts, [...S.open].filter(k => k.startsWith(it.id + ":")), ownerOptions(),
    [...Object.keys(S.dirty)].filter(k => k.includes(it.id)).map(k => [k, S.dirty[k]]),
    [...S.remoteChanged].filter(k => k.includes(it.id)),
    Object.entries(S.armed).filter(([k, v]) => k.includes(it.id) && v > Date.now()).map(x => x[0]),
    cmts.map(c => S.armed["delc:" + c.id] > Date.now()),
    L.revs.map(r => [r.id, r.status, r.note, r.updatedAt, r.author, blockLabel(r.id)]), L.anns.map(a => [a.id, a.text, a.resolved, a.quote]),
    S.chat.filter(m => (m.items || []).includes(it.id)).map(m => [m.id, m.pinned, m.text]), M.loaded]);
  const head = h("div", { class: "card-head" },
    h("span", { class: "code " + (srcs.length ? "rv" : "etc"), text: label }),
    codesOf(it).length ? h("span", { class: "codes" + (srcs.length > 1 ? " merged" : ""), title: srcs.map(s => `${s.code}: ${s.label}`).join("\n"), text: (srcs.length > 1 ? "통합 " : "") + codeText(it) }) : null,
    editInput(path, "topic", it.topic, label, "주제", { cls: "topic", placeholder: "주제" }),
    h("span", { class: "muted", text: "상태" }),
    selectBox(STATUS, st, v => setField(path, "status", v, label, "상태", st)),
    h("span", { class: "muted", text: "담당" }),
    selectBox(ownerOptions(), it.owner || "", v => setField(path, "owner", v, label, "담당", it.owner || ""), "미지정"),
    h("button", { class: "small", text: "이 항목 AI용 복사", onclick: () => copyText(itemMarkdown(it)) }));
  const srcBox = h("div", { class: "sources" },
    srcs.length > 1 ? h("div", { class: "merge-note", text: `겹치는 지적 ${srcs.length}건을 합친 항목입니다: ${srcs.map(s => `${s.code} (${s.label})`).join(", ")}. 두 원문을 아래에 모두 표시합니다.` }) : null,
    srcs.length ? srcs.map((s, k) => {
      const key = it.id + ":en" + k;
      return h("div", { class: "source " + (s.rv === "R2" ? "r2" : "r1") },
        h("div", { class: "source-head" }, h("span", { class: "chip rvchip " + (s.rv === "R2" ? "r2" : "r1"), text: (s.code ? s.code + " · " : "") + (s.label || reviewerName(s.rv)) })),
        h("div", { class: "source-ko", text: s.translation || "(번역 없음)" }),
        h("details", { class: "src", open: S.open.has(key) ? true : null, ontoggle: e => { if (e.target.open) S.open.add(key); else S.open.delete(key); saveOpen(); } },
          h("summary", { text: "영어 원문" }), h("div", { class: "pre", text: s.original || "" })));
    }) : h("div", { class: "muted", text: "팀이 추가한 항목입니다 (심사 의견 없음)." }));
  const grid = h("div", { class: "grid" });
  for (const [field, flabel, isKey] of ITEM_FIELDS) {
    const key = path + "#" + field;
    grid.append(h("label", { class: isKey ? "key" : "" }, flabel, S.remoteChanged.has(key) ? h("span", { class: "badge-remote", text: "다른 사람이 수정함" }) : null));
    grid.append(h("div", { class: isKey ? "key-field" : "" }, editArea(path, field, it[field], label, flabel, { placeholder: isKey ? "팀 논의로 정한 대응 방향" : "" })));
  }
  const newKey = "newc#" + it.id;
  const ctext = h("textarea", { class: "auto", placeholder: "댓글 (Ctrl+Enter로 등록)", rows: 1, dataset: { key: newKey }, value: S.dirty[newKey] || "",
    oninput: e => { S.dirty[newKey] = e.target.value; autosize(e.target); },
    onkeydown: e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); postComment(it, e.target); } } });
  const comments = h("div", { class: "comments" },
    h("div", { class: "meta", text: `댓글 ${cmts.length}` }),
    cmts.map(c => h("div", { class: "cmt" },
      h("span", { class: "who", text: c.name }), " ", h("span", { class: "meta", text: fmt(c.createdAt) }), " ",
      (c.uid === S.user.uid || S.isAdmin) ? confirmButton("삭제", () => deleteComment(it, c), "small danger", "delc:" + c.id) : null,
      h("div", { class: "txt", text: c.text }))),
    h("div", { class: "cmt-new" }, ctext, h("button", { text: "등록", onclick: () => postComment(it, ctext) })));
  const foot = h("div", { class: "meta foot" },
    it.updatedBy ? `마지막 수정 ${it.updatedBy} · ${fmt(it.updatedAt)}` : "",
    S.isAdmin ? h("span", { style: "margin-left:10px" }, confirmButton("항목 삭제", () => deleteItem(it), "small danger", "deli:" + it.id)) : null);
  const card = h("div", { class: "card item-card" + (st === "완료" ? " done" : ""), id: "item-" + it.id }, head, srcBox, grid, linkList(it), comments, foot);
  return keyed(card, it.id, sig);
}
async function postComment(it, ta) {
  const text = ta.value.trim();
  if (!text) return;
  try {
    await addDoc(collection(db, "items", it.id, "comments"), { text, uid: S.user.uid, name: myName(), createdAt: serverTimestamp() });
    delete S.dirty["newc#" + it.id];
    ta.value = "";
    await writeLog("댓글", `대응 ${it.no || ""}`, "", "", text);
  } catch (e) { toast("댓글 등록 실패: " + errMsg(e)); }
}
async function deleteComment(it, c) {
  try { await deleteDoc(doc(db, "items", it.id, "comments", c.id)); await writeLog("댓글 삭제", `대응 ${it.no || ""}`, "", c.text, ""); }
  catch (e) { toast("삭제 실패: " + errMsg(e)); }
}
async function addItem() {
  const order = Math.max(0, ...S.items.map(i => i.order || 0)) + 1;
  const no = Math.max(0, ...S.items.map(i => i.no || 0)) + 1;
  try {
    await addDoc(collection(db, "items"), { order, no, reviewer: "기타", code: "추가", topic: "새 항목", sources: [], status: "미착수", owner: "", createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: myName() });
    await writeLog("항목 추가", `대응 ${no}`, "", "", "새 항목");
  } catch (e) { toast("추가 실패: " + errMsg(e)); }
}
async function deleteItem(it) {
  try { await deleteDoc(doc(db, "items", it.id)); toast("항목을 삭제했습니다."); await writeLog("항목 삭제", `대응 ${it.no || ""}`, "", it.topic, ""); }
  catch (e) { toast("삭제 실패: " + errMsg(e)); }
}

/* ---------- 할 일 ---------- */
function renderTasks() {
  const addBtn = h("button", { text: "할 일 추가", onclick: async () => {
    const order = Math.max(0, ...S.tasks.map(t => t.order || 0)) + 1;
    try { await addDoc(collection(db, "tasks"), { order, text: "", owner: "", due: "", done: false, note: "", createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: myName() }); await writeLog("할 일 추가", "할 일", "", "", ""); }
    catch (e) { toast("추가 실패: " + errMsg(e)); }
  } });
  const rows = S.tasks.map(t => {
    const path = "tasks/" + t.id;
    const label = "할 일: " + cut(t.text, 30);
    return h("tr", null,
      h("td", null, h("input", { type: "checkbox", checked: !!t.done, onchange: e => setField(path, "done", e.target.checked, label, "완료", !!t.done) })),
      h("td", { style: "min-width:260px" }, editArea(path, "text", t.text, label, "내용")),
      h("td", null, selectBox(ownerOptions(), t.owner || "", v => setField(path, "owner", v, label, "담당", t.owner || ""), "미지정")),
      h("td", null, editInput(path, "due", t.due, label, "기한", { type: "date" })),
      h("td", { style: "min-width:200px" }, editArea(path, "note", t.note, label, "메모")),
      h("td", { class: "meta" }, t.updatedBy ? `${t.updatedBy} ${fmt(t.updatedAt)}` : ""),
      h("td", null, confirmButton("삭제", async () => { try { await deleteDoc(doc(db, "tasks", t.id)); await writeLog("할 일 삭제", label, "", t.text, ""); } catch (e) { toast(errMsg(e)); } }, "small danger", "delt:" + t.id)));
  });
  return [
    keyed(h("div", { class: "bar" }, h("span", { class: "count", text: `완료 ${S.tasks.filter(t => t.done).length} / ${S.tasks.length}` }), h("span", { class: "grow" }), addBtn), "bar", sigOf(S.tasks.map(t => t.done))),
    keyed(h("table", { class: "t" }, h("thead", null, h("tr", null, ["완료", "내용", "담당", "기한", "메모", "최근 수정", ""].map(x => h("th", { text: x })))), h("tbody", null, rows)),
      "table", sigOf([S.tasks, ownerOptions(), Object.keys(S.dirty).filter(k => k.startsWith("tasks/")).map(k => [k, S.dirty[k]]), S.tasks.map(t => S.armed["delt:" + t.id] > Date.now())]))
  ];
}

/* ---------- 저널 ---------- */
const J_FIELDS = [["name", "저널", 160], ["publisher", "출판사", 110], ["scope", "분야·범위", 160], ["format", "리뷰 형식·요건", 180], ["limits", "분량·그림 제한", 150], ["proposer", "제안자", 80], ["note", "메모", 180]];
function renderJournals() {
  const addBtn = h("button", { text: "저널 추가", onclick: async () => {
    try { await addDoc(collection(db, "journals"), { name: "", publisher: "", scope: "", format: "", limits: "", proposer: myName(), status: "후보", note: "", createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: myName() }); await writeLog("저널 추가", "후보 저널", "", "", ""); }
    catch (e) { toast("추가 실패: " + errMsg(e)); }
  } });
  const rows = S.journals.map(j => {
    const path = "journals/" + j.id;
    const label = "저널: " + (j.name || "(이름 없음)");
    return h("tr", null,
      J_FIELDS.map(([fk, fl, w]) => h("td", { style: `min-width:${w}px` }, editArea(path, fk, j[fk], label, fl))),
      h("td", null, selectBox(J_STATUS, j.status || "후보", v => setField(path, "status", v, label, "상태", j.status || ""))),
      h("td", null, confirmButton("삭제", async () => { try { await deleteDoc(doc(db, "journals", j.id)); await writeLog("저널 삭제", label, "", j.name, ""); } catch (e) { toast(errMsg(e)); } }, "small danger", "delj:" + j.id)));
  });
  return [
    keyed(h("div", { class: "bar" }, h("span", { class: "count", text: `${S.journals.length}개` }), h("span", { class: "grow" }), addBtn), "bar", String(S.journals.length)),
    keyed(h("div", { style: "overflow-x:auto" }, h("table", { class: "t" }, h("thead", null, h("tr", null, [...J_FIELDS.map(x => x[1]), "상태", ""].map(x => h("th", { text: x })))), h("tbody", null, rows))),
      "table", sigOf([S.journals, Object.keys(S.dirty).filter(k => k.startsWith("journals/")).map(k => [k, S.dirty[k]]), S.journals.map(j => S.armed["delj:" + j.id] > Date.now())]))
  ];
}

/* ---------- 메모·자료 ---------- */
function renderDocs() {
  const addBtn = h("button", { text: "자료 추가", onclick: async () => {
    const order = Math.max(0, ...S.docs.map(d => d.order || 0)) + 1;
    try { await addDoc(collection(db, "docs"), { order, title: "새 자료", body: "", createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: myName() }); await writeLog("자료 추가", "메모·자료", "", "", ""); }
    catch (e) { toast("추가 실패: " + errMsg(e)); }
  } });
  const nodes = [keyed(h("div", { class: "bar" }, h("span", { class: "count", text: `${S.docs.length}개` }), h("span", { class: "grow" }), addBtn), "bar", String(S.docs.length))];
  for (const d of S.docs) {
    const path = "docs/" + d.id;
    const key = d.id + ":doc";
    const card = h("div", { class: "card" },
      h("div", { class: "card-head" }, editInput(path, "title", d.title, "자료", "제목", { cls: "topic" }),
        h("span", { class: "meta", text: d.updatedBy ? `마지막 수정 ${d.updatedBy} · ${fmt(d.updatedAt)}` : "" }),
        S.isAdmin ? confirmButton("삭제", async () => { try { await deleteDoc(doc(db, "docs", d.id)); await writeLog("자료 삭제", d.title, "", "", ""); } catch (e) { toast(errMsg(e)); } }, "small danger", "deld:" + d.id) : null),
      h("details", { class: "src", open: S.open.has(key) ? true : null, ontoggle: e => { if (e.target.open) S.open.add(key); else S.open.delete(key); saveOpen(); if (e.target.open) e.target.querySelectorAll("textarea.auto").forEach(autosize); } },
        h("summary", { text: "내용 보기·편집" }), editArea(path, "body", d.body, "자료: " + d.title, "본문")));
    nodes.push(keyed(card, d.id, sigOf([d, S.open.has(key), S.dirty[path + "#body"], S.dirty[path + "#title"], S.armed["deld:" + d.id] > Date.now()])));
  }
  return nodes;
}

/* ---------- 기록 ---------- */
function renderLog() {
  return [keyed(h("table", { class: "t" },
    h("thead", null, h("tr", null, ["시각", "누가", "무엇을", "대상", "칸", "이전", "이후"].map(x => h("th", { text: x })))),
    h("tbody", null, S.log.map(l => h("tr", null,
      h("td", { class: "meta nowrap", text: fmt(l.at) }), h("td", { text: l.name }), h("td", { text: l.action }),
      h("td", { text: l.target }), h("td", { text: l.field }),
      h("td", { class: "pre muted", text: l.before }), h("td", { class: "pre", text: l.after }))))), "log", sigOf(S.log.map(l => l.id)))];
}

/* ---------- 멤버 ---------- */
function renderMembers() {
  const rows = S.members.slice().sort((a, b) => (a.approved === b.approved ? 0 : a.approved ? 1 : -1)).map(m => h("tr", null,
    h("td", { text: m.name }), h("td", { text: m.email }), h("td", { text: m.approved ? "승인됨" : "승인 대기" }),
    h("td", { class: "meta", text: fmt(m.lastSeen) }),
    h("td", null, m.uid === S.user.uid ? h("span", { class: "muted", text: "나" }) :
      m.approved
        ? confirmButton("승인 해제", async () => { try { await updateDoc(doc(db, "members", m.id), { approved: false }); await writeLog("승인 해제", m.email, "", "", ""); } catch (e) { toast(errMsg(e)); } }, "small danger", "unap:" + m.id)
        : h("span", null,
            h("button", { class: "small primary", text: "승인", onclick: async () => { try { await updateDoc(doc(db, "members", m.id), { approved: true }); await writeLog("승인", m.email, "", "", ""); } catch (e) { toast(errMsg(e)); } } }), " ",
            confirmButton("거절", async () => { try { await deleteDoc(doc(db, "members", m.id)); await writeLog("거절", m.email, "", "", ""); } catch (e) { toast(errMsg(e)); } }, "small danger", "rej:" + m.id)))));
  return [
    keyed(h("p", { class: "muted", text: "보안 규칙에 등록된 이메일은 로그인하면 바로 승인됩니다. 그 밖의 계정은 여기서 승인해야 합니다." }), "note", "n"),
    keyed(h("table", { class: "t" }, h("thead", null, h("tr", null, ["이름", "이메일", "상태", "최근 접속", ""].map(x => h("th", { text: x })))), h("tbody", null, rows)),
      "table", sigOf([S.members.map(m => [m.id, m.name, m.approved, fmt(m.lastSeen)]), Object.entries(S.armed).filter(([, v]) => v > Date.now()).map(x => x[0])]))
  ];
}

/* ---------- AI용 복사, 백업 ---------- */
function indent(s) { s = (s || "").trim(); return s ? s.split("\n").map(x => "  > " + x).join("\n") : "  > (비어 있음)"; }
function itemMarkdown(it) {
  const L = [`### 대응 ${it.no || "-"}${codesOf(it).length ? " (" + codeText(it) + ")" : ""} · ${it.topic || ""}`, `- 상태: ${it.status || "미착수"} / 담당: ${it.owner || "미지정"}`];
  for (const s of sourcesOf(it)) { const nm = (s.code ? s.code + " · " : "") + s.label; L.push(`- ${nm} 한글 번역:\n${indent(s.translation)}`); L.push(`- ${nm} 영어 원문:\n${indent(s.original)}`); }
  for (const [f, fl] of ITEM_FIELDS) L.push(`- ${fl}:\n${indent(it[f])}`);
  const Lk = linksForItem(it.id);
  if (Lk.revs.length) { L.push("- 원고 수정:"); for (const r of Lk.revs) L.push(`  - [${r.status || "제안"}] ${blockLabel(r.id)}: ${cut(plainOf(r.text), 300)}${r.note ? " (이유: " + r.note + ")" : ""}`); }
  if (Lk.anns.length) { L.push("- 원고 표시:"); for (const a of Lk.anns) L.push(`  - “${cut(a.quote, 120)}” ${a.text || ""} (${a.name})`); }
  const cm = S.comments[it.id] || [];
  if (cm.length) { L.push("- 댓글:"); for (const c of cm) L.push(`  - ${c.name} (${fmt(c.createdAt)}): ${String(c.text).replace(/\n/g, " ")}`); }
  return L.join("\n");
}
function buildMarkdown(withDocs) {
  const L = [`# 리젝 대응 작업실 현황 (${new Date().toLocaleString("ko-KR")} 기준)`,
    "원고: Atomic-layer-deposited metal oxide semiconductors for three-dimensional dynamic random-access memory (APR MS #APR26-RV-01180, 2026-09-11 Reject)",
    `\n## 대응 항목 (${S.items.length}개)`];
  for (const it of S.items) L.push("\n" + itemMarkdown(it));
  L.push("\n## 할 일·일정");
  for (const t of S.tasks) L.push(`- [${t.done ? "x" : " "}] ${(t.text || "").replace(/\n/g, " ")} (담당: ${t.owner || "미지정"}, 기한: ${t.due || "-"})${t.note ? " - " + t.note.replace(/\n/g, " ") : ""}`);
  L.push("\n## 후보 저널");
  for (const j of S.journals) L.push(`- ${j.name || "(이름 없음)"} [${j.status || "후보"}] 출판사: ${j.publisher || "-"} / 범위: ${j.scope || "-"} / 형식: ${j.format || "-"} / 제한: ${j.limits || "-"} / 메모: ${j.note || "-"}`);
  const pins = S.chat.filter(m => m.pinned);
  if (pins.length) { L.push("\n## 결정 사항"); for (const m of pins) L.push(`- ${m.name} (${fmt(m.at)}): ${m.text.replace(/\n/g, " ")}`); }
  const ms = msMarkdownSummary();
  if (ms) L.push("\n" + ms);
  if (withDocs) { L.push("\n## 메모·자료"); for (const d of S.docs) L.push(`\n### ${d.title}\n${d.body || ""}`); }
  return L.join("\n");
}
function exportAll() {
  const data = { exportedAt: new Date().toISOString(), items: S.items.map(i => ({ ...i, comments: S.comments[i.id] || [] })), tasks: S.tasks, journals: S.journals, docs: S.docs,
    anns: S.anns, revs: S.revs, chat: S.chat, files: S.files.map(f => ({ path: f.path, size: f.size, uploadedBy: f.uploadedBy })), members: S.members.map(m => ({ name: m.name, email: m.email, approved: m.approved })) };
  const blob = new Blob([JSON.stringify(data, (k, v) => (v && typeof v.toDate === "function") ? v.toDate().toISOString() : v, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `rejection-workspace-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
}

/* ---------- 관리자: 초기 데이터, 구조 변경 ---------- */
async function importSeed(seed, opts = {}) {
  if (!S.isAdmin) throw new Error("관리자만 가져올 수 있습니다.");
  const result = {};
  for (const coll of ["items", "tasks", "journals", "docs"]) {
    const rows = seed[coll] || [];
    if (!rows.length) continue;
    if (S[coll].length && !opts.force) { result[coll] = "건너뜀(기존 데이터 있음)"; continue; }
    const batch = writeBatch(db);
    for (const r of rows) { const { id, ...rest } = r; batch.set(doc(db, coll, id), { ...rest, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: myName() }); }
    await batch.commit();
    result[coll] = rows.length;
  }
  await writeLog("초기 데이터 입력", "전체", "", "", JSON.stringify(result));
  return result;
}
const V2_PLAN = [
  { id: "i01", no: 1, overlap: "아래 대응 항목 전체가 이 총평을 구체화한 요구다." },
  { id: "i02", no: 2, overlap: "'Table I·II 근거 수준 표시' 항목과 연결된다 (실험으로 입증된 것과 가설을 구분하라는 요구)." },
  { id: "i03", no: 3, overlap: "'수소의 이중 역할과 막 내 H·O 제어' 항목과 연결된다 (증착법별 수소 제어)." },
  { id: "i04", no: 4, overlap: "" },
  { id: "i05", no: 5, merge: ["i09"], topic: "수소의 이중 역할(passivation과 donor)과 증착법별 막 내 H·O 제어", overlap: "심사위원 1의 4번 요구와 심사위원 2의 2번 요구를 합친 항목이다. 'thermal ALD와 PEALD 비교의 균형' 항목과도 연결된다." },
  { id: "i06", no: 6, merge: ["i10"], topic: "경쟁 채널 기술(Si, poly-Si, 2D TMD)과의 정량·다차원 비교와 적용 경계", overlap: "심사위원 1의 5번 요구와 심사위원 2의 3번 요구를 합친 항목이다." },
  { id: "i07", no: 7, overlap: "" },
  { id: "i08", no: 8, overlap: "'c-axis 결정질과 비정질 비교의 균형' 항목과 연결된다." },
  { id: "i11", no: 9, overlap: "" }
];
async function migrateV2() {
  if (!S.isAdmin) throw new Error("관리자만 실행할 수 있습니다.");
  const meta = await getDoc(doc(db, "meta", "app"));
  if (meta.exists() && meta.data().schema >= 2) return "이미 적용됨";
  const get = id => S.items.find(i => i.id === id);
  const srcOf = it => ({ rv: it.reviewer, code: it.code, label: itemLabel(it), original: it.original || "", translation: it.translation || "" });
  const done = [];
  for (const p of V2_PLAN) {
    const main = get(p.id);
    if (!main) continue;
    const parts = [main, ...(p.merge || []).map(get).filter(Boolean)];
    const upd = { no: p.no, order: p.no, sources: parts.map(srcOf), updatedAt: serverTimestamp(), updatedBy: myName() };
    if (p.topic) upd.topic = p.topic;
    if (/R\d-\d|R\d 총평/.test(main.overlap || "") || !main.overlap) upd.overlap = p.overlap;
    if (parts.length > 1) {
      for (const f of ["location", "current", "response", "refs", "note"]) {
        const vals = parts.map(x => [itemLabel(x), (x[f] || "").trim()]).filter(v => v[1]);
        if (!vals.length) continue;
        upd[f] = (f === "location" || f === "current") && vals.length > 1 ? vals.map(([l, v]) => `[${l}]\n${v}`).join("\n\n") : vals.map(v => v[1]).join("\n");
      }
      const statuses = parts.map(x => x.status || "미착수").filter(s => s !== "미착수");
      if ((main.status || "미착수") === "미착수" && statuses.length) upd.status = statuses[0];
      const owners = parts.map(x => x.owner).filter(Boolean);
      if (!main.owner && owners.length) upd.owner = owners[0];
    }
    await updateDoc(doc(db, "items", main.id), upd);
    for (const m of parts.slice(1)) {
      const cs = await getDocs(collection(db, "items", m.id, "comments"));
      for (const c of cs.docs) { await addDoc(collection(db, "items", main.id, "comments"), { ...c.data(), text: `[${itemLabel(m)}에 달렸던 댓글] ` + c.data().text }); await deleteDoc(c.ref); }
      await deleteDoc(doc(db, "items", m.id));
    }
    done.push(p.id);
  }
  // 팀이 추가한 항목 번호 매기기
  let n = V2_PLAN.length;
  const planned = new Set(V2_PLAN.flatMap(p => [p.id, ...(p.merge || [])]));
  for (const it of S.items.slice().sort((a, b) => (a.order || 0) - (b.order || 0))) {
    if (planned.has(it.id)) continue;
    n += 1;
    await updateDoc(doc(db, "items", it.id), { no: n, order: n, sources: it.sources || [] });
  }
  await setDoc(doc(db, "meta", "app"), { schema: 2, at: serverTimestamp(), by: myName() });
  await writeLog("대응 항목 통합", "심사평 대응", "", "심사 의견 11건", `대응 항목 ${V2_PLAN.length}개 (+팀 추가 ${n - V2_PLAN.length}개)`);
  return { done, total: n };
}
