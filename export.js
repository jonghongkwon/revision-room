// 원고 검토 → Word 내보내기
// 원본 docx를 그대로 두고, 표시(메모)는 Word 메모로, 수정 제안은 Word 변경 추적(w:ins/w:del)으로만 끼워 넣는다.
import { S, h, toast, tsDate, cut, modal, itemById, codeText, errMsg } from "./core.js?v=10";
import { parseMarkup, plainOf, diffMarkup, textToTable } from "./markup.js?v=10";
import { M, loadManuscript } from "./ms.js?v=10";
import { downloadBlob } from "./files.js?v=10";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const W14 = "http://schemas.microsoft.com/office/word/2010/wordml";
const W15 = "http://schemas.microsoft.com/office/word/2012/wordml";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const REL_COMMENTS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
const REL_COMMENTS_EX = "http://schemas.microsoft.com/office/2011/relationships/commentsExtended";
const CT_COMMENTS = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";
const CT_COMMENTS_EX = "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml";
const TYPE_LABEL = { memo: "메모", reviewer: "리뷰어 지적", issue: "문제", bookmark: "책갈피" };
const HEADING_NAMES = new Set(["heading 1", "heading 2", "heading 3", "title"]);
// CT_RPr 자식 순서 (스키마 순서를 지켜야 Word가 파일을 거부하지 않는다)
const RPR_ORDER = ["ins", "del", "moveFrom", "moveTo", "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow", "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout", "specVanish", "oMath", "rPrChange"];

