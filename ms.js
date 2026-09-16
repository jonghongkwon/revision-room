import {
  S, h, db, toast, fmt, tsMs, errMsg, myName, writeLog, scheduleRender, confirmButton, keyed, sigOf, patchChildren,
  itemLabel, itemById, itemFull, codeText, lsGet, lsSet, colorFor, cut, copyText, modal, editArea, autosize, restoreFocus,
  doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc, collection, query, where, serverTimestamp, writeBatch, arrayUnion
} from "./core.js?v=10";
import { parseMarkup, plainOf, diffMarkup, originalPieces, insertedPieces, fmtNode, markupNodes, tableToText, textToTable } from "./markup.js?v=10";
import { getFileURL, fileByPath } from "./files.js?v=10";

export const M = {
  blocks: [], byId: new Map(), plain: new Map(), loaded: false, loading: false, error: "",
  view: lsGet("msView") || "markup",
  show: Object.assign({ memo: true, reviewer: true, issue: true, bookmark: true, rev: true }, JSON.parse(lsGet("msShow") || "{}")),
  hideResolved: lsGet("msHideRes") === "1",
  expandAll: lsGet("msExpand") === "1",
  openCards: new Set((() => { try { return JSON.parse(lsGet("msCards") || "[]"); } catch (e) { return []; } })()),
  side: lsGet("msSide") || "toc",
  sideFilter: { type: "", item: "", state: "open" },
  q: "", hits: [], hitIdx: -1,
  pendingScroll: null, activeAnn: null, editor: null, popover: null
};
const TYPE_LABEL = { memo: "메모", reviewer: "리뷰어 지적", issue: "문제", bookmark: "책갈피" };
const TYPE_RANK = { bookmark: 0, reviewer: 1, issue: 2, memo: 3 };
const annOrder = (x, y) => ((TYPE_RANK[x.type] ?? 9) - (TYPE_RANK[y.type] ?? 9)) || (tsMs(x.createdAt) - tsMs(y.createdAt));
const VIEW_LABEL = { orig: "원문", markup: "변경 표시", final: "최종본" };
const TEXT_TYPES = new Set(["title", "authors", "affil", "h1", "h2", "h3", "p", "caption", "tnote", "ref"]);
const SPECIAL = ["μ", "°", "×", "−", "–", "—", "±", "≤", "≥", "≈", "~", "→", "↔", "·", "Ω", "α", "β", "γ", "δ", "Δ", "σ", "τ", "θ", "λ", "π", "ε", "²", "³", "⁻", "¹", "⁰", "½", "‰", "Å", "℃", "′", "″", "“", "”", "‘", "’"];

/* ---------- 불러오기 ---------- */
export async function loadManuscript() {
  if (M.loaded || M.loading) return;
  M.loading = true;
  try {
    const snap = await getDocs(collection(db, "msParts"));
    const parts = snap.docs.map(d => d.data()).sort((a, b) => a.idx - b.idx);
    M.blocks = parts.flatMap(p => JSON.parse(p.json));
    M.byId.clear(); M.plain.clear();
    for (const b of M.blocks) { M.byId.set(b.id, b); M.plain.set(b.id, b.type === "table" ? tableToText(b.rows) : plainOf(b.t || "")); }
    M.loaded = M.blocks.length > 0;
    M.error = M.loaded ? "" : "원고가 아직 올라가지 않았습니다.";
  } catch (e) { M.error = "원고를 불러오지 못했습니다: " + errMsg(e); }
  M.loading = false;
  scheduleRender();
}
export async function importManuscript(data) {
  if (!S.isAdmin) throw new Error("관리자만 올릴 수 있습니다.");
  const json = JSON.stringify(data.blocks);
  const parts = [];
  let cur = [], size = 2;
  for (const b of data.blocks) {
    const s = JSON.stringify(b);
    const bytes = new TextEncoder().encode(s).length + 1;
    if (size + bytes > 700000 && cur.length) { parts.push(cur); cur = []; size = 2; }
    cur.push(b); size += bytes;
  }
  if (cur.length) parts.push(cur);
  const batch = writeBatch(db);
  parts.forEach((p, idx) => batch.set(doc(db, "msParts", "p" + idx), { idx, json: JSON.stringify(p), at: serverTimestamp() }));
  await batch.commit();
  M.loaded = false;
  await loadManuscript();
  await writeLog("원고 올림", "원고", "", "", `${data.blocks.length}개 블록, ${parts.length}개 조각, ${json.length}자`);
  return { blocks: data.blocks.length, parts: parts.length };
}
window.__importManuscript = importManuscript;

/* ---------- 데이터 정리 ---------- */
const revMap = () => { const m = new Map(); for (const r of S.revs) m.set(r.id, r); return m; };
function annsFor(bid) {
  return S.anns.filter(a => a.bid === bid && M.show[a.type] !== false && !(M.hideResolved && a.resolved));
}
function lockFor(bid) {
  const l = S.locks.find(x => x.id === bid);
  if (!l || l.uid === S.user.uid) return null;
  return Date.now() - tsMs(l.at) < 15 * 60 * 1000 ? l : null;
}
function insertsAfter(revs) {
  const m = new Map();
  for (const r of revs.values()) if (r.kind === "insert" && r.insertAfter) {
    if (!m.has(r.insertAfter)) m.set(r.insertAfter, []);
    m.get(r.insertAfter).push(r);
  }
  for (const list of m.values()) list.sort((a, b) => (a.order || 0) - (b.order || 0));
  return m;
}
// 문서 순서대로 [원래 블록 또는 삽입 블록]
function sequence(revs) {
  const ins = insertsAfter(revs);
  const out = [];
  const push = (id, depth) => {
    for (const r of ins.get(id) || []) { out.push({ inserted: true, rev: r, id: r.id }); if (depth < 50) push(r.id, depth + 1); }
  };
  for (const b of M.blocks) { out.push({ inserted: false, b, id: b.id, rev: revs.get(b.id) }); push(b.id, 0); }
  return out;
}
export function blockLabel(bid) {
  const b = M.byId.get(bid);
  if (b) {
    const where = b.sec || "";
    const txt = b.type === "fig" ? `FIG. ${b.n} 그림` : b.type === "table" ? "표" : cut(M.plain.get(bid), 50);
    return (where ? where + " · " : "") + txt;
  }
  const r = S.revs.find(x => x.id === bid);
  if (r) {
    const after = M.byId.get(r.insertAfter);
    return `새 문단 (${after ? (after.sec || "") : "추가 문단 뒤"}) · ${cut(plainOf(r.text), 50)}`;
  }
  return "(위치 없음)";
}

