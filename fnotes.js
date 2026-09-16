// 대응 항목 칸의 옆 메모 (Word 메모처럼 문장을 골라 여백에 접어 두는 메모)
import {
  S, h, db, toast, fmt, errMsg, myName, writeLog, cut, copyText, scheduleRender, confirmButton, autosize,
  itemById, codeText, saveOpen, lsGet, lsSet,
  doc, updateDoc, addDoc, deleteDoc, collection, serverTimestamp, arrayUnion
} from "./core.js?v=8";

export const KIND = { ai: "AI에게", team: "팀원에게" };
const F = { selbar: null, pop: null, focus: null, showResolved: lsGet("fnResolved") === "1" };

export function memoOn(itemId) { return S.open.has(itemId + ":memo"); }
export function setMemo(itemId, on) {
  if (on) S.open.add(itemId + ":memo"); else S.open.delete(itemId + ":memo");
  saveOpen(); scheduleRender();
}
export function notesFor(itemId, field) {
  return S.fnotes.filter(n => n.itemId === itemId && (!field || n.field === field))
    .sort((a, b) => (a.start || 0) - (b.start || 0));
}
export function openCount(itemId, field) { return notesFor(itemId, field).filter(n => !n.resolved).length; }
export function showResolved() { return F.showResolved; }
export function setShowResolved(v) { F.showResolved = v; lsSet("fnResolved", v ? "1" : "0"); scheduleRender(); }
export function notesSig(itemId) {
  return notesFor(itemId).map(n => [n.id, n.text, n.resolved, n.quote, n.kind, n.to, (n.replies || []).length, n.start]).concat([[F.showResolved, F.focus]]);
}

function isAiAnswered(n) { return (n.replies || []).some(r => r.n === "Claude"); }
function statusOf(n) {
  if (n.resolved) return ["해결", "st-done"];
  const rs = n.replies || [];
  if (n.kind === "ai") return isAiAnswered(n) ? ["AI 답변 있음", "st-ans"] : ["AI 답변 대기", "st-wait"];
  return rs.length ? [`답글 ${rs.length}`, "st-ans"] : ["답변 대기", "st-wait"];
}

// 본문이 바뀌어도 인용한 글자를 다시 찾는다 (앞뒤 문맥이 맞는 위치 우선)
export function anchorOf(text, n) {
  if (!n.quote) return null;
  const idx = [];
  for (let i = text.indexOf(n.quote); i >= 0 && idx.length < 60; i = text.indexOf(n.quote, i + 1)) idx.push(i);
  if (!idx.length) return null;
  let best = idx[0], score = -Infinity;
  for (const s of idx) {
    let sc = 0;
    if (n.prefix && text.slice(Math.max(0, s - n.prefix.length), s) === n.prefix) sc += 100;
    if (n.suffix && text.slice(s + n.quote.length, s + n.quote.length + n.suffix.length) === n.suffix) sc += 100;
    sc -= Math.abs(s - (n.start || 0)) / 1000;
    if (sc > score) { score = sc; best = s; }
  }
  return { start: best, end: best + n.quote.length };
}

function textWithMarks(text, notes) {
  const spans = [];
  for (const n of notes) { const a = anchorOf(text, n); if (a) spans.push({ ...a, n }); }
  const cuts = new Set([0, text.length]);
  for (const s of spans) { cuts.add(s.start); cuts.add(s.end); }
  const pts = [...cuts].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const seg = text.slice(a, b);
    const on = spans.filter(s => s.start <= a && s.end >= b).map(s => s.n);
    if (!on.length) { out.push(document.createTextNode(seg)); continue; }
    const kinds = new Set(on.map(n => n.kind));
    const cls = "nf-mark " + (kinds.size > 1 ? "k-both" : "k-" + [...kinds][0]) + (on.some(n => n.id === F.focus) ? " focus" : "");
    out.push(h("mark", { class: cls, dataset: { ids: on.map(n => n.id).join(" ") }, text: seg,
      onclick: () => { const id = on[0].id; openNote(on[0].itemId, id); } }));
  }
  return { nodes: out, found: new Set(spans.map(s => s.n.id)) };
}

