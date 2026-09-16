// 서식 표기: {^위첨자} {_아래첨자} {i:이탤릭} {b:굵게}
export function parseMarkup(s) {
  s = s == null ? "" : String(s);
  const runs = [];
  const stack = [];
  let buf = "";
  const fmt = () => ({ b: stack.includes("b"), i: stack.includes("i"), sup: stack.includes("^"), sub: stack.includes("_") });
  const flush = () => {
    if (!buf) return;
    const f = fmt();
    const last = runs[runs.length - 1];
    if (last && sig(last.f) === sig(f)) last.t += buf; else runs.push({ t: buf, f });
    buf = "";
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{" && (s[i + 1] === "^" || s[i + 1] === "_")) { flush(); stack.push(s[i + 1]); i += 1; continue; }
    if (c === "{" && (s[i + 1] === "i" || s[i + 1] === "b") && s[i + 2] === ":") { flush(); stack.push(s[i + 1]); i += 2; continue; }
    if (c === "}" && stack.length) { flush(); stack.pop(); continue; }
    buf += c;
  }
  flush();
  return runs;
}
export function sig(f) { return (f.b ? "b" : "") + (f.i ? "i" : "") + (f.sup ? "^" : "") + (f.sub ? "_" : ""); }
export function plainOf(s) { return parseMarkup(s).map(r => r.t).join(""); }

// 서식이 적용된 DOM 조각
export function fmtNode(text, f) {
  let node = document.createTextNode(text);
  if (f.sup) { const e = document.createElement("sup"); e.append(node); node = e; }
  else if (f.sub) { const e = document.createElement("sub"); e.append(node); node = e; }
  if (f.i) { const e = document.createElement("i"); e.append(node); node = e; }
  if (f.b) { const e = document.createElement("b"); e.append(node); node = e; }
  return node;
}
export function markupNodes(s) {
  const frag = document.createDocumentFragment();
  for (const r of parseMarkup(s)) {
    const parts = r.t.split("\n");
    parts.forEach((p, k) => { if (k) frag.append(document.createElement("br")); if (p) frag.append(fmtNode(p, r.f)); });
  }
  return frag;
}

// 비교용 토큰 (단어, 공백, 기호 단위. 서식이 다르면 다른 토큰)
const TOKEN_RE = /[\p{L}\p{N}]+|\s+|[^\p{L}\p{N}\s]/gu;
const SEP = "␟";
export function tokenize(s) {
  const out = [];
  let off = 0;
  for (const r of parseMarkup(s)) {
    const fs = sig(r.f);
    for (const m of r.t.matchAll(TOKEN_RE)) out.push({ t: m[0], f: r.f, k: m[0] + SEP + fs, o: off + m.index });
    off += r.t.length;
  }
  return out;
}

// 단어 단위 비교 결과: [{kind:'eq'|'del'|'ins', t, f, o}]  o = 원문 글자 위치(eq, del만)
export function diffMarkup(base, rev) {
  const A = tokenize(base), B = tokenize(rev);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre].k === B[pre].k) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf].k === B[B.length - 1 - suf].k) suf++;
  const a = A.slice(pre, A.length - suf), b = B.slice(pre, B.length - suf);
  const n = a.length, m = b.length;
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ kind: "eq", t: A[i].t, f: A[i].f, o: A[i].o });
  if (n && m && n * m <= 6000000) {
    const W = m + 1;
    const L = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i * W + j] = a[i].k === b[j].k ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i].k === b[j].k) { ops.push({ kind: "eq", t: a[i].t, f: a[i].f, o: a[i].o }); i++; j++; }
      else if (j < m && (i >= n || L[i * W + j + 1] >= L[(i + 1) * W + j])) { ops.push({ kind: "ins", t: b[j].t, f: b[j].f, o: null }); j++; }
      else { ops.push({ kind: "del", t: a[i].t, f: a[i].f, o: a[i].o }); i++; }
    }
  } else {
    for (const x of a) ops.push({ kind: "del", t: x.t, f: x.f, o: x.o });
    for (const x of b) ops.push({ kind: "ins", t: x.t, f: x.f, o: null });
  }
  for (let i = A.length - suf; i < A.length; i++) ops.push({ kind: "eq", t: A[i].t, f: A[i].f, o: A[i].o });

  // 변경 사이에 낀 짧은 공백 eq는 변경에 흡수해서 읽기 쉽게 만든다
  const merged = [];
  for (let k = 0; k < ops.length; k++) {
    const x = ops[k];
    const prev = merged[merged.length - 1], next = ops[k + 1];
    if (x.kind === "eq" && /^\s+$/.test(x.t) && prev && prev.kind !== "eq" && next && next.kind !== "eq") {
      merged.push({ kind: "del", t: x.t, f: x.f, o: x.o });
      merged.push({ kind: "ins", t: x.t, f: x.f, o: null });
      continue;
    }
    merged.push(x);
  }
  // 연속 변경 구간에서 삭제를 먼저, 추가를 나중에
  const out = [];
  let k = 0;
  while (k < merged.length) {
    if (merged[k].kind === "eq") { out.push(merged[k]); k++; continue; }
    const ds = [], is = [];
    while (k < merged.length && merged[k].kind !== "eq") { (merged[k].kind === "del" ? ds : is).push(merged[k]); k++; }
    out.push(...ds, ...is);
  }
  return out;
}

export function originalPieces(base) {
  const out = [];
  let off = 0;
  for (const r of parseMarkup(base)) { out.push({ kind: "eq", t: r.t, f: r.f, o: off }); off += r.t.length; }
  return out;
}
export function insertedPieces(text) {
  return parseMarkup(text).map(r => ({ kind: "ins", t: r.t, f: r.f, o: null }));
}

// 표 <-> 편집용 텍스트 (칸 구분 " | ", 칸 안 줄바꿈 " ¶ ")
export function tableToText(rows) {
  return rows.map(r => r.map(c => String(c.t || "").replace(/\n/g, " ¶ ")).join(" | ")).join("\n");
}
export function textToTable(s) {
  return String(s || "").split("\n").filter(l => l.trim() !== "").map(l => l.split(" | ").map(c => ({ t: c.replace(/ ¶ /g, "\n") })));
}