/* ---------- 조각 -> DOM ---------- */
const diffCache = new Map();
function cachedDiff(base, text) {
  const k = base.length + ":" + text.length + ":" + sigOf([base, text]);
  if (!diffCache.has(k)) { if (diffCache.size > 400) diffCache.clear(); diffCache.set(k, diffMarkup(base, text)); }
  return diffCache.get(k);
}
function renderPieces(container, pieces, anns) {
  const bounds = new Set();
  const inl = anns.filter(a => !a.whole && a.end > a.start);
  for (const a of inl) { bounds.add(a.start); bounds.add(a.end); }
  const segs = [];
  for (const p of pieces) {
    if (!p.t) continue;
    if (p.o == null || !inl.length) { segs.push({ ...p, cover: [] }); continue; }
    const cuts = [0, p.t.length];
    for (const b of bounds) if (b > p.o && b < p.o + p.t.length) cuts.push(b - p.o);
    cuts.sort((x, y) => x - y);
    for (let i = 0; i < cuts.length - 1; i++) {
      const s = cuts[i], e = cuts[i + 1];
      if (e <= s) continue;
      const cover = inl.filter(a => a.start <= p.o + s && a.end >= p.o + e);
      segs.push({ kind: p.kind, t: p.t.slice(s, e), f: p.f, o: p.o + s, cover });
    }
  }
  // 같은 성격의 연속 조각을 하나의 span으로 합친다
  let cur = null, curKey = "";
  const emit = () => {
    if (!cur) return;
    const span = document.createElement("span");
    span.className = "pc " + cur.kind + (cur.cover.length ? " hl " + [...new Set(cur.cover.map(a => "hl-" + a.type))].join(" ") : "");
    if (cur.o != null) span.dataset.o = cur.o;
    if (cur.cover.length) span.dataset.anns = cur.cover.map(a => a.id).join(" ");
    for (const part of cur.parts) span.append(fmtNode(part.t, part.f));
    container.append(span);
    cur = null;
  };
  for (const s of segs) {
    const key = s.kind + "|" + s.cover.map(a => a.id).join(",");
    const contiguous = cur && (s.o == null ? cur.o == null : (cur.o != null && cur.o + cur.len === s.o));
    if (cur && key === curKey && contiguous) { cur.parts.push(s); cur.len += s.t.length; continue; }
    emit();
    cur = { kind: s.kind, o: s.o, len: s.t.length, cover: s.cover, parts: [s] };
    curKey = key;
  }
  emit();
}
function renderTable(rows, cellFn) {
  return h("div", { class: "tblwrap" }, h("table", { class: "mst" }, rows.map((r, ri) => h("tr", null, r.map((c, ci) => {
    const td = h(ri === 0 ? "th" : "td", { colspan: c.cs > 1 ? c.cs : null, rowspan: c.rs > 1 ? c.rs : null });
    cellFn(td, c, ri, ci);
    return td;
  })))));
}
function tableShapeSame(a, b) { return a.length === b.length && a.every((r, i) => r.length === b[i].length); }

/* ---------- 블록 한 줄 ---------- */
function blockContent(entry, revs) {
  const view = M.view;
  const wrap = h("div", { class: "blk" });
  if (entry.inserted) {
    const r = entry.rev;
    wrap.classList.add("t-" + (r.btype || "p"), "inserted");
    if (r.btype === "p" || !r.btype) wrap.classList.add("ind");
    wrap.style.setProperty("--rc", colorFor(r.author));
    if (view === "orig") { wrap.classList.add("hidden"); return wrap; }
    if (r.status === "거절" && view === "final") { wrap.classList.add("hidden"); return wrap; }
    const pieces = view === "final" ? parseMarkup(r.text).map(x => ({ kind: "eq", t: x.t, f: x.f, o: null })) : insertedPieces(r.text);
    if (r.status === "거절") wrap.classList.add("rejected");
    if (r.btype === "table") {
      wrap.append(renderTable(textToTable(r.text), (td, c) => { td.className = view === "final" ? "" : "ins"; td.append(markupNodes(c.t)); }));
    } else renderPieces(wrap, pieces, annsFor(r.id));
    return wrap;
  }
  const b = entry.b, rev = entry.rev;
  wrap.classList.add("t-" + b.type);
  if (b.ind) wrap.classList.add("ind");
  wrap.dataset.bid = b.id;
  const active = rev && rev.status !== "거절" && view !== "orig";
  if (rev) wrap.style.setProperty("--rc", colorFor(rev.author));
  const anns = annsFor(b.id);
  if (anns.some(a => a.whole)) wrap.classList.add("has-whole", ...new Set(anns.filter(a => a.whole).map(a => "w-" + a.type)));
  if (b.type === "fig") {
    const fig = h("figure", { class: "fig" });
    const meta = fileByPath(b.file);
    const img = h("img", { alt: `FIG. ${b.n}`, width: b.w, height: b.h, loading: "lazy" });
    if (meta) {
      getFileURL(b.file).then(u => { if (u) img.src = u; }).catch(() => { img.alt = "그림을 불러오지 못했습니다"; });
      fig.append(img);
    } else fig.append(h("div", { class: "fig-missing", text: `FIG. ${b.n} 그림 파일을 아직 올리지 않았습니다 (${b.file})` }));
    wrap.append(fig);
    return wrap;
  }
  if (b.type === "table") {
    if (active && rev.text !== undefined) {
      const newRows = textToTable(rev.text);
      if (view === "final") {
        const rows = tableShapeSame(b.rows, newRows) ? b.rows.map((r, i) => r.map((c, j) => ({ ...c, t: newRows[i][j].t }))) : newRows;
        wrap.append(renderTable(rows, (td, c) => td.append(markupNodes(c.t))));
      } else if (tableShapeSame(b.rows, newRows)) {
        wrap.append(renderTable(b.rows, (td, c, i, j) => {
          const nt = newRows[i][j].t;
          if (nt === c.t) td.append(markupNodes(c.t));
          else renderPieces(td, cachedDiff(c.t, nt).map(p => ({ ...p, o: null })), []);
        }));
      } else {
        wrap.append(h("div", { class: "tbl-old" }, renderTable(b.rows, (td, c) => { td.className = "del"; td.append(markupNodes(c.t)); })));
        wrap.append(h("div", { class: "tbl-new" }, renderTable(newRows, (td, c) => { td.className = "ins"; td.append(markupNodes(c.t)); })));
      }
      if (rev.del && view !== "final") wrap.classList.add("deleted");
      if (rev.del && view === "final") wrap.classList.add("hidden");
    } else {
      wrap.append(renderTable(b.rows, (td, c) => td.append(markupNodes(c.t))));
    }
    return wrap;
  }
  let pieces;
  if (!active) pieces = originalPieces(b.t);
  else if (view === "final") {
    if (rev.del) { wrap.classList.add("hidden"); return wrap; }
    pieces = parseMarkup(rev.text).map(x => ({ kind: "eq", t: x.t, f: x.f, o: null }));
  } else if (rev.del) pieces = originalPieces(b.t).map(p => ({ ...p, kind: "del" }));
  else pieces = cachedDiff(b.t, rev.text);
  if (rev && rev.status === "거절" && view !== "orig") wrap.classList.add("had-rejected");
  renderPieces(wrap, pieces, anns);
  return wrap;
}

function toolButtons(entry) {
  const bid = entry.id;
  const isText = entry.inserted ? entry.rev.btype !== "table" : TEXT_TYPES.has(entry.b.type);
  const isTable = entry.inserted ? entry.rev.btype === "table" : entry.b.type === "table";
  const lock = lockFor(bid);
  const box = h("div", { class: "blk-tools" });
  if (lock) box.append(h("span", { class: "lock", text: `${lock.name} 님이 수정 중` }));
  if ((isText || isTable) && M.view !== "orig") box.append(h("button", { class: "tb", text: "수정", title: "이 문단을 검토 모드로 수정", onclick: () => openEditor(entry) }));
  box.append(h("button", { class: "tb", text: "아래에 문단 추가", onclick: () => openEditor({ newAfter: bid, btype: "p" }) }));
  if (!entry.inserted || true) {
    box.append(h("button", { class: "tb", text: "문단 메모", onclick: e => openAnnForm(e, { bid, whole: true, type: "memo" }) }));
    box.append(h("button", { class: "tb", text: "문단에 지적 표시", onclick: e => openAnnForm(e, { bid, whole: true, type: "reviewer" }) }));
    box.append(h("button", { class: "tb", text: "책갈피", onclick: e => openAnnForm(e, { bid, whole: true, type: "bookmark" }) }));
  }
  return box;
}