function openNote(itemId, id) {
  S.open.add(itemId + ":fn:" + id); saveOpen();
  F.focus = id; scheduleRender();
  setTimeout(() => { const el = document.getElementById("fn-" + id); if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, 120);
}
function hot(id, on) {
  document.querySelectorAll("mark.nf-mark").forEach(m => { if ((m.dataset.ids || "").split(" ").includes(id)) m.classList.toggle("hot", on); });
}

export function renderNoteField(it, path, field, flabel, value) {
  const text = value || "";
  const all = notesFor(it.id, field);
  const visible = all.filter(n => F.showResolved || !n.resolved);
  const { nodes, found } = textWithMarks(text, visible.filter(n => !n.resolved || F.showResolved));
  const box = h("div", { class: "nf-text" + (text ? "" : " nf-empty"), dataset: { item: it.id, field, flabel, path } },
    text ? nodes : "(비어 있음)");
  const hiddenDone = all.filter(n => n.resolved).length;
  const margin = h("div", { class: "nf-margin" },
    visible.map(n => noteCard(it, n, found.has(n.id))),
    !F.showResolved && hiddenDone ? h("button", { class: "linkish", text: `해결된 메모 ${hiddenDone}개 보기`, onclick: () => setShowResolved(true) }) : null,
    null);
  return h("div", { class: "nf-wrap" }, box, margin);
}

function noteCard(it, n, anchored) {
  const key = it.id + ":fn:" + n.id;
  const open = S.open.has(key);
  const [stText, stCls] = statusOf(n);
  const toggle = () => { if (S.open.has(key)) S.open.delete(key); else S.open.add(key); F.focus = S.open.has(key) ? n.id : null; saveOpen(); scheduleRender(); };
  const head = h("div", { class: "nf-head", onclick: toggle },
    h("span", { class: "nf-kind k-" + n.kind, text: n.kind === "ai" ? "AI에게" : (n.to ? `${n.to}에게` : "팀원에게") }),
    h("span", { class: "nf-st " + stCls, text: stText }),
    h("span", { class: "nf-who", text: n.name || "" }),
    h("span", { class: "nf-caret", text: open ? "▾" : "▸" }));
  const card = h("div", { class: "nf-card k-" + n.kind + (open ? " open" : "") + (n.resolved ? " done" : "") + (F.focus === n.id ? " focus" : ""), id: "fn-" + n.id,
    onmouseenter: () => hot(n.id, true), onmouseleave: () => hot(n.id, false) }, head);
  if (!open) {
    card.append(h("div", { class: "nf-snip", onclick: toggle, text: cut(n.text || "", 46) }));
    return card;
  }
  card.append(
    h("div", { class: "nf-quote", text: "“" + cut(n.quote, 120) + "”" + (anchored ? "" : "  (본문이 바뀌어 위치를 찾지 못했습니다)") }),
    h("div", { class: "nf-body", text: n.text || "" }),
    h("div", { class: "nf-meta", text: fmt(n.createdAt) }));
  for (const r of n.replies || []) {
    card.append(h("div", { class: "nf-reply" + (r.n === "Claude" ? " ai" : "") },
      h("span", { class: "nf-who", text: r.n }), " ", h("span", { class: "nf-meta", text: r.at ? fmt(new Date(r.at)) : "" }),
      h("div", { class: "nf-body", text: r.t })));
  }
  const dk = "fnr#" + it.id + "#" + n.id;
  const ta = h("textarea", { class: "auto", rows: 1, placeholder: "답글 (Ctrl+Enter)", dataset: { key: dk }, value: S.dirty[dk] || "",
    oninput: e => { S.dirty[dk] = e.target.value; autosize(e.target); },
    onkeydown: e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); reply(n, dk, e.target); } } });
  const mine = n.uid === S.user.uid;
  card.append(ta, h("div", { class: "nf-actions" },
    h("button", { class: "small", text: "답글", onclick: () => reply(n, dk, ta) }),
    h("button", { class: "small", text: n.resolved ? "다시 열기" : "해결", onclick: () => resolve(it, n, !n.resolved) }),
    mine ? h("button", { class: "small", text: "수정", onclick: () => editNote(n) }) : null,
    (mine || S.isAdmin) ? confirmButton("삭제", () => removeNote(it, n), "small danger", "delfn:" + it.id + ":" + n.id) : null));
  return card;
}