/* ---------- XML 도우미 ---------- */
const isW = (n, name) => n && n.nodeType === 1 && n.namespaceURI === W && n.localName === name;
const wkids = (n, name) => [...n.childNodes].filter(c => isW(c, name));
const wattr = (n, name) => n.getAttributeNS(W, name);
function wel(doc, name, attrs = {}) {
  const e = doc.createElementNS(W, "w:" + name);
  for (const [k, v] of Object.entries(attrs)) e.setAttributeNS(W, "w:" + k, String(v));
  return e;
}
function tEl(doc, name, text) {
  const e = doc.createElementNS(W, "w:" + name);
  e.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
  e.textContent = text;
  return e;
}
const esc = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function isoDate(ts) {
  const d = tsDate(ts) || (typeof ts === "number" ? new Date(ts) : null) || new Date();
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/* ---------- 원본 문단 해석 (ms/convert.py와 같은 규칙) ---------- */
function runLen(r) {
  let n = 0;
  for (const c of r.childNodes) {
    if (c.nodeType !== 1 || c.namespaceURI !== W) continue;
    if (c.localName === "t") n += c.textContent.length;
    else if (c.localName === "tab" || c.localName === "br" || c.localName === "cr" || c.localName === "noBreakHyphen") n += 1;
  }
  return n;
}
function runText(r) {
  let s = "";
  for (const c of r.childNodes) {
    if (c.nodeType !== 1 || c.namespaceURI !== W) continue;
    if (c.localName === "t") s += c.textContent;
    else if (c.localName === "tab") s += "\t";
    else if (c.localName === "br" || c.localName === "cr") s += "\n";
    else if (c.localName === "noBreakHyphen") s += "\u2011";
  }
  return s;
}
function inDel(r, p) {
  for (let a = r.parentNode; a && a !== p; a = a.parentNode) if (isW(a, "del")) return true;
  return false;
}
function textRuns(p) {
  return [...p.getElementsByTagNameNS(W, "r")].filter(r => !inDel(r, p));
}
function runFmt(r) {
  const f = { b: false, i: false, sup: false, sub: false };
  const rpr = wkids(r, "rPr")[0];
  if (!rpr) return f;
  const on = tag => { const e = wkids(rpr, tag)[0]; if (!e) return false; const v = wattr(e, "val"); return !["0", "false", "off"].includes(v); };
  f.b = on("b"); f.i = on("i");
  const va = wkids(rpr, "vertAlign")[0];
  if (va) { const v = wattr(va, "val"); f.sup = v === "superscript"; f.sub = v === "subscript"; }
  return f;
}
const fsig = f => (f.b ? "b" : "") + (f.i ? "i" : "") + (f.sup ? "^" : "") + (f.sub ? "_" : "");
function wrapMk(text, f, heading) {
  if (!text) return "";
  let s = text;
  if (f.sup) s = "{^" + s + "}"; else if (f.sub) s = "{_" + s + "}";
  if (f.i) s = "{i:" + s + "}";
  if (f.b && !heading) s = "{b:" + s + "}";
  return s;
}
function paraMarkup(p, heading) {
  const merged = [];
  for (const r of textRuns(p)) {
    const t = runText(r);
    if (!t) continue;
    const f = runFmt(r);
    const last = merged[merged.length - 1];
    if (last && fsig(last.f) === fsig(f)) last.t += t; else merged.push({ t, f });
  }
  const raw = merged.map(x => wrapMk(x.t, x.f, heading)).join("");
  const lead = raw.length - raw.replace(/^\n+/, "").length;
  return { markup: raw.replace(/^\n+|\n+$/g, ""), lead };
}

function mapBlocks(xml, styleNames, defaultStyle) {
  const body = xml.getElementsByTagNameNS(W, "body")[0];
  const out = [];
  for (const el of [...body.childNodes]) {
    if (isW(el, "p")) {
      const blips = [...el.getElementsByTagNameNS(A, "blip")].filter(b => b.getAttributeNS(R, "embed"));
      if (blips.length) { for (let k = 0; k < blips.length; k++) out.push({ kind: "fig", el }); continue; }
      const ppr = wkids(el, "pPr")[0];
      const ps = ppr && wkids(ppr, "pStyle")[0];
      const sname = (styleNames.get(ps ? wattr(ps, "val") : defaultStyle) || "normal").toLowerCase();
      const heading = HEADING_NAMES.has(sname);
      const { markup, lead } = paraMarkup(el, heading);
      if (!markup.trim()) continue;
      out.push({ kind: "p", el, heading, markup, lead });
    } else if (isW(el, "tbl")) out.push({ kind: "table", el });
  }
  return out;
}

/* ---------- 문단 안 글자 위치 ---------- */
function segments(p) {
  let pos = 0;
  const segs = [];
  for (const r of p.getElementsByTagNameNS(W, "r")) {
    if (inDel(r, p)) continue;
    const n = runLen(r);
    segs.push({ r, s: pos, e: pos + n });
    pos += n;
  }
  return { segs, total: pos };
}
function splitRun(r, k) {
  // r의 글자 k 위치에서 둘로 나눈다. 뒤쪽 조각을 돌려준다.
  const doc = r.ownerDocument;
  const tail = r.cloneNode(false);
  const rpr = wkids(r, "rPr")[0];
  if (rpr) tail.appendChild(rpr.cloneNode(true));
  let acc = 0;
  for (const c of [...r.childNodes]) {
    if (c.nodeType === 1 && c.namespaceURI === W && c.localName === "rPr") continue;
    const len = c.nodeType !== 1 || c.namespaceURI !== W ? 0
      : c.localName === "t" ? c.textContent.length
      : ["tab", "br", "cr", "noBreakHyphen"].includes(c.localName) ? 1 : 0;
    if (acc >= k) tail.appendChild(c);
    else if (len && acc + len > k) {
      const txt = c.textContent;
      const cut = k - acc;
      c.textContent = txt.slice(0, cut);
      c.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
      tail.appendChild(tEl(doc, "t", txt.slice(cut)));
    }
    acc += len;
  }
  r.parentNode.insertBefore(tail, r.nextSibling);
  return tail;
}
function splitAt(p, offsets) {
  for (const k of [...new Set(offsets)].sort((a, b) => a - b)) {
    const { segs } = segments(p);
    const sg = segs.find(x => x.s < k && k < x.e);
    if (sg) splitRun(sg.r, k - sg.s);
  }
}

/* ---------- 메모 ---------- */
function newParaIdFactory(existing) {
  const used = new Set(existing);
  return () => {
    for (;;) {
      const v = (Math.floor(Math.random() * 0x7ffffffe) + 1).toString(16).toUpperCase().padStart(8, "0");
      if (!used.has(v)) { used.add(v); return v; }
    }
  };
}
function markerRun(doc, cid, refStyle) {
  const r = wel(doc, "r");
  if (refStyle) { const rpr = wel(doc, "rPr"); rpr.appendChild(wel(doc, "rStyle", { val: refStyle })); r.appendChild(rpr); }
  r.appendChild(wel(doc, "commentReference", { id: cid }));
  return r;
}
function firstContentRef(p) {
  // pPr 다음 첫 자리
  for (const c of p.childNodes) if (!isW(c, "pPr")) return c;
  return null;
}
// 문단 p의 글자 [s,e) 범위에 메모 id 목록을 건다. whole이면 문단 전체.
function anchorComments(p, s, e, ids, refStyle, whole) {
  const doc = p.ownerDocument;
  let startRef, endAfter;
  if (whole) {
    startRef = firstContentRef(p);
    endAfter = null;
  } else {
    const { segs } = segments(p);
    const first = segs.find(x => x.s >= s && x.e > x.s) || null;
    const lastList = segs.filter(x => x.e <= e && x.e > x.s);
    const last = lastList[lastList.length - 1] || null;
    if (!first || !last) return false;
    startRef = first.r;
    endAfter = last.r;
  }
  for (const id of ids) {
    const rs = wel(doc, "commentRangeStart", { id });
    if (startRef) startRef.parentNode.insertBefore(rs, startRef); else p.appendChild(rs);
  }
  let anchor = endAfter;
  for (const id of ids) {
    const re = wel(doc, "commentRangeEnd", { id });
    const ref = markerRun(doc, id, refStyle);
    if (anchor) {
      anchor.parentNode.insertBefore(re, anchor.nextSibling);
      re.parentNode.insertBefore(ref, re.nextSibling);
      anchor = ref;
    } else { p.appendChild(re); p.appendChild(ref); }
  }
  return true;
}
function anchorCommentsSpan(pFirst, pLast, ids, refStyle) {
  const doc = pFirst.ownerDocument;
  const startRef = firstContentRef(pFirst);
  for (const id of ids) {
    const rs = wel(doc, "commentRangeStart", { id });
    if (startRef) pFirst.insertBefore(rs, startRef); else pFirst.appendChild(rs);
  }
  for (const id of ids) {
    pLast.appendChild(wel(doc, "commentRangeEnd", { id }));
    pLast.appendChild(markerRun(doc, id, refStyle));
  }
}

/* ---------- 변경 추적 ---------- */
function setRPrFlag(doc, rpr, name, on, val) {
  for (const e of wkids(rpr, name)) rpr.removeChild(e);
  if (!on) return;
  const e = wel(doc, name, val !== undefined ? { val } : {});
  const idx = RPR_ORDER.indexOf(name);
  const before = [...rpr.childNodes].find(c => c.nodeType === 1 && c.namespaceURI === W && RPR_ORDER.indexOf(c.localName) > idx);
  rpr.insertBefore(e, before || null);
}
function buildRuns(doc, text, f, rprTemplate, heading) {
  const rpr = rprTemplate ? rprTemplate.cloneNode(true) : wel(doc, "rPr");
  for (const e of [...wkids(rpr, "rPrChange"), ...wkids(rpr, "ins"), ...wkids(rpr, "del")]) rpr.removeChild(e);
  setRPrFlag(doc, rpr, "vertAlign", f.sup || f.sub, f.sup ? "superscript" : "subscript");
  setRPrFlag(doc, rpr, "i", f.i); setRPrFlag(doc, rpr, "iCs", f.i);
  if (!heading) { setRPrFlag(doc, rpr, "b", f.b); setRPrFlag(doc, rpr, "bCs", f.b); }
  const r = wel(doc, "r");
  if (rpr.childNodes.length) r.appendChild(rpr);
  const parts = text.split(/(\n|\t)/);
  for (const part of parts) {
    if (part === "\n") r.appendChild(wel(doc, "br"));
    else if (part === "\t") r.appendChild(wel(doc, "tab"));
    else if (part) r.appendChild(tEl(doc, "t", part));
  }
  return r;
}
function toDeleted(doc, r) {
  for (const t of wkids(r, "t")) {
    const d = tEl(doc, "delText", t.textContent);
    r.replaceChild(d, t);
  }
}
function markParaMark(doc, p, kind, attrs) {
  let ppr = wkids(p, "pPr")[0];
  if (!ppr) { ppr = wel(doc, "pPr"); p.insertBefore(ppr, p.firstChild); }
  let rpr = wkids(ppr, "rPr")[0];
  if (!rpr) {
    rpr = wel(doc, "rPr");
    const before = [...ppr.childNodes].find(c => isW(c, "sectPr") || isW(c, "pPrChange"));
    ppr.insertBefore(rpr, before || null);
  }
  rpr.insertBefore(wel(doc, kind, attrs), rpr.firstChild);
}
function templateRPr(p) {
  const r = textRuns(p).find(x => runLen(x) > 0);
  const rpr = r && wkids(r, "rPr")[0];
  return rpr ? rpr.cloneNode(true) : null;
}
// pieces: diffMarkup 결과 (o는 원문 plain 위치). lead: 원문 앞쪽 줄바꿈 수.
function applyPieces(p, pieces, lead, heading, ctx, attrsFn) {
  const doc = p.ownerDocument;
  // 낱말 단위 조각을 이어 붙인다 (원본 런을 필요한 경계에서만 나누도록)
  const joined = [];
  for (const x of pieces) {
    const l = joined[joined.length - 1];
    const cont = l && l.kind === x.kind && (x.kind === "ins" ? fsig(l.f) === fsig(x.f) : l.o + l.t.length === x.o);
    if (cont) l.t += x.t; else joined.push({ ...x });
  }
  pieces = joined;
  const bounds = [];
  for (const x of pieces) if (x.kind !== "ins") { bounds.push(x.o + lead, x.o + lead + x.t.length); }
  splitAt(p, bounds);
  const { segs } = segments(p);
  const outer = new Map();
  const outerOf = r => outer.get(r) || r;
  let afterNode = null;
  let rprPrev = null;
  const firstSeg = segs.find(x => x.e > x.s);
  let prevKind = null;
  for (const x of pieces) {
    if (x.kind === "ins") {
      const tpl = rprPrev ? wkids(rprPrev, "rPr")[0] : (firstSeg ? wkids(firstSeg.r, "rPr")[0] : templateRPr(p));
      const ins = wel(doc, "ins", attrsFn());
      ins.appendChild(buildRuns(doc, x.t, x.f, tpl || null, heading));
      if (afterNode) afterNode.parentNode.insertBefore(ins, afterNode.nextSibling);
      else if (firstSeg) { const o = outerOf(firstSeg.r); o.parentNode.insertBefore(ins, o); }
      else p.appendChild(ins);
      afterNode = ins;
      if (prevKind !== "ins") ctx.ins++;
      prevKind = "ins";
      continue;
    }
    const a = x.o + lead, b = a + x.t.length;
    const runs = segs.filter(sg => sg.s >= a && sg.e <= b && sg.e > sg.s).map(sg => sg.r);
    if (x.kind === "del") {
      for (const r of runs) {
        const del = wel(doc, "del", attrsFn());
        r.parentNode.insertBefore(del, r);
        del.appendChild(r);
        toDeleted(doc, r);
        outer.set(r, del);
      }
      if (prevKind !== "del") ctx.del++;
    }
    prevKind = x.kind;
    if (runs.length) { afterNode = outerOf(runs[runs.length - 1]); rprPrev = runs[runs.length - 1]; }
  }
}
function deleteParagraph(p, attrsFn) {
  const doc = p.ownerDocument;
  for (const r of textRuns(p)) {
    const del = wel(doc, "del", attrsFn());
    r.parentNode.insertBefore(del, r);
    del.appendChild(r);
    toDeleted(doc, r);
  }
  markParaMark(doc, p, "del", attrsFn());
}
function cellGrid(tbl) {
  const rows = [];
  const vm = new Map();
  for (const tr of tbl.getElementsByTagNameNS(W, "tr")) {
    const row = [];
    let col = 0;
    for (const tc of wkids(tr, "tc")) {
      const tcpr = wkids(tc, "tcPr")[0];
      let cs = 1, vmerge = null;
      if (tcpr) {
        const gs = wkids(tcpr, "gridSpan")[0]; if (gs) cs = parseInt(wattr(gs, "val"), 10) || 1;
        const v = wkids(tcpr, "vMerge")[0]; if (v) vmerge = wattr(v, "val") || "continue";
      }
      if (vmerge === "continue" && vm.has(col)) { /* 세로 병합 이어짐: 새 칸 아님 */ }
      else {
        row.push({ tc, paras: wkids(tc, "p") });
        if (vmerge === "restart") vm.set(col, true); else vm.delete(col);
      }
      col += cs;
    }
    rows.push({ tr, cells: row });
  }
  return rows;
}

/* ---------- 본체 ---------- */
export async function buildAnnotatedDocx(fileData, opts, progress = () => {}) {
  if (!window.JSZip) await loadJSZip();
  if (!M.loaded) await loadManuscript();
  progress("원본 파일 여는 중");
  const zip = await window.JSZip.loadAsync(fileData);
  const need = ["word/document.xml", "word/_rels/document.xml.rels", "[Content_Types].xml"];
  for (const n of need) if (!zip.file(n)) throw new Error("Word 문서(docx)가 아닙니다: " + n + " 없음");
  const parser = new DOMParser();
  const xml = parser.parseFromString(await zip.file("word/document.xml").async("string"), "application/xml");
  if (xml.getElementsByTagName("parsererror").length) throw new Error("document.xml을 읽지 못했습니다.");

  // 스타일 이름
  const styleNames = new Map();
  let defaultStyle = null, commentRefStyle = null;
  if (zip.file("word/styles.xml")) {
    const st = parser.parseFromString(await zip.file("word/styles.xml").async("string"), "application/xml");
    for (const s of st.getElementsByTagNameNS(W, "style")) {
      const id = wattr(s, "styleId"), nm = wkids(s, "name")[0];
      const name = nm ? wattr(nm, "val") : "";
      styleNames.set(id, name);
      if (wattr(s, "type") === "paragraph" && ["1", "true", "on"].includes(wattr(s, "default"))) defaultStyle = id;
      if (name.toLowerCase() === "annotation reference") commentRefStyle = id;
    }
  }

  progress("원고와 원본 대조 중");
  const mapped = mapBlocks(xml, styleNames, defaultStyle);
  const report = { blocks: mapped.length, expected: M.blocks.length, mismatch: [], comments: 0, replies: 0, ins: 0, del: 0, paraDel: 0, paraIns: 0, fallback: [], skipped: [] };
  const byBid = new Map();
  const n = Math.min(mapped.length, M.blocks.length);
  for (let i = 0; i < n; i++) {
    const b = M.blocks[i], m = mapped[i];
    const kindOk = b.type === "fig" ? m.kind === "fig" : b.type === "table" ? m.kind === "table" : m.kind === "p";
    const textOk = m.kind !== "p" || plainOf(m.markup) === M.plain.get(b.id);
    if (!kindOk || !textOk) report.mismatch.push(b.id);
    byBid.set(b.id, { ...m, ok: kindOk && textOk, b });
  }
  if (mapped.length !== M.blocks.length) report.countMismatch = true;
  if (report.countMismatch || report.mismatch.length > 20) {
    throw new Error(`선택한 파일이 원고 검토에 올라간 원고와 다릅니다 (문단 ${mapped.length}개 / 원고 ${M.blocks.length}개, 불일치 ${report.mismatch.length}개). 제출본 docx를 선택해 주세요.`);
  }

  // 기존 paraId, 메모 id
  const existingParaIds = new Set();
  const existingCommentIds = [];
  for (const name of Object.keys(zip.files)) {
    if (!/^word\/.*\.xml$/.test(name)) continue;
    const s = await zip.file(name).async("string");
    for (const m of s.matchAll(/w14:paraId="([0-9A-Fa-f]{8})"/g)) existingParaIds.add(m[1].toUpperCase());
    if (name === "word/comments.xml") for (const m of s.matchAll(/<w:comment\b[^>]*w:id="(\d+)"/g)) existingCommentIds.push(+m[1]);
  }
  const newParaId = newParaIdFactory(existingParaIds);
  let nextCid = existingCommentIds.length ? Math.max(...existingCommentIds) + 1 : 0;
  let nextRid = 900000;
  const comments = []; // {id, author, date, initials, paras:[text], paraIds:[], parent, done}

  const initialsOf = name => String(name || "?").replace(/\s+/g, "").slice(0, 2);
  const addComment = (author, date, lines, parentRoot, done) => {
    const id = nextCid++;
    lines = lines.map(l => typeof l === "string" ? { text: l, st: "body" } : l);
    if (!lines.length) lines = [{ text: "", st: "body" }];
    const paraIds = lines.map(() => newParaId());
    comments.push({ id, author: author || "?", date, initials: initialsOf(author), lines, paraIds, parent: parentRoot ? parentRoot.paraIds[parentRoot.paraIds.length - 1] : null, done: !!done });
    return comments[comments.length - 1];
  };
  const itemTag = id => { const it = itemById(id); if (!it) return ""; const c = codeText(it); return `대응 ${it.no || "-"}${c ? " (" + c + ")" : ""}`; };

  // 대상 표시·수정
  const anns = S.anns.filter(a => opts.types.has(a.type) && (opts.includeResolved || !a.resolved) && (!opts.item || a.itemId === opts.item));
  const revs = opts.revs ? S.revs.filter(r => r.status !== "거절" && (!opts.item || (r.items || []).includes(opts.item))) : [];
  const revById = new Map(revs.map(r => [r.id, r]));

  // 삽입 문단을 먼저 만든다 (그 위에 달린 메모도 걸 수 있게)
  const insertedEl = new Map();
  const insByAnchor = new Map();
  for (const r of revs) if (r.kind === "insert" && r.insertAfter) {
    if (!insByAnchor.has(r.insertAfter)) insByAnchor.set(r.insertAfter, []);
    insByAnchor.get(r.insertAfter).push(r);
  }
  for (const list of insByAnchor.values()) list.sort((a, b) => (a.order || 0) - (b.order || 0));
  const firstOfType = t => { const b = M.blocks.find(x => x.type === t); return b ? byBid.get(b.id) : null; };
  const buildInsertedPara = rv => {
    const btype = rv.btype || "p";
    const tplBlock = (btype === "table" ? firstOfType("p") : firstOfType(btype)) || firstOfType("p");
    const tplP = tplBlock.el;
    const p = wel(xml, "p");
    const tppr = wkids(tplP, "pPr")[0];
    if (tppr) {
      const ppr = tppr.cloneNode(true);
      for (const e of [...wkids(ppr, "sectPr"), ...wkids(ppr, "pPrChange"), ...wkids(ppr, "rPr")]) ppr.removeChild(e);
      p.appendChild(ppr);
    }
    const attrs = () => ({ id: nextRid++, author: rv.author || "?", date: isoDate(rv.updatedAt) });
    markParaMark(xml, p, "ins", attrs());
    const tpl = templateRPr(tplP);
    const heading = tplBlock.heading;
    const text = btype === "table" ? String(rv.text || "") : String(rv.text || "");
    for (const run of parseMarkup(text)) {
      const ins = wel(xml, "ins", attrs());
      ins.appendChild(buildRuns(xml, run.t, run.f, tpl, heading));
      p.appendChild(ins);
    }
    report.paraIns++;
    if (btype === "table") report.fallback.push({ bid: rv.id, why: "새 표는 표 서식 없이 텍스트로 넣고 메모로 알림" });
    return p;
  };
  const placeChain = (node, bid, depth) => {
    for (const rv of insByAnchor.get(bid) || []) {
      const p = buildInsertedPara(rv);
      node.parentNode.insertBefore(p, node.nextSibling);
      insertedEl.set(rv.id, { el: p, rev: rv });
      node = p;
      if (depth < 50) node = placeChain(node, rv.id, depth + 1);
    }
    return node;
  };
  for (const bid of insByAnchor.keys()) {
    const m = byBid.get(bid);
    if (m) placeChain(m.el, bid, 0);
  }
  for (const r of revs) if (r.kind === "insert" && !insertedEl.has(r.id)) report.skipped.push({ bid: r.id, why: "새 문단의 기준 위치를 찾지 못함" });

  // 메모 만들기
  progress("메모 넣는 중");
  const annsByBid = new Map();
  for (const a of anns) { if (!annsByBid.has(a.bid)) annsByBid.set(a.bid, []); annsByBid.get(a.bid).push(a); }
  const TYPE_RANK = { bookmark: 0, reviewer: 1, issue: 2, memo: 3 };
  const tsN = x => { const d = tsDate(x.createdAt); return d ? d.getTime() : 0; };
  // 교수님 보기용 메모 형식: 맨 위 대응 항목 줄, 종류별 굵은 색 소제목, 원문·근거 줄은 회색
  const sectionOf = a => {
    const text = String(a.text || (a.type === "bookmark" ? a.quote : "") || "");
    let codes = "", sub = "", body = text, label = null;
    const m = text.match(/^\[([^\]]+)\]\s*(지적|대응(?:\(([^)]*)\))?|확인 필요)\s*:\s*/);
    if (m) { codes = m[1]; sub = m[3] || ""; body = text.slice(m[0].length); if (m[2] === "확인 필요") label = "확인 필요"; }
    else { const e = text.match(/^\[오류\]\s*/); if (e) { label = "오류"; body = text.slice(e[0].length); } }
    const st = a.type === "reviewer" ? "h-rev" : a.type === "issue" ? "h-issue" : a.type === "bookmark" ? "h-note" : "h-resp";
    if (!label) label = a.type === "reviewer" ? "심사위원 지적" : a.type === "issue" ? "확인 필요" : a.type === "bookmark" ? "책갈피" : "대응 계획";
    const head = `■ ${label}${sub ? " · " + sub : ""}${codes ? " (" + codes + ")" : ""}${a.resolved ? " · 해결됨" : ""}`;
    const lines = [{ text: head, st }];
    for (const ln of body.split("\n")) {
      if (/^원문(\s|:|$)/.test(ln)) lines.push({ text: ln.replace(/^원문/, "심사평 원문"), st: "quote" });
      else if (/^\((근거|출처)\s*:/.test(ln)) lines.push({ text: ln, st: "note" });
      else lines.push({ text: ln, st: "body" });
    }
    return lines;
  };
  const commentsForGroup = group => {
    const a0 = group[0];
    const it = a0.itemId ? itemById(a0.itemId) : null;
    const lines = [];
    if (it) lines.push({ text: `${itemTag(a0.itemId)} · ${cut(it.topic || "", 40)}`, st: "top" });
    group.forEach((a, k) => { if (k) lines.push({ text: "", st: "body" }); lines.push(...sectionOf(a)); });
    const authors = [...new Set(group.map(a => a.name).filter(Boolean))];
    if (authors.length > 1) lines.push({ text: "작성: " + group.map(a => `${a.name}(${TYPE_LABEL[a.type]})`).join(", "), st: "note" });
    const done = group.every(a => a.resolved);
    const root = addComment(a0.name, isoDate(a0.createdAt), lines, null, done);
    const ids = [root.id];
    report.comments++;
    for (const a of group) for (const rp of a.replies || []) {
      const pre = group.length > 1 ? `(${TYPE_LABEL[a.type]}에 단 답글) ` : "";
      const c = addComment(rp.n, isoDate(rp.at), (pre + String(rp.t || "")).split("\n"), root, done);
      ids.push(c.id);
      report.replies++;
    }
    return ids;
  };
  const groupsOf = list => {
    if (!opts.merge) return list.map(a => [a]);
    const out = [], byKey = new Map();
    for (const a of list) {
      if (a.type === "bookmark") { out.push([a]); continue; }
      const key = (a.whole ? "W" : a.start + "-" + a.end) + "|" + (a.itemId || "");
      if (!byKey.has(key)) { const g = []; byKey.set(key, g); out.push(g); }
      byKey.get(key).push(a);
    }
    for (const g of out) g.sort((x, y) => ((TYPE_RANK[x.type] ?? 9) - (TYPE_RANK[y.type] ?? 9)) || (tsN(x) - tsN(y)));
    return out;
  };
  for (const [bid, list] of annsByBid) {
    list.sort((x, y) => ((x.whole ? -1 : x.start) - (y.whole ? -1 : y.start)) || ((TYPE_RANK[x.type] ?? 9) - (TYPE_RANK[y.type] ?? 9)) || (tsN(x) - tsN(y)));
    const m = byBid.get(bid);
    const insd = insertedEl.get(bid);
    if (!m && !insd) { for (const a of list) report.skipped.push({ bid, why: "원고에서 위치를 찾지 못함 (" + cut(a.text, 30) + ")" }); continue; }
    if (insd) {
      const p = insd.el;
      const cutsI = [];
      for (const a of list) if (!a.whole) cutsI.push(a.start, a.end);
      splitAt(p, cutsI);
      for (const g of groupsOf(list)) {
        const a = g[0];
        const ids = commentsForGroup(g);
        if (!anchorComments(p, a.whole ? 0 : a.start, a.whole ? 0 : a.end, ids, commentRefStyle, a.whole)) anchorComments(p, 0, 0, ids, commentRefStyle, true);
      }
      continue;
    }
    if (m.kind === "table") {
      const grid = cellGrid(m.el);
      const ps = [...m.el.getElementsByTagNameNS(W, "p")];
      for (const g of groupsOf(list.map(a => ({ ...a, whole: true })))) { const ids = commentsForGroup(g); anchorCommentsSpan(ps[0], ps[ps.length - 1], ids, commentRefStyle); }
      void grid;
      continue;
    }
    if (m.kind === "fig" || !m.ok) {
      for (const g of groupsOf(list)) {
        const ids = commentsForGroup(g);
        anchorComments(m.el, 0, 0, ids, commentRefStyle, true);
        if (!m.ok && !g[0].whole) report.fallback.push({ bid, why: "원본 문단 글자가 달라 문단 전체에 표시" });
      }
      continue;
    }
    // 글자 범위: 나눌 위치를 먼저 모두 자른다
    const cuts = [];
    for (const a of list) if (!a.whole) cuts.push(a.start + m.lead, a.end + m.lead);
    splitAt(m.el, cuts);
    for (const g of groupsOf(list)) {
      const a = g[0];
      const ids = commentsForGroup(g);
      const ok = a.whole ? anchorComments(m.el, 0, 0, ids, commentRefStyle, true)
        : anchorComments(m.el, a.start + m.lead, a.end + m.lead, ids, commentRefStyle, false);
      if (!ok) { anchorComments(m.el, 0, 0, ids, commentRefStyle, true); report.fallback.push({ bid, why: "글자 범위를 찾지 못해 문단 전체에 표시" }); }
    }
  }

  // 변경 추적 (문단 수정·삭제, 표 칸 수정)
  progress("수정 제안을 변경 추적으로 넣는 중");
  const noteComment = (rv, p, whole = true) => {
    const tags = (rv.items || []).map(itemTag).filter(Boolean);
    if (!rv.note && !tags.length) return;
    const lines = [{ text: `■ 수정 이유${tags.length ? " (" + tags.join(", ") + ")" : ""}${rv.status === "수락" ? " · 수락됨" : ""}`, st: "h-resp" }, ...String(rv.note || "").split("\n").filter(Boolean)];
    const c = addComment(rv.author, isoDate(rv.updatedAt), lines, null, false);
    anchorComments(p, 0, 0, [c.id], commentRefStyle, whole);
    report.comments++;
  };
  for (const rv of revs) {
    const ctx = report;
    const attrsFn = () => ({ id: nextRid++, author: rv.author || "?", date: isoDate(rv.updatedAt) });
    if (rv.kind === "insert") { const e = insertedEl.get(rv.id); if (e) noteComment(rv, e.el); continue; }
    const m = byBid.get(rv.id);
    if (!m) { report.skipped.push({ bid: rv.id, why: "수정 대상 문단을 찾지 못함" }); continue; }
    if (m.kind === "p") {
      if (!m.ok) { report.skipped.push({ bid: rv.id, why: "원본 문단 글자가 달라 변경 추적을 넣지 않음" }); continue; }
      if (rv.del) { deleteParagraph(m.el, attrsFn); report.paraDel++; }
      else if (rv.text !== undefined && rv.text !== m.b.t) applyPieces(m.el, diffMarkup(m.b.t, rv.text), m.lead, m.heading, ctx, attrsFn);
      noteComment(rv, m.el);
      continue;
    }
    if (m.kind === "table") {
      const grid = cellGrid(m.el);
      const ps = [...m.el.getElementsByTagNameNS(W, "p")];
      if (rv.del) {
        for (const row of grid) {
          let trpr = wkids(row.tr, "trPr")[0];
          if (!trpr) { trpr = wel(xml, "trPr"); const tblPrEx = wkids(row.tr, "tblPrEx")[0]; row.tr.insertBefore(trpr, tblPrEx ? tblPrEx.nextSibling : row.tr.firstChild); }
          trpr.appendChild(wel(xml, "del", attrsFn()));
        }
        for (const p of ps) deleteParagraph(p, attrsFn);
        report.paraDel++;
        continue;
      }
      const newRows = textToTable(rv.text);
      const oldRows = m.b.rows;
      const same = oldRows.length === newRows.length && oldRows.every((r, i) => r.length === newRows[i].length) && grid.length >= oldRows.length;
      let applied = same;
      if (same) {
        for (let i = 0; i < oldRows.length && applied; i++) {
          const gcells = grid[i] ? grid[i].cells : [];
          if (gcells.length !== oldRows[i].length) { applied = false; break; }
          for (let j = 0; j < oldRows[i].length; j++) {
            const ot = oldRows[i][j].t || "", nt = newRows[i][j].t || "";
            if (ot === nt) continue;
            const ol = ot.split("\n"), nl = nt.split("\n");
            const paras = gcells[j].paras;
            // 칸 안의 줄: 문단 경계 또는 문단 안 줄바꿈(br). 문단별 줄 수로 묶어 문단마다 비교한다.
            const pms = paras.map(pp => paraMarkup(pp, false));
            const perPara = pms.map(pm => pm.markup.split("\n").length);
            const sum = perPara.reduce((x, y) => x + y, 0);
            let og = null, ng = null;
            if (paras.length && sum === ol.length && nl.length === ol.length) {
              og = []; ng = []; let at = 0;
              for (const c of perPara) { og.push(ol.slice(at, at + c).join("\n")); ng.push(nl.slice(at, at + c).join("\n")); at += c; }
            } else if (paras.length === 1) { og = [ot]; ng = [nt]; }
            if (!og) {
              const c = addComment(rv.author, isoDate(rv.updatedAt), ["[표 칸 수정 제안 · 줄 수가 달라 메모로 첨부]", ...plainOf(nt).split("\n")], null, false);
              anchorCommentsSpan(paras[0], paras[paras.length - 1], [c.id], commentRefStyle);
              report.comments++;
              report.fallback.push({ bid: rv.id, why: `표 ${i + 1}행 ${j + 1}칸: 줄 수가 달라 메모로 첨부` });
              continue;
            }
            for (let k = 0; k < og.length; k++) {
              if (og[k] === ng[k]) continue;
              const pm = pms[k];
              if (plainOf(pm.markup) !== plainOf(og[k])) {
                const c = addComment(rv.author, isoDate(rv.updatedAt), ["[표 칸 수정 제안 · 원본 글자와 달라 메모로 첨부]", ...plainOf(ng[k]).split("\n")], null, false);
                anchorComments(paras[k], 0, 0, [c.id], commentRefStyle, true);
                report.comments++;
                report.fallback.push({ bid: rv.id, why: `표 ${i + 1}행 ${j + 1}칸: 원본 글자 불일치` });
                continue;
              }
              applyPieces(paras[k], diffMarkup(og[k], ng[k]), pm.lead, false, ctx, attrsFn);
            }
          }
        }
      }
      if (!applied) {
        const c = addComment(rv.author, isoDate(rv.updatedAt), ["[표 수정 제안 · 표 구조가 바뀌어 원본 표는 그대로 두고 수정안을 메모로 첨부]", ...plainOf(rv.text || "").split("\n")], null, false);
        anchorCommentsSpan(ps[0], ps[ps.length - 1], [c.id], commentRefStyle);
        report.comments++;
        report.fallback.push({ bid: rv.id, why: "표 구조 변경: 수정안을 메모로 첨부" });
      }
      if (ps.length) noteComment(rv, ps[0]);
      continue;
    }
    report.skipped.push({ bid: rv.id, why: "그림 수정은 지원하지 않음" });
  }

  // 새 표 제안 알림 메모
  for (const [bid, e] of insertedEl) if ((e.rev.btype || "p") === "table") {
    const c = addComment(e.rev.author, isoDate(e.rev.updatedAt), ["[새 표 제안] 웹에서 추가한 표입니다. 칸 구분은 \" | \"이며, Word에서 표로 바꿔야 합니다."], null, false);
    anchorComments(e.el, 0, 0, [c.id], commentRefStyle, true);
    report.comments++;
  }

  progress("파일 쓰는 중");
  // document.xml
  let docOut = new XMLSerializer().serializeToString(xml);
  if (!docOut.startsWith("<?xml")) docOut = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + docOut;
  zip.file("word/document.xml", docOut, { createFolders: false });

  if (comments.length) {
    // comments.xml
    const STYLE_RPR = {
      top: '<w:b/><w:bCs/><w:color w:val="404040"/>',
      "h-rev": '<w:b/><w:bCs/><w:color w:val="C00000"/>',
      "h-resp": '<w:b/><w:bCs/><w:color w:val="1F4E79"/>',
      "h-issue": '<w:b/><w:bCs/><w:color w:val="C55A11"/>',
      "h-note": '<w:b/><w:bCs/><w:color w:val="7F6000"/>',
      quote: '<w:i/><w:iCs/><w:color w:val="595959"/>',
      note: '<w:color w:val="7F7F7F"/>',
      body: ""
    };
    const cText = c => {
      const ps = c.lines.map((line, k) => {
        const annRef = k === 0 ? `<w:r>${commentRefStyle ? `<w:rPr><w:rStyle w:val="${esc(commentRefStyle)}"/></w:rPr>` : ""}<w:annotationRef/></w:r>` : "";
        const rp = STYLE_RPR[line.st] || "";
        const txt = line.text ? `<w:r>${rp ? `<w:rPr>${rp}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(line.text)}</w:t></w:r>` : "";
        return `<w:p w14:paraId="${c.paraIds[k]}" w14:textId="77777777">${annRef}${txt}</w:p>`;
      }).join("");
      return `<w:comment w:id="${c.id}" w:author="${esc(c.author)}" w:date="${c.date}" w:initials="${esc(c.initials)}">${ps}</w:comment>`;
    };
    const exText = c => `<w15:commentEx w15:paraId="${c.paraIds[c.paraIds.length - 1]}"${c.parent ? ` w15:paraIdParent="${c.parent}"` : ""} w15:done="${c.done ? 1 : 0}"/>`;
    const ns = `xmlns:w="${W}" xmlns:w14="${W14}" xmlns:w15="${W15}" xmlns:mc="${MC}" mc:Ignorable="w14 w15"`;
    if (zip.file("word/comments.xml")) {
      let s = await zip.file("word/comments.xml").async("string");
      s = s.replace(/<\/w:comments>\s*$/, comments.map(cText).join("") + "</w:comments>");
      if (!/xmlns:w14=/.test(s)) s = s.replace(/<w:comments\b/, `<w:comments xmlns:w14="${W14}"`);
      zip.file("word/comments.xml", s, { createFolders: false });
    } else {
      zip.file("word/comments.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:comments ${ns}>${comments.map(cText).join("")}</w:comments>`, { createFolders: false });
    }
    if (zip.file("word/commentsExtended.xml")) {
      let s = await zip.file("word/commentsExtended.xml").async("string");
      s = s.replace(/<\/w15:commentsEx>\s*$/, comments.map(exText).join("") + "</w15:commentsEx>");
      zip.file("word/commentsExtended.xml", s, { createFolders: false });
    } else {
      zip.file("word/commentsExtended.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w15:commentsEx ${ns}>${comments.map(exText).join("")}</w15:commentsEx>`, { createFolders: false });
    }
    // 관계
    const relsDoc = parser.parseFromString(await zip.file("word/_rels/document.xml.rels").async("string"), "application/xml");
    const relRoot = relsDoc.documentElement;
    const rels = [...relRoot.getElementsByTagNameNS(PKG_REL, "Relationship")];
    const ridUsed = new Set(rels.map(r => r.getAttribute("Id")));
    const addRel = (type, target) => {
      if (rels.some(r => r.getAttribute("Type") === type)) return;
      let k = 1; while (ridUsed.has("rIdRv" + k)) k++;
      const e = relsDoc.createElementNS(PKG_REL, "Relationship");
      e.setAttribute("Id", "rIdRv" + k); e.setAttribute("Type", type); e.setAttribute("Target", target);
      relRoot.appendChild(e); ridUsed.add("rIdRv" + k);
    };
    addRel(REL_COMMENTS, "comments.xml");
    addRel(REL_COMMENTS_EX, "commentsExtended.xml");
    let relOut = new XMLSerializer().serializeToString(relsDoc);
    if (!relOut.startsWith("<?xml")) relOut = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + relOut;
    zip.file("word/_rels/document.xml.rels", relOut, { createFolders: false });
    // 콘텐츠 형식
    const ctDoc = parser.parseFromString(await zip.file("[Content_Types].xml").async("string"), "application/xml");
    const ctRoot = ctDoc.documentElement;
    const addCT = (part, type) => {
      if ([...ctRoot.getElementsByTagNameNS(CT_NS, "Override")].some(o => o.getAttribute("PartName") === part)) return;
      const e = ctDoc.createElementNS(CT_NS, "Override");
      e.setAttribute("PartName", part); e.setAttribute("ContentType", type);
      ctRoot.appendChild(e);
    };
    addCT("/word/comments.xml", CT_COMMENTS);
    addCT("/word/commentsExtended.xml", CT_COMMENTS_EX);
    let ctOut = new XMLSerializer().serializeToString(ctDoc);
    if (!ctOut.startsWith("<?xml")) ctOut = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' + ctOut;
    zip.file("[Content_Types].xml", ctOut, { createFolders: false });
  }

  zip.forEach((path, f) => { if (!f.dir && !/\.(xml|rels)$/i.test(path)) f.options.compression = "STORE"; });
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 },
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    meta => progress(`파일 쓰는 중 ${Math.round(meta.percent)}%`));
  report.commentTotal = comments.length;
  return { blob, report };
}