function revCard(entry) {
  const r = entry.rev;
  const bid = entry.id;
  const statusCls = r.status === "수락" ? "ok" : r.status === "거절" ? "no" : "pend";
  const kindText = r.kind === "insert" ? "새 문단 추가" : r.del ? "문단 삭제 제안" : "수정 제안";
  return h("div", { class: "mc rev " + statusCls, style: `--rc:${colorFor(r.author)}` },
    h("div", { class: "mc-head" },
      h("span", { class: "chip rc", text: kindText }),
      h("span", { class: "chip st " + statusCls, text: r.status || "제안" }),
      h("span", { class: "meta", text: `${r.author || ""} · ${fmt(r.updatedAt)}` })),
    (r.items || []).length ? h("div", { class: "mc-items" }, r.items.map(id => h("span", { class: "chip item", text: itemShortName(itemById(id)) }))) : null,
    r.note ? h("div", { class: "mc-text", text: r.note }) : null,
    r.decidedBy ? h("div", { class: "meta", text: `${r.status} 처리: ${r.decidedBy} · ${fmt(r.decidedAt)}` }) : null,
    h("div", { class: "mc-actions" },
      r.status !== "수락" ? h("button", { class: "small", text: "수락", onclick: () => decide(r, "수락") }) : null,
      r.status !== "거절" ? h("button", { class: "small", text: "거절", onclick: () => decide(r, "거절") }) : null,
      r.status !== "제안" && r.status ? h("button", { class: "small", text: "제안으로 되돌리기", onclick: () => decide(r, "제안") }) : null,
      h("button", { class: "small", text: "편집", onclick: () => openEditor(entry) }),
      h("button", { class: "small", text: "이력", onclick: () => showHistory(bid) }),
      confirmButton(r.kind === "insert" ? "새 문단 지우기" : "원문으로 되돌리기", () => revertRev(r), "small danger", "rv:" + bid)));
}

function itemTag(it) {
  if (!it) return "(삭제된 항목)";
  const c = codeText(it);
  return (it.no ? `대응 ${it.no}` : "대응") + (c ? ` · ${c}` : "");
}
function annCard(a) {
  const cls = "mc ann a-" + a.type + (a.resolved ? " resolved" : "") + (M.activeAnn === a.id ? " active" : "");
  const open = M.expandAll || M.openCards.has(a.id) || S.dirty["reply#" + a.id] !== undefined;
  if (!open) {
    const first = String(a.text || "").split("\n")[0] || ("“" + (a.quote || "") + "”");
    const nrep = (a.replies || []).length;
    return h("div", { class: cls + " collapsed", dataset: { ann: a.id }, title: "눌러서 펼치기", onclick: () => activate(a.id, false) },
      h("div", { class: "mc-head" },
        h("span", { class: "chip t-" + a.type, text: TYPE_LABEL[a.type] + (a.whole ? " (문단)" : "") }),
        a.itemId ? h("span", { class: "chip item", text: itemTag(itemById(a.itemId)) }) : null,
        nrep ? h("span", { class: "meta", text: `답글 ${nrep}` }) : null,
        h("span", { class: "mc-caret", text: "▸" })),
      h("div", { class: "mc-sum", text: cut(first, 110) }));
  }
  const replyKey = "reply#" + a.id;
  const input = h("input", { type: "text", placeholder: "답글 (Enter)", dataset: { key: replyKey }, value: S.dirty[replyKey] || "",
    oninput: e => { S.dirty[replyKey] = e.target.value; },
    onkeydown: async e => {
      if (e.key !== "Enter" || e.isComposing) return;
      const t = e.target.value.trim(); if (!t) return;
      try {
        await updateDoc(doc(db, "anns", a.id), { replies: arrayUnion({ t, n: myName(), u: S.user.uid, at: Date.now() }) });
        delete S.dirty[replyKey]; e.target.value = "";
        await writeLog("답글", TYPE_LABEL[a.type], "", "", t);
      } catch (err) { toast("답글 실패: " + errMsg(err)); }
    } });
  return h("div", { class: cls, dataset: { ann: a.id }, onclick: e => { if (e.target.closest("button,input,textarea,select")) return; activate(a.id, false); } },
    h("div", { class: "mc-head" },
      h("span", { class: "chip t-" + a.type, text: TYPE_LABEL[a.type] + (a.whole ? " (문단 전체)" : "") }),
      a.itemId ? h("span", { class: "chip item", text: itemShortName(itemById(a.itemId)) }) : null,
      h("span", { class: "meta", text: `${a.name || ""} · ${fmt(a.createdAt)}` })),
    a.quote && !a.whole ? h("div", { class: "mc-quote", text: "“" + cut(a.quote, 120) + "”" }) : null,
    editArea("anns/" + a.id, "text", a.text, TYPE_LABEL[a.type], "내용", { placeholder: a.type === "bookmark" ? "책갈피 이름" : "내용", cls: "mc-ta" }),
    (a.replies || []).length ? h("div", { class: "replies" }, a.replies.map(r => h("div", { class: "reply" }, h("b", { text: r.n }), " ", h("span", { class: "meta", text: fmt(new Date(r.at)) }), h("div", { text: r.t })))) : null,
    h("div", { class: "mc-actions" }, input,
      M.expandAll ? null : h("button", { class: "small", text: "접기", onclick: () => { M.openCards.delete(a.id); saveCards(); if (M.activeAnn === a.id) M.activeAnn = null; scheduleRender(); } }),
      h("button", { class: "small", text: a.resolved ? "다시 열기" : "해결", onclick: async () => {
        try { await updateDoc(doc(db, "anns", a.id), { resolved: !a.resolved, resolvedBy: myName() }); await writeLog(a.resolved ? "다시 열기" : "해결", TYPE_LABEL[a.type], "", "", a.text); }
        catch (e) { toast(errMsg(e)); }
      } }),
      (a.uid === S.user.uid || S.isAdmin) ? confirmButton("삭제", async () => {
        try { await deleteDoc(doc(db, "anns", a.id)); await writeLog("표시 삭제", TYPE_LABEL[a.type], "", a.text, ""); } catch (e) { toast(errMsg(e)); }
      }, "small danger", "da:" + a.id) : null));
}

function rowFor(entry, revs) {
  const bid = entry.id;
  const rev = entry.inserted ? entry.rev : entry.rev;
  const anns = S.anns.filter(a => a.bid === bid && M.show[a.type] !== false).sort((x, y) => ((x.whole ? -1 : x.start) - (y.whole ? -1 : y.start)) || annOrder(x, y));
  const lock = lockFor(bid);
  const sig = sigOf([bid, M.view, M.show, M.hideResolved, M.expandAll, anns.map(a => M.openCards.has(a.id)), M.activeAnn && anns.some(a => a.id === M.activeAnn) ? M.activeAnn : 0,
    rev ? [rev.text, rev.status, rev.del, rev.items, rev.note, rev.author, rev.updatedAt, rev.decidedBy] : 0,
    anns.map(a => [a.id, a.start, a.end, a.type, a.text, a.resolved, (a.replies || []).length, a.itemId, S.dirty["reply#" + a.id] !== undefined, S.armed["da:" + a.id] > Date.now()]),
    lock ? lock.name : 0, S.armed["rv:" + bid] > Date.now(),
    entry.inserted ? 0 : (M.byId.get(bid).type === "fig" ? !!fileByPath(M.byId.get(bid).file) : 0),
    S.items.map(i => [i.id, i.no, i.topic])]);
  const content = blockContent(entry, revs);
  const hidden = content.classList.contains("hidden");
  const mg = h("div", { class: "mg" });
  if (!hidden) {
    if (rev && M.show.rev && M.view !== "orig") mg.append(revCard(entry));
    for (const a of anns) { if (M.hideResolved && a.resolved) continue; mg.append(annCard(a)); }
  }
  const row = h("div", { class: "row" + (hidden ? " gone" : "") + (entry.inserted ? " ins-row" : ""), id: "row-" + bid },
    h("div", { class: "blkcell" }, content, hidden ? null : toolButtons(entry)), mg);
  return keyed(row, bid, sig);
}