async function reply(n, dk, ta) {
  const t = (ta.value || "").trim();
  if (!t) return;
  try {
    await updateDoc(doc(db, "fnotes", n.id), { replies: arrayUnion({ t, n: myName(), u: S.user.uid, at: Date.now() }) });
    delete S.dirty[dk]; ta.value = "";
    await writeLog("옆 메모 답글", itemName(n), fieldName(n), cut(n.text, 60), t);
  } catch (e) { toast("답글 저장 실패: " + errMsg(e)); }
}
async function resolve(it, n, v) {
  try { await updateDoc(doc(db, "fnotes", n.id), { resolved: v, resolvedBy: myName() }); await writeLog(v ? "옆 메모 해결" : "옆 메모 다시 열기", itemName(n), fieldName(n), "", cut(n.text, 80)); }
  catch (e) { toast(errMsg(e)); }
}
async function removeNote(it, n) {
  try { await deleteDoc(doc(db, "fnotes", n.id)); await writeLog("옆 메모 삭제", itemName(n), fieldName(n), cut(n.text, 80), ""); }
  catch (e) { toast("삭제 실패: " + errMsg(e)); }
}
function editNote(n) {
  closeAll();
  const ta = h("textarea", { class: "pop-ta", rows: 4, value: n.text || "" });
  const save = async () => {
    const t = ta.value.trim();
    if (!t) return;
    try { await updateDoc(doc(db, "fnotes", n.id), { text: t }); await writeLog("옆 메모 수정", itemName(n), fieldName(n), cut(n.text, 80), t); closeAll(); }
    catch (e) { toast(errMsg(e)); }
  };
  const el = document.getElementById("fn-" + n.id);
  const r = el ? el.getBoundingClientRect() : { left: 200, bottom: 200 };
  showPop(r, h("strong", { text: "메모 수정" }), ta, save);
  setTimeout(() => ta.focus(), 0);
}

function itemName(n) { const it = itemById(n.itemId); return it ? `대응 ${it.no || "-"}` : "대응"; }
function fieldName(n) { return n.flabel || n.field; }