function loadJSZip() {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = new URL("jszip.min.js", import.meta.url).href;
    s.onload = () => window.JSZip ? res() : rej(new Error("JSZip을 불러오지 못했습니다."));
    s.onerror = () => rej(new Error("JSZip을 불러오지 못했습니다."));
    document.head.append(s);
  });
}

/* ---------- 화면 ---------- */
const TODAY = () => { const d = new Date(); const p = n => String(n).padStart(2, "0"); return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
export function openExportDialog() {
  const types = new Set(["memo", "reviewer", "issue"]);
  const state = { includeResolved: true, revs: true, item: "", merge: true };
  const libFiles = S.files.filter(f => f.complete && /\.docx$/i.test(f.name) && /manuscript/i.test(f.name) && !/redmark/i.test(f.name));
  const status = h("div", { class: "exp-status" });
  const result = h("div", { class: "exp-result" });
  const input = h("input", { type: "file", accept: ".docx", hidden: true, onchange: e => { const f = e.target.files[0]; e.target.value = ""; if (f) run(f, f.name); } });
  const typeBoxes = Object.entries(TYPE_LABEL).map(([k, l]) => h("label", { class: "tg" }, h("input", { type: "checkbox", checked: types.has(k), onchange: e => { if (e.target.checked) types.add(k); else types.delete(k); } }), " " + l));
  const itemSel = h("select", { onchange: e => { state.item = e.target.value; } },
    h("option", { value: "", text: "모든 대응 항목" }),
    S.items.slice().sort((a, b) => (a.no || 0) - (b.no || 0)).map(it => h("option", { value: it.id, text: `대응 ${it.no} (${codeText(it) || "팀"}) · ${cut(it.topic, 30)}` })));
  let busy = false;
  const run = async (data, name) => {
    if (busy) return;
    busy = true;
    result.replaceChildren();
    try {
      const t0 = Date.now();
      const { blob, report } = await buildAnnotatedDocx(data, { types, ...state }, msg => { status.textContent = msg; });
      const base = String(name || "manuscript.docx").replace(/\.docx$/i, "");
      const fname = `${base}_검토메모_${TODAY()}.docx`;
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: fname, class: "btn primary", text: `${fname} 내려받기 (${(blob.size / 1048576).toFixed(1)} MB)` });
      status.textContent = `완료 (${((Date.now() - t0) / 1000).toFixed(1)}초)`;
      const lines = [
        `메모 ${report.comments}건 (답글 ${report.replies}건 별도), 변경 추적: 삽입 ${report.ins}곳 · 삭제 ${report.del}곳 · 새 문단 ${report.paraIns}개 · 문단 삭제 ${report.paraDel}개`,
        `원본 대조: 문단 ${report.blocks}개 중 글자 불일치 ${report.mismatch.length}개${report.mismatch.length ? " (" + report.mismatch.slice(0, 8).join(", ") + ")" : ""}`
      ];
      result.append(h("div", null, a), ...lines.map(t => h("div", { class: "muted", text: t })));
      if (report.fallback.length || report.skipped.length) {
        result.append(h("div", { class: "warn", text: "원래 형태로 넣지 못해 대체한 것:" }),
          h("ul", null, [...report.fallback, ...report.skipped].slice(0, 30).map(x => h("li", { text: `${x.bid}: ${x.why}` }))));
      }
      a.click();
    } catch (e) {
      status.textContent = "";
      result.append(h("div", { class: "warn", text: "만들지 못했습니다: " + errMsg(e) }));
    } finally { busy = false; }
  };
  const body = h("div", { class: "export-dlg" },
    h("p", { text: "제출본 docx 위에 원고 검토의 표시를 Word 메모로, 수정 제안을 Word 변경 추적으로 넣은 새 파일을 만듭니다. 본문 글꼴, 위·아래첨자, 특수문자, 표, 그림은 원본 파일 그대로 남습니다. 원본 파일은 바뀌지 않습니다." }),
    h("div", { class: "exp-row" }, h("b", { text: "포함할 표시: " }), typeBoxes),
    h("div", { class: "exp-row" },
      h("label", { class: "tg" }, h("input", { type: "checkbox", checked: state.includeResolved, onchange: e => { state.includeResolved = e.target.checked; } }), " 해결된 표시도 넣기 (Word에서 '해결됨'으로 표시)"),
      h("label", { class: "tg" }, h("input", { type: "checkbox", checked: state.revs, onchange: e => { state.revs = e.target.checked; } }), " 수정 제안을 변경 추적으로 넣기 (거절된 것은 제외)"),
      h("label", { class: "tg" }, h("input", { type: "checkbox", checked: state.merge, onchange: e => { state.merge = e.target.checked; } }), " 같은 자리의 지적·대응을 메모 하나로 합치기")),
    h("p", { class: "muted", text: "Word 메모 안에서는 ■ 심사위원 지적(빨강), ■ 대응 계획(파랑), ■ 확인 필요·오류(주황) 소제목으로 구분되고, 심사평 원문 줄은 회색 기울임, 근거 줄은 회색으로 들어갑니다. 맨 위 줄에 대응 항목이 붙습니다." }),
    h("div", { class: "exp-row" }, h("b", { text: "대응 항목: " }), itemSel),
    h("div", { class: "exp-row" },
      h("button", { class: "primary", text: "내 컴퓨터의 제출본 docx 선택", onclick: () => input.click() }), input,
      libFiles.map(f => h("button", { text: `자료실 파일 사용: ${f.path} (${(f.size / 1048576).toFixed(0)} MB, 내려받는 데 시간이 걸립니다)`, onclick: async () => {
        status.textContent = "자료실에서 내려받는 중…";
        try { const b = await downloadBlob(f); run(await b.arrayBuffer(), f.name); } catch (e) { status.textContent = "내려받기 실패: " + errMsg(e); }
      } }))),
    h("p", { class: "muted", text: "선택한 파일이 원고 검토에 올라간 제출본과 같은지 문단 단위로 먼저 대조합니다. 다르면 만들지 않습니다. 파일은 이 브라우저 안에서만 처리되고 서버로 올라가지 않습니다." }),
    status, result);
  modal("Word로 내보내기 (메모·변경 추적)", body);
}