/* ---------- 사이드바 ---------- */
function sideToc(seq) {
  const counts = new Map();
  let curH = null;
  const hOf = new Map();
  for (const e of seq) {
    if (!e.inserted && /^h[123]$/.test(e.b.type)) curH = e.id;
    hOf.set(e.id, curH);
  }
  const bump = (bid, k) => { const hid = hOf.get(bid); if (!hid) return; const c = counts.get(hid) || { a: 0, r: 0 }; c[k]++; counts.set(hid, c); };
  for (const a of S.anns) if (!a.resolved) bump(a.bid, "a");
  for (const r of S.revs) bump(r.kind === "insert" ? r.id : r.id, "r");
  const out = [];
  for (const b of M.blocks) {
    if (/^h[123]$/.test(b.type)) {
      const c = counts.get(b.id);
      out.push(h("div", { class: "toc " + b.type, onclick: () => scrollToBlock(b.id) },
        h("span", { class: "toc-t", text: plainOf(b.t) }),
        c && c.a ? h("span", { class: "cnt a", title: "열린 표시", text: c.a }) : null,
        c && c.r ? h("span", { class: "cnt r", title: "수정", text: c.r }) : null));
    } else if (b.type === "caption" && /^\s*(\{b:)?\s*(FIG\.|TABLE)/.test(b.t)) {
      const label = plainOf(b.t).match(/^(FIG\. \d+|TABLE [IVX]+)/);
      out.push(h("div", { class: "toc fig", onclick: () => scrollToBlock(b.id), text: label ? label[1] : cut(plainOf(b.t), 20) }));
    }
  }
  return out;
}
function sideAnns(onlyBookmarks) {
  const f = M.sideFilter;
  let list = S.anns.slice();
  if (onlyBookmarks) list = list.filter(a => a.type === "bookmark");
  else {
    if (f.type) list = list.filter(a => a.type === f.type);
    if (f.item) list = list.filter(a => a.itemId === f.item);
    if (f.state === "open") list = list.filter(a => !a.resolved);
    if (f.state === "resolved") list = list.filter(a => a.resolved);
  }
  const order = new Map(M.blocks.map((b, i) => [b.id, i]));
  list.sort((a, b) => ((order.get(a.bid) ?? 1e9) - (order.get(b.bid) ?? 1e9)) || ((a.whole ? -1 : a.start) - (b.whole ? -1 : b.start)) || annOrder(a, b));
  const out = [];
  if (!onlyBookmarks) {
    out.push(h("div", { class: "side-filter" },
      h("select", { onchange: e => { f.type = e.target.value; scheduleRender(); } },
        h("option", { value: "", text: "모든 표시", selected: !f.type ? true : null }),
        Object.entries(TYPE_LABEL).map(([k, v]) => h("option", { value: k, text: v, selected: f.type === k ? true : null }))),
      h("select", { onchange: e => { f.item = e.target.value; scheduleRender(); } },
        h("option", { value: "", text: "모든 대응 항목" }),
        S.items.map(it => h("option", { value: it.id, text: itemShortName(it), selected: f.item === it.id ? true : null }))),
      h("select", { onchange: e => { f.state = e.target.value; scheduleRender(); } },
        [["open", "미해결만"], ["resolved", "해결됨만"], ["all", "전체"]].map(([v, l]) => h("option", { value: v, text: l, selected: f.state === v ? true : null })))));
  }
  if (!list.length) out.push(h("div", { class: "muted pad", text: onlyBookmarks ? "책갈피가 없습니다. 원고에서 글을 선택하거나 문단의 책갈피 버튼을 누르세요." : "표시가 없습니다." }));
  for (const a of list) out.push(h("div", { class: "side-item a-" + a.type + (a.resolved ? " resolved" : ""), onclick: () => { scrollToBlock(a.bid); activate(a.id, true); } },
    h("div", null, h("span", { class: "chip t-" + a.type, text: TYPE_LABEL[a.type] }), a.itemId ? h("span", { class: "chip item", text: itemShortName(itemById(a.itemId)) }) : null),
    h("div", { class: "si-t", text: a.type === "bookmark" ? (a.text || cut(a.quote, 60)) : cut(a.text || a.quote, 90) }),
    h("div", { class: "meta", text: `${a.name || ""} · ${cut(blockLabel(a.bid), 40)}` })));
  return out;
}
function sideRevs() {
  const order = new Map(M.blocks.map((b, i) => [b.id, i]));
  const pos = r => r.kind === "insert" ? (order.get(r.insertAfter) ?? 1e9) + 0.5 : (order.get(r.id) ?? 1e9);
  const list = S.revs.slice().sort((a, b) => pos(a) - pos(b));
  if (!list.length) return [h("div", { class: "muted pad", text: "수정 제안이 없습니다. 문단의 [수정] 버튼으로 시작하세요." })];
  return list.map(r => h("div", { class: "side-item", onclick: () => scrollToBlock(r.id) },
    h("div", null, h("span", { class: "chip st " + (r.status === "수락" ? "ok" : r.status === "거절" ? "no" : "pend"), text: r.status || "제안" }),
      (r.items || []).map(id => h("span", { class: "chip item", text: itemShortName(itemById(id)) }))),
    h("div", { class: "si-t", text: cut(blockLabel(r.id), 80) }),
    h("div", { class: "meta", text: `${r.author || ""} · ${fmt(r.updatedAt)}${r.note ? " · " + cut(r.note, 40) : ""}` })));
}
export function itemShortName(it) {
  if (!it) return "(삭제된 항목)";
  const c = codeText(it);
  return (it.no ? `대응 ${it.no}` : "대응") + (c ? ` (${c})` : "") + " · " + cut(it.topic || "", 18);
}

/* ---------- 도구 모음 ---------- */
function toolbar() {
  const revs = S.revs;
  const cnt = { 제안: 0, 수락: 0, 거절: 0 };
  for (const r of revs) cnt[r.status || "제안"] = (cnt[r.status || "제안"] || 0) + 1;
  const openAnns = S.anns.filter(a => !a.resolved).length;
  const seg = h("div", { class: "seg" }, Object.entries(VIEW_LABEL).map(([k, l]) =>
    h("button", { class: M.view === k ? "on" : "", text: l, title: k === "orig" ? "제출본 그대로" : k === "markup" ? "삭제는 취소선, 추가는 밑줄로 표시" : "수정을 반영한 모습(거절된 수정 제외)",
      onclick: () => { M.view = k; lsSet("msView", k); scheduleRender(); } })));
  const toggles = h("div", { class: "toggles" }, [["memo", "메모"], ["reviewer", "리뷰어 지적"], ["issue", "문제"], ["bookmark", "책갈피"], ["rev", "수정 카드"]].map(([k, l]) =>
    h("label", { class: "tg t-" + k }, h("input", { type: "checkbox", checked: M.show[k] !== false, onchange: e => { M.show[k] = e.target.checked; lsSet("msShow", JSON.stringify(M.show)); scheduleRender(); } }), l)),
    h("label", { class: "tg" }, h("input", { type: "checkbox", checked: M.hideResolved, onchange: e => { M.hideResolved = e.target.checked; lsSet("msHideRes", e.target.checked ? "1" : "0"); scheduleRender(); } }), "해결된 표시 숨기기"),
    h("label", { class: "tg", title: "끄면 카드마다 한 줄 요약만 보이고, 누르면 그 카드만 펼쳐집니다" }, h("input", { type: "checkbox", checked: M.expandAll, onchange: e => { M.expandAll = e.target.checked; lsSet("msExpand", e.target.checked ? "1" : "0"); scheduleRender(); } }), "카드 모두 펼치기"));
  const search = h("div", { class: "search" },
    h("input", { type: "text", placeholder: "원고 검색", value: M.q, dataset: { key: "ms#q" }, oninput: e => { M.q = e.target.value; clearTimeout(M.qt); M.qt = setTimeout(() => runSearch(true), 250); },
      onkeydown: e => { if (e.key === "Enter") { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); } } }),
    h("button", { class: "small", text: "이전", onclick: () => stepHit(-1) }),
    h("button", { class: "small", text: "다음", onclick: () => stepHit(1) }),
    h("span", { class: "meta hitcount", text: M.q ? `${M.hits.length ? M.hitIdx + 1 : 0}/${M.hits.length}` : "" }));
  const stats = h("div", { class: "meta", text: `수정 ${revs.length}건 (제안 ${cnt.제안} · 수락 ${cnt.수락} · 거절 ${cnt.거절}) · 열린 표시 ${openAnns}건` });
  const exp = h("div", { class: "exports" },
    h("button", { class: "small", text: "최종본 텍스트 복사", onclick: () => copyText(finalText()) }),
    h("button", { class: "small", text: "수정·표시 목록 복사", onclick: () => copyText(changeList()) }),
    h("button", { class: "small", text: "Word로 내보내기", title: "제출본 docx에 표시를 Word 메모로, 수정을 변경 추적으로 넣어 내려받기", onclick: () => import("./export.js?v=10").then(m => m.openExportDialog()).catch(e => toast("열지 못했습니다: " + errMsg(e))) }),
    h("button", { class: "small", text: "사용법", onclick: showHelp }));
  return h("div", { class: "ms-bar" }, h("div", { class: "ms-bar-row" }, h("span", { class: "muted", text: "보기" }), seg, search, h("span", { class: "grow" }), exp),
    h("div", { class: "ms-bar-row" }, toggles, h("span", { class: "grow" }), stats));
}
function showHelp() {
  modal("원고 검토 사용법", h("div", { class: "help" },
    h("p", { text: "글자를 드래그해서 선택하면 작은 메뉴가 뜹니다. 메모, 리뷰어 지적(어느 대응 항목인지 연결), 문제, 책갈피를 붙일 수 있습니다." }),
    h("p", { text: "문단에 마우스를 올리면 오른쪽 위에 [수정] [아래에 문단 추가] [문단 메모] [문단에 지적 표시] [책갈피] 버튼이 나옵니다." }),
    h("p", { text: "[수정]을 누르면 아래 편집 창이 열립니다. 원문 대비 삭제는 빨간 취소선, 추가는 색 밑줄로 바로 보입니다. 위첨자는 {^19}, 아래첨자는 {_2}, 기울임은 {i:c}, 굵게는 {b:FIG. 1.}로 적습니다. 편집 창의 버튼으로도 넣을 수 있습니다." }),
    h("p", { text: "수정할 때 관련 대응 항목을 체크하면, [심사평 대응] 탭의 해당 항목에 '원고 반영 내역'으로 자동 연결됩니다." }),
    h("p", { text: "보기 전환: 원문(제출본), 변경 표시(Word 검토 모드와 같음), 최종본(수정을 반영한 모습). 오른쪽 카드에서 수락·거절·이력 보기가 됩니다." }),
    h("p", { text: "왼쪽에는 목차, 책갈피, 표시 목록, 수정 목록이 있습니다. 누르면 해당 위치로 이동합니다." }),
    h("p", { text: "오른쪽 카드는 한 줄 요약으로 접혀 있습니다. 카드나 본문의 색 표시를 누르면 그 카드가 펼쳐지고, [접기]로 다시 접습니다. 위쪽의 '카드 모두 펼치기'를 켜면 전부 펼쳐집니다." }),
    h("h4", { text: "팀 작업 규칙 (요약)" }),
    h("ul", null,
      h("li", { text: "심사위원 요구는 R코드(R1-3 = 심사위원 1의 3번 요구), 팀 작업 단위는 '대응 N'으로 부릅니다. 모든 표시는 해당 대응 항목에 연결합니다." }),
      h("li", { text: "리뷰어 지적: 비판이 걸리는 위치에만. '[R코드] 지적: 문제인 점' + '원문 R코드: “심사평 영어 원문 그대로”'." }),
      h("li", { text: "메모: 그 위치에서 할 일. '[R코드] 대응: 무엇을 → 어떻게 → 근거' + '(근거: 대응 N 대응 방향 번호)'. 고치지 않는 참고 위치는 '대응(근거 위치)', 대응 방향 밖의 제안은 '(제안)'." }),
      h("li", { text: "문제: 심사평과 별개인 오류·불일치('[오류] …', '[R코드] 확인 필요: …'). 책갈피: 대응마다 1개 '[대응 N · R코드] 주제 · 주 수정 위치'." }),
      h("li", { text: "다른 사람의 대응 방향에 대한 의견은 심사평 대응 탭의 옆 메모(팀원에게 묻기)로 담당자에게 묻습니다." })),
    h("p", { class: "muted", text: "전체 규칙과 현재 표시 현황: 메모·자료 탭의 '원고 검토 작업 규칙 (대응 표시 체계)'" })));
}

