import {
  S, h, db, toast, fmt, errMsg, myName, writeLog, scheduleRender, confirmButton, keyed, sigOf, patchChildren,
  doc, getDocs, setDoc, updateDoc, deleteDoc, collection, serverTimestamp, writeBatch, Bytes
} from "./core.js?v=4";

export const CHUNK = 900000;
const urlCache = new Map();
const pending = new Map();

export async function fileIdFor(path) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(path));
  return "f" + [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}
function mimeFor(name) {
  const ext = name.split(".").pop().toLowerCase();
  return ({ pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", tif: "image/tiff", tiff: "image/tiff",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", txt: "text/plain", md: "text/markdown", json: "application/json" })[ext] || "application/octet-stream";
}
export function sizeText(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

// 업로드 대기열: {path, file, done, total, state}
export function queueUploads(list) {
  for (const it of list) S.uploads.push({ path: it.path, file: it.file, done: 0, total: it.file.size, state: "대기" });
  scheduleRender();
  runQueue();
}
let running = false;
async function runQueue() {
  if (running) return;
  running = true;
  try {
    for (const u of S.uploads) {
      if (u.state !== "대기") continue;
      u.state = "올리는 중";
      scheduleRender();
      try { await uploadOne(u); u.state = u.state === "건너뜀" ? u.state : "완료"; }
      catch (e) { u.state = "실패: " + errMsg(e); }
      scheduleRender();
    }
  } finally { running = false; }
}
async function uploadOne(u) {
  const id = await fileIdFor(u.path);
  const existing = S.files.find(f => f.id === id);
  if (existing && existing.complete && existing.size === u.file.size) { u.state = "건너뜀"; u.done = u.total; return; }
  const n = Math.max(1, Math.ceil(u.file.size / CHUNK));
  const name = u.path.split("/").pop();
  await setDoc(doc(db, "files", id), {
    path: u.path, name, folder: u.path.split("/").slice(0, -1).join("/"), size: u.file.size, type: u.file.type || mimeFor(name),
    chunks: n, complete: false, uploadedBy: myName(), uid: S.user.uid, uploadedAt: serverTimestamp()
  });
  for (let i = 0; i < n; i++) {
    const part = new Uint8Array(await u.file.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer());
    let tries = 0;
    for (;;) {
      try { await setDoc(doc(db, "files", id, "chunks", String(i).padStart(6, "0")), { i, d: Bytes.fromUint8Array(part) }); break; }
      catch (e) { if (++tries >= 3) throw e; await new Promise(r => setTimeout(r, 1500 * tries)); }
    }
    u.done = Math.min(u.total, (i + 1) * CHUNK);
    if (i % 3 === 0) scheduleRender();
  }
  await updateDoc(doc(db, "files", id), { complete: true });
  urlCache.delete(u.path);
  await writeLog("파일 올림", u.path, "", "", sizeText(u.file.size));
}

export async function downloadBlob(meta, onProgress) {
  const snap = await getDocs(collection(db, "files", meta.id, "chunks"));
  const parts = snap.docs.map(d => d.data()).sort((a, b) => a.i - b.i);
  if (parts.length < meta.chunks) throw new Error(`파일 조각이 모자랍니다 (${parts.length}/${meta.chunks}). 다시 올려야 합니다.`);
  if (onProgress) onProgress(1);
  return new Blob(parts.slice(0, meta.chunks).map(p => p.d.toUint8Array()), { type: meta.type || mimeFor(meta.name) });
}
export function fileByPath(path) { return S.files.find(f => f.path === path && f.complete); }
export async function getFileURL(path) {
  if (urlCache.has(path)) return urlCache.get(path);
  if (pending.has(path)) return pending.get(path);
  const meta = fileByPath(path);
  if (!meta) return null;
  const p = downloadBlob(meta).then(b => { const u = URL.createObjectURL(b); urlCache.set(path, u); pending.delete(path); return u; })
    .catch(e => { pending.delete(path); throw e; });
  pending.set(path, p);
  return p;
}
async function saveFile(meta) {
  toast(`${meta.name} 내려받는 중… (${sizeText(meta.size)})`, 4000);
  try {
    const url = await getFileURL(meta.path);
    const a = h("a", { href: url, download: meta.name });
    document.body.append(a); a.click(); a.remove();
  } catch (e) { toast("내려받기 실패: " + errMsg(e)); }
}
async function openFile(meta) {
  const w = window.open("", "_blank");
  if (w) w.document.write("<p style='font-family:sans-serif'>불러오는 중…</p>");
  try {
    const url = await getFileURL(meta.path);
    if (w) w.location.href = url; else window.open(url, "_blank");
  } catch (e) { if (w) w.close(); toast("열기 실패: " + errMsg(e)); }
}
async function deleteFile(meta) {
  try {
    const snap = await getDocs(collection(db, "files", meta.id, "chunks"));
    let batch = writeBatch(db), n = 0;
    for (const d of snap.docs) { batch.delete(d.ref); if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); } }
    batch.delete(doc(db, "files", meta.id));
    await batch.commit();
    urlCache.delete(meta.path);
    await writeLog("파일 삭제", meta.path, "", "", "");
  } catch (e) { toast("삭제 실패: " + errMsg(e)); }
}

