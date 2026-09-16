import {
  S, h, db, toast, fmt, errMsg, myName, writeLog, scheduleRender, confirmButton, keyed, sigOf, cut, itemById,
  doc, updateDoc, addDoc, deleteDoc, collection, serverTimestamp
} from "./core.js?v=8";
import { itemShortName } from "./ms.js?v=8";

export const C = { filter: "all", item: "", pickItems: new Set() };

async function post(ta) {
  const text = ta.value.trim();
  if (!text) return;
  try {
    await addDoc(collection(db, "chat"), { text, uid: S.user.uid, name: myName(), at: serverTimestamp(), items: [...C.pickItems], pinned: false });
    ta.value = ""; delete S.dirty["chat#new"]; C.pickItems.clear();
    scheduleRender();
  } catch (e) { toast("등록 실패: " + errMsg(e)); }
}

function msgNode(m) {
  return h("div", { class: "msg" + (m.uid === S.user.uid ? " mine" : "") + (m.pinned ? " pinned" : "") },
    h("div", { class: "msg-head" }, h("b", { text: m.name }), h("span", { class: "meta", text: fmt(m.at) }),
      m.pinned ? h("span", { class: "chip st ok", text: "결정 사항" }) : null,
      (m.items || []).map(id => h("span", { class: "chip item", text: itemShortName(itemById(id)) })),
      h("span", { class: "grow" }),
      h("button", { class: "small", text: m.pinned ? "결정 해제" : "결정 사항으로 표시", onclick: async () => {
        try { await updateDoc(doc(db, "chat", m.id), { pinned: !m.pinned, pinnedBy: myName() }); await writeLog(m.pinned ? "결정 해제" : "결정 사항 표시", "회의·대화", "", "", m.text); }
        catch (e) { toast(errMsg(e)); }
      } }),
      (m.uid === S.user.uid || S.isAdmin) ? confirmButton("삭제", async () => { try { await deleteDoc(doc(db, "chat", m.id)); } catch (e) { toast(errMsg(e)); } }, "small danger", "dm:" + m.id) : null),
    h("div", { class: "msg-text", text: m.text }));
}

export function renderChat() {
  let list = S.chat.slice().reverse();
  if (C.filter === "pinned") list = list.filter(m => m.pinned);
  if (C.item) list = list.filter(m => (m.items || []).includes(C.item));
  const pinned = S.chat.filter(m => m.pinned).slice().reverse();
  const nodes = [];
  const bar = h("div", { class: "bar" },
    h("select", { onchange: e => { C.filter = e.target.value; scheduleRender(); } },
      [["all", "모든 대화"], ["pinned", "결정 사항만"]].map(([v, l]) => h("option", { value: v, text: l, selected: C.filter === v ? true : null }))),
    h("select", { onchange: e => { C.item = e.target.value; scheduleRender(); } },
      h("option", { value: "", text: "모든 대응 항목" }),
      S.items.map(it => h("option", { value: it.id, text: itemShortName(it), selected: C.item === it.id ? true : null }))),
    h("span", { class: "count", text: `${list.length}건 (최근 300건까지 표시)` }));
  nodes.push(keyed(bar, "bar", sigOf([C, S.items.map(i => [i.id, i.no, i.topic]), list.length])));
  if (pinned.length) {
    nodes.push(keyed(h("div", { class: "card pinned-box" }, h("strong", { text: `결정 사항 ${pinned.length}건` }),
      pinned.map(m => h("div", { class: "pin-line" }, h("span", { class: "meta", text: `${m.name} · ${fmt(m.at)}` }), " ", cut(m.text, 200)))), "pins", sigOf(pinned.map(m => [m.id, m.text]))));
  }
  const box = h("div", { class: "chatlist" }, list.map(msgNode));
  nodes.push(keyed(box, "list", sigOf([list.map(m => [m.id, m.text, m.pinned, m.items, m.at]), S.items.map(i => [i.id, i.no, i.topic]), list.map(m => S.armed["dm:" + m.id] > Date.now())])));
  const ta = h("textarea", { class: "auto", rows: 2, placeholder: "회의 내용, 논의, 결정을 적어 주세요. Ctrl+Enter로 등록", value: S.dirty["chat#new"] || "", dataset: { key: "chat#new" },
    oninput: e => { S.dirty["chat#new"] = e.target.value; },
    onkeydown: e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post(e.target); } } });
  const picks = h("div", { class: "ed-items" }, h("span", { class: "muted", text: "관련 대응 항목:" }), S.items.map(it => h("label", { class: "tg" },
    h("input", { type: "checkbox", checked: C.pickItems.has(it.id), onchange: e => { if (e.target.checked) C.pickItems.add(it.id); else C.pickItems.delete(it.id); } }),
    itemShortName(it))));
  nodes.push(keyed(h("div", { class: "card composer" }, ta, picks, h("div", { class: "bar" }, h("span", { class: "grow" }), h("button", { class: "primary", text: "등록", onclick: () => post(ta) }))),
    "composer", sigOf([S.items.map(i => [i.id, i.no, i.topic])])));
  return nodes;
}