/* ---------- 검색 ---------- */
function runSearch(jump) {
  M.hits = [];
  const docEl = document.getElementById("msdoc");
  if (CSS.highlights) CSS.highlights.delete("mssearch");
  const q = M.q.trim().toLowerCase();
  if (!docEl || !q) { M.hitIdx = -1; updateHitCount(); return; }
  const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement.closest(".mg,.blk-tools,.hidden") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  let n;
  while ((n = walker.nextNode())) {
    const t = n.data.toLowerCase();
    let i = t.indexOf(q);
    while (i >= 0) { const r = new Range(); r.setStart(n, i); r.setEnd(n, i + q.length); M.hits.push(r); i = t.indexOf(q, i + q.length); }
  }
  if (CSS.highlights && M.hits.length) CSS.highlights.set("mssearch", new Highlight(...M.hits));
  if (jump) { M.hitIdx = M.hits.length ? 0 : -1; showHit(); } else M.hitIdx = Math.min(M.hitIdx, M.hits.length - 1);
  updateHitCount();
}
function updateHitCount() { const el = document.querySelector(".hitcount"); if (el) el.textContent = M.q ? `${M.hits.length ? M.hitIdx + 1 : 0}/${M.hits.length}` : ""; }
function stepHit(d) { if (!M.hits.length) return; M.hitIdx = (M.hitIdx + d + M.hits.length) % M.hits.length; showHit(); updateHitCount(); }
function showHit() {
  const r = M.hits[M.hitIdx];
  if (!r) return;
  if (CSS.highlights) CSS.highlights.set("mscur", new Highlight(r));
  r.startContainer.parentElement.scrollIntoView({ block: "center" });
}

/* ---------- 이동·활성 ---------- */
export function scrollToBlock(bid) {
  const el = document.getElementById("row-" + bid);
  if (!el) { M.pendingScroll = bid; return; }
  el.scrollIntoView({ block: "center" });
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
}
function saveCards() { lsSet("msCards", JSON.stringify([...M.openCards].slice(-300))); }
function activate(annId, scrollCard) {
  const wasOpen = M.expandAll || M.openCards.has(annId);
  M.activeAnn = annId;
  if (!wasOpen) {
    M.openCards.add(annId); saveCards(); scheduleRender();
    if (scrollCard) setTimeout(() => { const c = document.querySelector(`.mc.ann[data-ann="${CSS.escape(annId)}"]`); if (c) c.scrollIntoView({ block: "nearest" }); }, 250);
  }
  document.querySelectorAll(".pc.active-hl").forEach(e => e.classList.remove("active-hl"));
  document.querySelectorAll(`.pc[data-anns~="${CSS.escape(annId)}"]`).forEach(e => e.classList.add("active-hl"));
  document.querySelectorAll(".mc.ann.active").forEach(e => e.classList.remove("active"));
  const card = document.querySelector(`.mc.ann[data-ann="${CSS.escape(annId)}"]`);
  if (card) { card.classList.add("active"); if (scrollCard) setTimeout(() => card.scrollIntoView({ block: "nearest" }), 50); }
}