// 끌어다 놓기: 폴더 구조 유지
async function entriesToFiles(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: prefix + entry.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await entriesToFiles(e, prefix + entry.name + "/", out);
    }
  }
}
async function handleDrop(ev) {
  ev.preventDefault();
  const items = [...(ev.dataTransfer.items || [])];
  const out = [];
  if (items.length && items[0].webkitGetAsEntry) {
    for (const it of items) { const e = it.webkitGetAsEntry(); if (e) await entriesToFiles(e, "", out); }
  } else {
    for (const f of ev.dataTransfer.files) out.push({ file: f, path: f.name });
  }
  if (out.length) queueUploads(out);
}
window.__queueUploads = (files, prefix = "") => queueUploads([...files].map(f => ({ file: f, path: prefix + (f.webkitRelativePath || f.name) })));

export function renderFiles() {
  const drop = h("div", { class: "dropzone",
    ondragover: e => { e.preventDefault(); drop.classList.add("over"); },
    ondragleave: () => drop.classList.remove("over"),
    ondrop: e => { drop.classList.remove("over"); handleDrop(e); } },
    h("div", { class: "dz-title", text: "여기에 파일이나 폴더를 끌어다 놓으세요" }),
    h("div", { class: "muted", text: "폴더 구조가 그대로 유지됩니다. 같은 경로·같은 크기의 파일은 건너뜁니다." }),
    h("div", { class: "bar center-bar" },
      h("label", { class: "btn" }, "파일 선택", h("input", { type: "file", multiple: true, hidden: true, onchange: e => { window.__queueUploads(e.target.files); e.target.value = ""; } })),
      h("label", { class: "btn" }, "폴더 선택", h("input", { type: "file", multiple: true, webkitdirectory: true, hidden: true, onchange: e => { window.__queueUploads(e.target.files); e.target.value = ""; } }))));
  keyed(drop, "drop", "static");

  const nodes = [drop];
  const active = S.uploads.filter(u => u.state !== "완료" && u.state !== "건너뜀");
  if (S.uploads.length) {
    const doneN = S.uploads.filter(u => u.state === "완료" || u.state === "건너뜀").length;
    const totalB = S.uploads.reduce((a, u) => a + u.total, 0), doneB = S.uploads.reduce((a, u) => a + u.done, 0);
    const box = h("div", { class: "card" },
      h("div", { class: "bar" }, h("strong", { text: `올리기 ${doneN}/${S.uploads.length}개 · ${sizeText(doneB)} / ${sizeText(totalB)}` }),
        h("span", { class: "grow" }),
        active.length ? h("span", { class: "muted", text: "창을 닫으면 멈춥니다. 다시 올리면 이어서 처리됩니다." }) : h("button", { class: "small", text: "목록 지우기", onclick: () => { S.uploads = []; scheduleRender(); } })),
      h("div", { class: "prog" }, h("div", { style: `width:${totalB ? Math.round(doneB / totalB * 100) : 0}%` })),
      active.slice(0, 8).map(u => h("div", { class: "meta", text: `${u.state} · ${u.path} (${sizeText(u.done)} / ${sizeText(u.total)})` })));
    nodes.push(keyed(box, "upbox", sigOf(S.uploads.map(u => [u.path, u.done, u.state]))));
  }

  const files = S.files.slice().sort((a, b) => a.path.localeCompare(b.path, "ko"));
  const folders = new Map();
  for (const f of files) { const k = f.folder || "(최상위)"; if (!folders.has(k)) folders.set(k, []); folders.get(k).push(f); }
  const total = files.reduce((a, f) => a + (f.size || 0), 0);
  nodes.push(keyed(h("div", { class: "bar" }, h("span", { class: "count", text: `파일 ${files.length}개 · ${sizeText(total)}` })), "sum", sigOf([files.length, total])));
  for (const [folder, list] of folders) {
    const sig = sigOf([folder, list.map(f => [f.id, f.size, f.complete, f.uploadedBy, f.uploadedAt]), S.isAdmin, list.map(f => S.armed["delf:" + f.id] > Date.now())]);
    const tbl = h("table", { class: "t files" },
      h("thead", null, h("tr", null, h("th", { colspan: 5, text: folder }))),
      h("tbody", null, list.map(f => h("tr", null,
        h("td", { class: "fname" }, f.name, f.complete ? null : h("span", { class: "badge warn", text: "올리는 중 또는 미완료" })),
        h("td", { class: "meta nowrap", text: sizeText(f.size || 0) }),
        h("td", { class: "meta nowrap", text: `${f.uploadedBy || ""} ${fmt(f.uploadedAt)}` }),
        h("td", { class: "nowrap" },
          f.complete && /pdf|image\/(jpeg|png)|text/.test(f.type || "") ? h("button", { class: "small", text: "열기", onclick: () => openFile(f) }) : null, " ",
          f.complete ? h("button", { class: "small", text: "내려받기", onclick: () => saveFile(f) }) : null),
        h("td", null, S.isAdmin ? confirmButton("삭제", () => deleteFile(f), "small danger", "delf:" + f.id) : null)))));
    nodes.push(keyed(h("div", { class: "folder" }, tbl), "fd:" + folder, sig));
  }
  return nodes;
}