/* ---------- 선택 → 메모 달기 ---------- */
function selInfo() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  const el = n => (n.nodeType === 1 ? n : n.parentElement);
  const box = el(r.startContainer)?.closest(".nf-text");
  if (!box || box !== el(r.endContainer)?.closest(".nf-text") || box.classList.contains("nf-empty")) return null;
  const pre = document.createRange();
  pre.selectNodeContents(box);
  pre.setEnd(r.startContainer, r.startOffset);
  const start = pre.toString().length;
  const quote = r.toString();
  if (!quote.trim()) return null;
  return { box, start, end: start + quote.length, quote, rect: r.getBoundingClientRect() };
}
function closeAll() {
  if (F.selbar) { F.selbar.remove(); F.selbar = null; }
  if (F.pop) { F.pop.remove(); F.pop = null; }
}
function showPop(rect, title, body, onSave, extra) {
  if (F.pop) { F.pop.remove(); F.pop = null; }
  const x = Math.min(window.innerWidth - 380, Math.max(8, rect.left));
  const y = Math.min(window.innerHeight - 300, Math.max(8, rect.bottom + 8));
  const pop = h("div", { class: "popover fn-pop", style: `left:${x}px;top:${y}px` },
    h("div", { class: "bar" }, title, h("span", { class: "grow" }), h("button", { class: "small", text: "닫기", onclick: closeAll })),
    extra || null, body,
    h("div", { class: "bar" }, h("span", { class: "grow" }), h("button", { class: "primary", text: "저장 (Ctrl+Enter)", onclick: onSave })));
  body.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSave(); } if (e.key === "Escape") closeAll(); });
  document.body.append(pop);
  F.pop = pop;
}
function openForm(info, kind) {
  const { item, field, flabel, path } = info.box.dataset;
  const it = itemById(item);
  const full = (it && it[field]) || "";
  const ta = h("textarea", { class: "pop-ta", rows: 4, placeholder: kind === "ai" ? "AI에게 물어볼 내용 (예: 이 용어가 무슨 뜻인지, 근거가 무엇인지)" : "팀원에게 물어볼 내용" });
  const people = [...new Set(S.members.filter(m => m.approved !== false).map(m => m.name).filter(Boolean))].filter(nm => nm !== myName());
  const to = kind === "team" ? h("select", { class: "fn-to" }, h("option", { value: "", text: "받는 사람: 팀 전체" }), people.map(p => h("option", { value: p, text: `받는 사람: ${p}` }))) : null;
  const save = async () => {
    const t = ta.value.trim();
    if (!t) { toast("메모 내용을 적어 주세요."); return; }
    const data = {
      target: path, itemId: item, field, flabel, kind, to: to ? to.value : "",
      quote: info.quote, start: info.start,
      prefix: full.slice(Math.max(0, info.start - 30), info.start), suffix: full.slice(info.end, info.end + 30),
      text: t, uid: S.user.uid, name: myName(), createdAt: serverTimestamp(), replies: [], resolved: false
    };
    try {
      const ref = await addDoc(collection(db, "fnotes"), data);
      await writeLog("옆 메모 추가", it ? `대응 ${it.no || "-"}` : "대응", flabel, "", `[${KIND[kind]}${data.to ? " " + data.to : ""}] “${cut(info.quote, 40)}” ${t}`);
      closeAll();
      window.getSelection().removeAllRanges();
      S.open.add(item + ":fn:" + ref.id); saveOpen();
      F.focus = ref.id;
      scheduleRender();
    } catch (e) { toast("저장 실패: " + errMsg(e)); }
  };
  showPop(info.rect, h("strong", { class: "nf-kind k-" + kind, text: kind === "ai" ? "AI에게 묻는 메모" : "팀원에게 묻는 메모" }), ta, save,
    h("div", null, h("div", { class: "mc-quote", text: "“" + cut(info.quote, 160) + "”" }), to));
  setTimeout(() => ta.focus(), 0);
}
document.addEventListener("mouseup", ev => {
  if (ev.target.closest(".fn-selbar,.fn-pop")) return;
  if (!ev.target.closest(".nf-text")) return;
  setTimeout(() => {
    const info = selInfo();
    if (F.selbar) { F.selbar.remove(); F.selbar = null; }
    if (!info) return;
    const bar = h("div", { class: "selbar fn-selbar", style: `left:${Math.min(window.innerWidth - 260, Math.max(8, info.rect.left))}px;top:${Math.min(window.innerHeight - 50, Math.max(8, info.rect.top - 42))}px` },
      h("button", { class: "k-ai", text: "AI에게 묻기", onmousedown: e => e.preventDefault(), onclick: () => { F.selbar.remove(); F.selbar = null; openForm(info, "ai"); } }),
      h("button", { class: "k-team", text: "팀원에게 묻기", onmousedown: e => e.preventDefault(), onclick: () => { F.selbar.remove(); F.selbar = null; openForm(info, "team"); } }));
    document.body.append(bar);
    F.selbar = bar;
  }, 10);
});
document.addEventListener("mousedown", e => {
  if (F.selbar && !e.target.closest(".fn-selbar")) { F.selbar.remove(); F.selbar = null; }
  if (F.pop && !e.target.closest(".fn-pop") && !e.target.closest(".nf-actions")) { F.pop.remove(); F.pop = null; }
});