/* ---------- 선택 -> 표시 ---------- */
function selectionInfo() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const startBlk = (range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer).closest(".blk");
  const endBlk = (range.endContainer.nodeType === 3 ? range.endContainer.parentElement : range.endContainer).closest(".blk");
  if (!startBlk || startBlk !== endBlk || !startBlk.dataset.bid) return { error: "한 문단 안에서만 선택할 수 있습니다. (새로 추가한 문단은 문단 메모를 쓰세요)" };
  let s = null, e = null;
  for (const pc of startBlk.querySelectorAll(".pc[data-o]")) {
    if (!range.intersectsNode(pc)) continue;
    const o = +pc.dataset.o, len = pc.textContent.length;
    let ls = 0, le = len;
    if (pc.contains(range.startContainer)) { const r = document.createRange(); r.selectNodeContents(pc); r.setEnd(range.startContainer, range.startOffset); ls = r.toString().length; }
    if (pc.contains(range.endContainer)) { const r = document.createRange(); r.selectNodeContents(pc); r.setEnd(range.endContainer, range.endOffset); le = r.toString().length; }
    if (le <= ls) continue;
    s = s == null ? o + ls : Math.min(s, o + ls);
    e = e == null ? o + le : Math.max(e, o + le);
  }
  if (s == null) return { error: "원문 글자를 선택해 주세요. (새로 추가된 글자에는 표시를 붙일 수 없습니다)" };
  const bid = startBlk.dataset.bid;
  return { bid, start: s, end: e, quote: (M.plain.get(bid) || "").slice(s, e), rect: range.getBoundingClientRect() };
}
function onDocMouseUp(ev) {
  if (ev.target.closest(".blk-tools,.mg,.popover,.selbar")) return;
  setTimeout(() => {
    const info = selectionInfo();
    closeSelbar();
    if (!info) return;
    if (info.error) { toast(info.error); return; }
    const bar = h("div", { class: "selbar", style: `left:${Math.min(window.innerWidth - 330, Math.max(8, info.rect.left))}px;top:${Math.min(window.innerHeight - 50, Math.max(8, info.rect.top - 42))}px` },
      Object.entries(TYPE_LABEL).map(([k, l]) => h("button", { class: "t-" + k, text: l, onmousedown: e => e.preventDefault(), onclick: e => { closeSelbar(); openAnnForm(e, { ...info, type: k }); } })));
    document.body.append(bar);
    M.selbar = bar;
  }, 10);
}
function closeSelbar() { if (M.selbar) { M.selbar.remove(); M.selbar = null; } }
function closePopover() { if (M.popover) { M.popover.remove(); M.popover = null; } }
function itemSelect(value, blank) {
  return h("select", { class: "pop-item" },
    h("option", { value: "", text: blank }),
    S.items.map(it => h("option", { value: it.id, text: `대응 ${it.no || "-"}${codeText(it) ? " (" + codeText(it) + ")" : ""} · ${cut(it.topic || "", 40)}`, selected: value === it.id ? true : null })));
}
function openAnnForm(ev, info) {
  closePopover();
  const x = Math.min(window.innerWidth - 380, Math.max(8, (info.rect ? info.rect.left : ev.clientX - 300)));
  const y = Math.min(window.innerHeight - 320, Math.max(8, (info.rect ? info.rect.bottom : ev.clientY) + 8));
  const ta = h("textarea", { class: "pop-ta", placeholder: info.type === "bookmark" ? "책갈피 이름" : info.type === "reviewer" ? "어떤 지적인지 (선택)" : "내용", rows: 3 });
  if (info.type === "bookmark") ta.value = cut(info.quote || blockLabel(info.bid), 40);
  const sel = itemSelect(info.itemId || "", info.type === "reviewer" ? "대응 항목 선택 (필수)" : "관련 대응 항목 (선택)");
  const save = async () => {
    if (info.type === "reviewer" && !sel.value) { toast("어느 대응 항목의 지적인지 선택해 주세요."); return; }
    const plain = M.plain.get(info.bid) || "";
    const data = {
      bid: info.bid, type: info.type, whole: !!info.whole,
      start: info.whole ? 0 : info.start, end: info.whole ? plain.length : info.end,
      quote: info.whole ? cut(plain, 200) : info.quote, text: ta.value.trim(), itemId: sel.value || "",
      uid: S.user.uid, name: myName(), createdAt: serverTimestamp(), resolved: false, replies: []
    };
    try {
      const ref = await addDoc(collection(db, "anns"), data);
      await writeLog(TYPE_LABEL[info.type] + " 추가", cut(blockLabel(info.bid), 60), "", "", data.text || data.quote);
      closePopover();
      window.getSelection().removeAllRanges();
      M.activeAnn = ref.id;
      M.openCards.add(ref.id); saveCards();
      scheduleRender();
    } catch (e) { toast("저장 실패: " + errMsg(e)); }
  };
  const pop = h("div", { class: "popover", style: `left:${x}px;top:${y}px` },
    h("div", { class: "bar" }, h("strong", { text: TYPE_LABEL[info.type] + (info.whole ? " (문단 전체)" : "") }), h("span", { class: "grow" }), h("button", { class: "small", text: "닫기", onclick: closePopover })),
    info.quote && !info.whole ? h("div", { class: "mc-quote", text: "“" + cut(info.quote, 160) + "”" }) : null,
    sel, ta,
    h("div", { class: "bar" }, h("span", { class: "grow" }), h("button", { class: "primary", text: "저장", onclick: save })));
  ta.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save(); if (e.key === "Escape") closePopover(); });
  document.body.append(pop);
  M.popover = pop;
  setTimeout(() => ta.focus(), 0);
}

/* ---------- 편집기 ---------- */
function openEditor(target) {
  closeEditor();
  let bid, base, text, kind, btype, insertAfter = null, rev = null, isTable = false;
  const revs = revMap();
  if (target.newAfter) {
    bid = "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    kind = "insert"; btype = target.btype || "p"; base = ""; text = ""; insertAfter = target.newAfter;
  } else if (target.inserted) {
    rev = target.rev; bid = rev.id; kind = "insert"; btype = rev.btype || "p"; base = ""; text = rev.text || ""; insertAfter = rev.insertAfter;
  } else {
    const b = target.b; bid = b.id; rev = revs.get(bid); btype = b.type;
    isTable = b.type === "table";
    base = isTable ? tableToText(b.rows) : b.t;
    text = rev && rev.text !== undefined && !rev.del ? rev.text : base;
    kind = isTable ? "table" : "edit";
  }
  if (btype === "table") isTable = true;
  const E = { bid, base, kind, btype, insertAfter, isTable };
  M.editor = E;
  setDoc(doc(db, "locks", bid), { uid: S.user.uid, name: myName(), at: serverTimestamp() }).catch(() => {});

  const ta = h("textarea", { class: "ed-ta mono", value: text, spellcheck: "false" });
  const prev = h("div", { class: "ed-prev blk " + (isTable ? "t-table" : "t-" + (btype === "p" ? "p" : btype)) });
  const refresh = () => {
    prev.replaceChildren();
    if (isTable) {
      const oldRows = kind === "insert" ? [] : textToTable(base), newRows = textToTable(ta.value);
      if (kind !== "insert" && tableShapeSame(oldRows, newRows)) {
        prev.append(renderTable(oldRows, (td, c, i, j) => { const nt = newRows[i][j].t; if (nt === c.t) td.append(markupNodes(c.t)); else renderPieces(td, diffMarkup(c.t, nt).map(p => ({ ...p, o: null })), []); }));
      } else {
        if (oldRows.length) prev.append(h("div", { class: "meta", text: "표 구조가 바뀌어 전체를 새 표로 표시합니다." }));
        prev.append(renderTable(newRows, (td, c) => { td.className = "ins"; td.append(markupNodes(c.t)); }));
      }
    } else renderPieces(prev, kind === "insert" ? insertedPieces(ta.value) : diffMarkup(base, ta.value).map(p => ({ ...p, o: null })), []);
  };
  let rt;
  ta.addEventListener("input", () => { clearTimeout(rt); rt = setTimeout(refresh, 150); });
  const wrapSel = (open, close) => {
    const s = ta.selectionStart, e = ta.selectionEnd;
    ta.setRangeText(open + ta.value.slice(s, e) + close, s, e, "end");
    ta.focus(); refresh();
  };
  const insertText = t => { ta.setRangeText(t, ta.selectionStart, ta.selectionEnd, "end"); ta.focus(); refresh(); };
  const items = new Set(rev ? rev.items || [] : []);
  const itemBoxes = h("div", { class: "ed-items" }, S.items.map(it => h("label", { class: "tg" },
    h("input", { type: "checkbox", checked: items.has(it.id), onchange: e => { if (e.target.checked) items.add(it.id); else items.delete(it.id); } }),
    `대응 ${it.no || "-"}${codeText(it) ? " (" + codeText(it) + ")" : ""} · ${cut(it.topic || "", 26)}`)));
  const note = h("input", { type: "text", class: "ed-note", placeholder: "수정 이유·설명 (심사평 대응과 연결해서 적으면 나중에 답변서 쓰기가 쉽습니다)", value: rev ? rev.note || "" : "" });
  const save = async (opts = {}) => {
    const newText = opts.del ? "" : ta.value;
    if (kind === "insert" && !newText.trim()) { toast("내용을 입력해 주세요."); return; }
    if (kind !== "insert" && !opts.del && newText === base) { toast("원문과 같습니다. 되돌리려면 [원문으로 되돌리기]를 쓰세요."); return; }
    const data = { bid, kind, btype, text: newText, base, del: !!opts.del, items: [...items], note: note.value.trim(),
      status: "제안", decidedBy: "", author: myName(), uid: S.user.uid, updatedAt: serverTimestamp() };
    if (kind === "insert") { data.insertAfter = insertAfter; data.order = rev ? rev.order || Date.now() : Date.now(); }
    try {
      await setDoc(doc(db, "revs", bid), data);
      await addDoc(collection(db, "revhist"), { bid, text: newText, del: !!opts.del, note: data.note, items: data.items, author: myName(), uid: S.user.uid, at: serverTimestamp(), action: opts.del ? "삭제 제안" : "저장" });
      await writeLog(opts.del ? "문단 삭제 제안" : kind === "insert" ? "새 문단" : "원고 수정", cut(blockLabel(kind === "insert" ? insertAfter : bid), 60), "", rev ? rev.text : base, newText);
      toast("저장했습니다.");
      closeEditor();
      scheduleRender();
    } catch (e) { toast("저장 실패: " + errMsg(e)); }
  };
  const tools = h("div", { class: "ed-tools" },
    h("button", { class: "small", title: "위첨자", onclick: () => wrapSel("{^", "}") }, "x", h("sup", { text: "2" })),
    h("button", { class: "small", title: "아래첨자", onclick: () => wrapSel("{_", "}") }, "x", h("sub", { text: "2" })),
    h("button", { class: "small", title: "기울임", onclick: () => wrapSel("{i:", "}") }, h("i", { text: "I" })),
    h("button", { class: "small", title: "굵게", onclick: () => wrapSel("{b:", "}") }, h("b", { text: "B" })),
    isTable ? h("span", { class: "meta", text: "표: 한 줄 = 한 행, 칸 구분 ' | ', 칸 안 줄바꿈 ' ¶ '" }) : null,
    h("span", { class: "specials" }, SPECIAL.map(c => h("button", { class: "sp", text: c, onclick: () => insertText(c) }))));
  const where = kind === "insert" ? "새 문단 · " + cut(blockLabel(insertAfter), 60) : cut(blockLabel(bid), 90);
  const panel = h("div", { class: "editor" },
    h("div", { class: "ed-head" }, h("strong", { text: kind === "insert" ? "새 문단 추가" : isTable ? "표 수정" : "문단 수정" }), h("span", { class: "meta", text: where }),
      h("span", { class: "grow" }), h("button", { class: "small", text: "창 크기", onclick: () => panel.classList.toggle("tall") }), h("button", { class: "small", text: "닫기 (Esc)", onclick: closeEditor })),
    h("div", { class: "ed-body" },
      h("div", { class: "ed-left" }, tools, ta, h("div", { class: "meta", text: "서식 표기: {^위첨자} {_아래첨자} {i:기울임} {b:굵게}. 저장하면 팀 전체에 '제안'으로 보입니다." })),
      h("div", { class: "ed-right" }, h("div", { class: "meta", text: kind === "insert" ? "미리보기" : "미리보기 (원문 대비 변경 표시)" }), prev)),
    h("div", { class: "ed-foot" },
      h("div", { class: "ed-foot-row" }, h("span", { class: "muted", text: "관련 대응 항목" }), itemBoxes),
      h("div", { class: "ed-foot-row" }, note,
        h("button", { class: "primary", text: "저장 (Ctrl+S)", onclick: () => save() }),
        kind !== "insert" ? h("button", { class: "danger", text: "이 문단 삭제 제안", onclick: () => save({ del: true }) }) : null,
        h("button", { text: "원문 다시 불러오기", onclick: () => { ta.value = base; refresh(); } }))));
  panel.addEventListener("keydown", e => {
    if (e.key === "Escape") closeEditor();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
  });
  document.body.append(panel);
  document.body.classList.add("editing");
  refresh();
  setTimeout(() => ta.focus(), 0);
  E.panel = panel;
  scrollToBlock(kind === "insert" ? insertAfter : bid);
}
function closeEditor() {
  const E = M.editor;
  if (!E) return;
  E.panel.remove();
  document.body.classList.remove("editing");
  deleteDoc(doc(db, "locks", E.bid)).catch(() => {});
  M.editor = null;
}
async function decide(r, status) {
  try {
    await updateDoc(doc(db, "revs", r.id), { status, decidedBy: status === "제안" ? "" : myName(), decidedAt: serverTimestamp() });
    await addDoc(collection(db, "revhist"), { bid: r.id, text: r.text, note: r.note || "", items: r.items || [], author: myName(), uid: S.user.uid, at: serverTimestamp(), action: status });
    await writeLog("수정 " + status, cut(blockLabel(r.id), 60), "", "", r.note || "");
  } catch (e) { toast(errMsg(e)); }
}
async function revertRev(r) {
  try {
    await deleteDoc(doc(db, "revs", r.id));
    await addDoc(collection(db, "revhist"), { bid: r.id, text: "", note: "", items: [], author: myName(), uid: S.user.uid, at: serverTimestamp(), action: r.kind === "insert" ? "새 문단 지움" : "원문으로 되돌림" });
    await writeLog(r.kind === "insert" ? "새 문단 지움" : "원문으로 되돌림", cut(blockLabel(r.id), 60), "", r.text, "");
  } catch (e) { toast(errMsg(e)); }
}
async function showHistory(bid) {
  const body = h("div", { class: "hist" }, h("div", { class: "muted", text: "불러오는 중…" }));
  modal("수정 이력 · " + cut(blockLabel(bid), 60), body);
  try {
    const snap = await getDocs(query(collection(db, "revhist"), where("bid", "==", bid)));
    const list = snap.docs.map(d => d.data()).sort((a, b) => tsMs(b.at) - tsMs(a.at));
    const base = M.byId.get(bid) ? (M.byId.get(bid).type === "table" ? tableToText(M.byId.get(bid).rows) : M.byId.get(bid).t) : "";
    body.replaceChildren(...list.map(x => {
      const box = h("div", { class: "blk t-p hist-v" });
      if (x.text) renderPieces(box, base ? diffMarkup(base, x.text).map(p => ({ ...p, o: null })) : insertedPieces(x.text), []);
      return h("div", { class: "card" },
        h("div", { class: "bar" }, h("strong", { text: x.action }), h("span", { class: "meta", text: `${x.author} · ${fmt(x.at)}` }),
          (x.items || []).map(id => h("span", { class: "chip item", text: itemShortName(itemById(id)) }))),
        x.note ? h("div", { class: "meta", text: x.note }) : null, box);
    }));
    if (!list.length) body.replaceChildren(h("div", { class: "muted", text: "이력이 없습니다." }));
  } catch (e) { body.replaceChildren(h("div", { text: "불러오기 실패: " + errMsg(e) })); }
}