/* ---------- 요약, 복사 ---------- */
export function noteSummary() {
  const open = S.fnotes.filter(n => !n.resolved);
  const aiWait = open.filter(n => n.kind === "ai" && !isAiAnswered(n)).length;
  const teamOpen = open.filter(n => n.kind === "team");
  const me = myName();
  const toMe = teamOpen.filter(n => n.uid !== S.user.uid && (!n.to || n.to === me) && !(n.replies || []).some(r => r.u === S.user.uid)).length;
  return { total: open.length, aiWait, team: teamOpen.length, toMe, aiOpen: open.filter(n => n.kind === "ai").length };
}
function groupLines(notes) {
  const L = [];
  const byField = new Map();
  for (const n of notes) { const k = n.itemId + "|" + n.field; if (!byField.has(k)) byField.set(k, []); byField.get(k).push(n); }
  for (const [k, ns] of byField) {
    const [itemId, field] = k.split("|");
    const it = itemById(itemId);
    const flabel = ns[0].flabel || field;
    const c = it ? codeText(it) : "";
    L.push(`## 대응 ${it ? it.no || "-" : "?"}${c ? " (" + c + ")" : ""} · ${flabel}`);
    L.push("칸 전체 내용:", ...String((it && it[field]) || "").split("\n").map(x => "> " + x), "");
    for (const n of ns) {
      const full = (it && it[field]) || "";
      const a = anchorOf(full, n);
      const ctx = a ? `…${full.slice(Math.max(0, a.start - 40), a.start)}【${n.quote}】${full.slice(a.end, a.end + 40)}…` : `【${n.quote}】 (본문에서 위치를 찾지 못함)`;
      L.push(`- [${n.kind === "ai" ? "AI에게" : (n.to ? n.to + "에게" : "팀원에게")}] ${n.name} (${fmt(n.createdAt)}) · 메모 ID ${n.id}`);
      L.push(`  - 선택한 부분: ${ctx.replace(/\n/g, " ")}`);
      L.push(`  - 질문: ${String(n.text).replace(/\n/g, " ")}`);
      for (const r of n.replies || []) L.push(`  - 답글 ${r.n}: ${String(r.t).replace(/\n/g, " ")}`);
    }
    L.push("");
  }
  return L;
}
export function aiQuestionsMarkdown() {
  const notes = S.fnotes.filter(n => n.kind === "ai" && !n.resolved);
  return ["# 리젝 대응 작업실 · AI에게 묻는 메모", "아래 질문마다 선택한 부분과 칸 전체 내용을 함께 붙였습니다. 질문마다 답해 주세요.", "", ...groupLines(notes)].join("\n");
}
export function itemNotesLines(itemId) {
  const notes = notesFor(itemId).filter(n => !n.resolved);
  if (!notes.length) return [];
  return ["- 옆 메모 (해결 안 됨):", ...notes.map(n => `  - [${n.kind === "ai" ? "AI에게" : "팀원에게"}] ${n.flabel || n.field} “${cut(n.quote, 60)}”: ${String(n.text).replace(/\n/g, " ")}${(n.replies || []).map(r => ` / ${r.n}: ${String(r.t).replace(/\n/g, " ")}`).join("")}`)];
}
export function copyAiQuestions() {
  const md = aiQuestionsMarkdown();
  if (!S.fnotes.some(n => n.kind === "ai" && !n.resolved)) { toast("해결되지 않은 AI 질문 메모가 없습니다."); return; }
  copyText(md);
}

/* ---------- 메모 카드를 본문 표시 높이에 맞춰 배치 (Word 여백 메모처럼) ---------- */
export function layoutNotes(root = document) {
  root.querySelectorAll(".nf-wrap").forEach(w => {
    const text = w.querySelector(".nf-text"), mg = w.querySelector(".nf-margin");
    if (!text || !mg) return;
    const cards = [...mg.querySelectorAll(".nf-card")];
    cards.forEach(c => { c.style.marginTop = "0px"; });
    if (getComputedStyle(w).gridTemplateColumns.trim().split(/\s+/).length < 2) return; // 좁은 화면: 아래로 쌓기
    const base = mg.getBoundingClientRect().top;
    const marks = [...text.querySelectorAll("mark.nf-mark")];
    let cur = 0;
    cards.forEach((c, i) => {
      const id = c.id.slice(3);
      const m = marks.find(x => (x.dataset.ids || "").split(" ").includes(id));
      const want = m ? m.getBoundingClientRect().top - base - 2 : cur;
      const top = Math.max(want, cur + (i ? 5 : 0));
      c.style.marginTop = (top - cur) + "px";
      cur = top + c.offsetHeight;
    });
  });
}
window.addEventListener("resize", () => layoutNotes());