/* ---------- 내보내기 ---------- */
function finalText() {
  const revs = revMap();
  const out = [];
  for (const e of sequence(revs)) {
    if (e.inserted) { if (e.rev.status !== "거절") out.push(plainOf(e.rev.text)); continue; }
    const b = e.b, r = e.rev;
    if (b.type === "fig") { out.push(`[FIG. ${b.n}]`); continue; }
    const txt = b.type === "table" ? (r && r.status !== "거절" ? r.text : tableToText(b.rows)) : (r && r.status !== "거절" ? (r.del ? null : plainOf(r.text)) : M.plain.get(b.id));
    if (txt != null) out.push(txt);
  }
  return out.join("\n\n");
}
function changeList() {
  const revs = revMap();
  const L = ["# 원고 수정·표시 목록", ""];
  for (const e of sequence(revs)) {
    const r = e.rev;
    const anns = S.anns.filter(a => a.bid === e.id);
    if (!r && !anns.length) continue;
    L.push(`## ${blockLabel(e.id)}`);
    if (r) {
      L.push(`- ${r.kind === "insert" ? "새 문단" : r.del ? "삭제 제안" : "수정"} [${r.status || "제안"}] ${r.author} ${fmt(r.updatedAt)}`);
      if ((r.items || []).length) L.push(`  - 관련 대응 항목: ${r.items.map(id => itemFull(id)).join(", ")}`);
      if (r.note) L.push(`  - 이유: ${r.note}`);
      if (e.inserted || r.kind === "insert") L.push(`  - 추가 내용: ${plainOf(r.text)}`);
      else if (!r.del) { L.push(`  - 원문: ${plainOf(r.base)}`); L.push(`  - 수정: ${plainOf(r.text)}`); }
    }
    for (const a of anns) L.push(`- ${TYPE_LABEL[a.type]}${a.itemId ? " (" + itemFull(a.itemId) + ")" : ""}${a.resolved ? " [해결]" : ""}: “${cut(a.quote, 150)}” — ${a.text || ""} (${a.name})${(a.replies || []).map(x => ` / ${x.n}: ${x.t}`).join("")}`);
    L.push("");
  }
  return L.join("\n");
}
export function msMarkdownSummary() { return M.loaded ? changeList() : ""; }

/* ---------- 탭 렌더 ---------- */
let mounted = null;
function typingIn(el) { const a = document.activeElement; return !!a && el.contains(a) && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type === "text")); }
export function renderMs(root) {
  if (!M.loaded) {
    if (!M.loading && !M.error) loadManuscript();
    root.replaceChildren(h("div", { class: "wrap" }, h("div", { class: "card", text: M.error || "원고를 불러오는 중입니다…" }),
      S.isAdmin && M.error ? h("div", { class: "muted", text: "관리자가 원고 데이터를 올리면 여기에 보입니다." }) : null));
    mounted = null;
    return;
  }
  const active = document.activeElement;
  const activeKey = active && active.dataset ? active.dataset.key : null;
  const selStart = active && "selectionStart" in active ? active.selectionStart : null;
  const selEnd = active && "selectionEnd" in active ? active.selectionEnd : null;
  if (!mounted || !root.contains(mounted.doc)) {
    const side = h("aside", { class: "ms-side" });
    const bar = h("div", { class: "ms-barwrap" });
    const docEl = h("div", { class: "ms-doc", id: "msdoc", onmouseup: onDocMouseUp,
      onclick: e => { const pc = e.target.closest(".pc[data-anns]"); if (pc) activate(pc.dataset.anns.split(" ")[0], true); } });
    root.replaceChildren(h("div", { class: "ms" }, side, h("section", { class: "ms-main" }, bar, docEl)));
    mounted = { side, bar, doc: docEl };
  }
  const revs = revMap();
  const seq = sequence(revs);
  // 도구 모음과 사이드바는 가볍게 통째로 교체 (입력 중이면 유지)
  const barSig = sigOf([M.view, M.show, M.hideResolved, M.expandAll, S.revs.map(r => r.status), S.anns.filter(a => !a.resolved).length]);
  if (mounted.bar.dataset.sig !== barSig && !typingIn(mounted.bar)) {
    mounted.bar.replaceChildren(toolbar());
    mounted.bar.dataset.sig = barSig;
  }
  const tabs = [["toc", "목차"], ["bm", "책갈피"], ["anns", "표시 목록"], ["revs", "수정 목록"]];
  const sideSig = sigOf([M.side, M.sideFilter, S.anns.map(a => [a.id, a.bid, a.type, a.text, a.resolved, a.itemId]), S.revs.map(r => [r.id, r.status, r.items, r.note, r.updatedAt]), S.items.map(i => [i.id, i.no, i.topic])]);
  if (mounted.side.dataset.sig !== sideSig && !typingIn(mounted.side)) {
    const st = mounted.side.querySelector(".side-body");
    const scroll = st ? st.scrollTop : 0;
    const body = h("div", { class: "side-body" },
      M.side === "toc" ? sideToc(seq) : M.side === "bm" ? sideAnns(true) : M.side === "anns" ? sideAnns(false) : sideRevs());
    mounted.side.replaceChildren(
      h("div", { class: "side-tabs" }, tabs.map(([k, l]) => h("button", { class: M.side === k ? "on" : "", text: l, onclick: () => { M.side = k; lsSet("msSide", k); scheduleRender(); } }))),
      body);
    body.scrollTop = scroll;
    mounted.side.dataset.sig = sideSig;
  }
  const rows = seq.map(e => rowFor(e, revs));
  patchChildren(mounted.doc, rows);
  mounted.doc.querySelectorAll("textarea.auto").forEach(t => { if (!t.dataset.sized) { autosize(t); t.dataset.sized = "1"; } });
  restoreFocus(activeKey, selStart, selEnd);
  if (M.activeAnn) document.querySelectorAll(`.pc[data-anns~="${CSS.escape(M.activeAnn)}"]`).forEach(e => e.classList.add("active-hl"));
  if (M.q) runSearch(false);
  if (M.pendingScroll) { const b = M.pendingScroll; M.pendingScroll = null; setTimeout(() => scrollToBlock(b), 30); }
}
export function unmountMs() { mounted = null; closeEditor(); closePopover(); closeSelbar(); }
document.addEventListener("keydown", e => { if (e.key === "Escape") { closePopover(); closeSelbar(); } });
document.addEventListener("mousedown", e => { if (M.selbar && !e.target.closest(".selbar")) closeSelbar(); if (M.popover && !e.target.closest(".popover") && !e.target.closest(".blk-tools")) closePopover(); });

// 대응 항목과 연결된 원고 내역
export function linksForItem(itemId) {
  return {
    anns: S.anns.filter(a => a.itemId === itemId),
    revs: S.revs.filter(r => (r.items || []).includes(itemId))
  };
}
