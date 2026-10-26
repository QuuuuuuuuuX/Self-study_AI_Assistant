/* Self-Learning Space · 前端核心层：安全存储 / 错误上报 / 请求 / 流式问答 / 视图切换 / 共享资料行
   只放基础设施与跨视图共用件，不含任何单一视图的业务逻辑 */

// ---------- 安全存储：某些 webview 禁用 localStorage 会抛异常 ----------
const storage = (() => {
  let usable = true;
  try {
    window.localStorage.setItem("__probe__", "1");
    window.localStorage.removeItem("__probe__");
  } catch (e) { usable = false; }
  const mem = {};
  return {
    usable,
    get(k) { try { return usable ? window.localStorage.getItem(k) : (k in mem ? mem[k] : null); } catch (e) { return k in mem ? mem[k] : null; } },
    set(k, v) { try { if (usable) window.localStorage.setItem(k, v); else mem[k] = v; } catch (e) { mem[k] = v; } },
    del(k) { try { if (usable) window.localStorage.removeItem(k); else delete mem[k]; } catch (e) { delete mem[k]; } },
    getJSON(k, dflt) { try { const v = this.get(k); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } },
    setJSON(k, v) { this.set(k, JSON.stringify(v)); },
  };
})();

// ---------- 统一错误上报：任何异常都显示在屏幕上，绝不静默白屏 ----------
function reportError(label, err) {
  const msg = `${label}：${(err && (err.message || err)) || "未知错误"}`;
  try { storage.set("sls-err", msg + "\n" + ((err && err.stack) || "")); } catch (e) {}
  try { console.error("[sls]", label, err); } catch (e) {}
  let el = document.getElementById("js-error-panel");
  if (!el) {
    el = document.createElement("div");
    el.id = "js-error-panel";
    el.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:#d93025;color:#fff;padding:10px 14px;font:12px/1.6 monospace;white-space:pre-wrap;max-height:40vh;overflow:auto";
    (document.body || document.documentElement).appendChild(el);
  }
  el.textContent = "出现问题（截图发给 AI 即可修复）：\n" + msg;
}
function guard(label, fn) {
  return (...args) => {
    try { return fn(...args); }
    catch (e) { reportError(label, e); }
  };
}

// 兜住所有未捕获异常：屏幕可见，绝不静默白屏
window.addEventListener("unhandledrejection", (e) => reportError("未处理的异步异常", e.reason || e));
window.addEventListener("error", (e) => reportError("脚本错误", e.error || e.message));

// ---------- 标签清单：权威来源是后端 /api/meta，此处仅为拉取失败时的兜底 ----------
let TAGS = ["讲义", "习题", "往年卷", "文献", "课程具体要求", "其他"];

async function loadMeta() {
  try {
    const meta = await api("/api/meta");
    if (Array.isArray(meta.tags) && meta.tags.length) TAGS = meta.tags;
  } catch (e) { /* 兜底清单继续可用 */ }
  renderTagChips();
}

// 三处标签筛选栏（课程资料库 / 出题范围 / 资料总库）统一由这里生成
const TAG_FILTERS = ["#tag-filter", "#quiz-tag-filter", "#lib-tag-filter"];
function renderTagChips() {
  for (const sel of TAG_FILTERS) {
    const box = $(sel);
    if (!box) continue;
    box.querySelectorAll(".chip").forEach(c => c.remove());
    for (const [val, label] of [["", "全部"], ...TAGS.map(x => [x, x])]) {
      const b = document.createElement("button");
      b.className = "chip" + (val === "" ? " active" : "");
      b.dataset.tag = val;
      b.textContent = label;
      box.appendChild(b);
    }
  }
}

const $ = (s) => document.querySelector(s);
// 全局状态按「域」拆分：每个模块只碰自己那几项。
// 原先是一个大对象被 5 个文件直接读写 190 多次，改任何一处都可能波及别处，
// 也没法一眼看出「这项状态归谁管」。拆开后误改他域的状态在 review 时会很显眼。
const courseState = {
  list: [], currentId: null,
  hbEdit: false,               // HandBook 编辑模式
  recycleSelected: new Set(),  // 回收区勾选
};
const materialState = {
  list: [], tag: "", search: "",
  busy: false, editMode: false, selected: new Set(),
};
const quizState = { scopeTag: "", selected: new Set(), session: null };
const libraryState = {
  selected: new Set(), tag: "", search: "", editMode: false,
};

// ---------- 基础工具 ----------
let _backendDown = false;
function _showReconnect(show) {
  let el = document.getElementById("reconnect-bar");
  if (show && !el) {
    el = document.createElement("div");
    el.id = "reconnect-bar";
    el.textContent = "连接已断开，正在重连后端…";
    document.body.appendChild(el);
  }
  if (!show && el) el.remove();
}
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    _backendDown = true;
    _showReconnect(true);
    throw new Error("后端未响应");
  }
  if (_backendDown) { _backendDown = false; _showReconnect(false); }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}
// 后端复活后自动整页刷新
setInterval(async () => {
  if (!_backendDown) return;
  try {
    const r = await fetch("/api/health");
    if (r.ok) location.reload();
  } catch (e) {}
}, 1500);

function toast(msg, ms = 2400) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), ms);
}

function fmtDate(ts) { return new Date(ts * 1000).toLocaleDateString("zh-CN"); }
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, m =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function openModal(id) { $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden"); }

// ---------- 待办行（首页区块与待办管理页共用）----------
// 两处的行结构本来各写一份，加了「课程标签 / 剩余时间分档」之后就成了双份维护点，
// 收敛到这里：谁渲染谁负责调 todoRowHtml()，行内事件仍由调用方自己绑。
const TODO_SORT_KEY = "sls-todo-sort";

function todoSortMode() { return storage.get(TODO_SORT_KEY) || "due"; }
function todoSetSortMode(m) { storage.set(TODO_SORT_KEY, m); }

// 未完成项按 DDL 升序（无 DDL 的沉底，彼此保持原有相对顺序）
function todoSortByDue(list) {
  const withDue = list.filter(t => t.due)
    .sort((a, b) => new Date(a.due) - new Date(b.due));
  return [...withDue, ...list.filter(t => !t.due)];
}

// 按当前模式排出一屏的展示顺序：未完成在前、已完成沉底
function todoOrder(todos) {
  const open = todos.filter(t => !t.done);
  const done = todos.filter(t => t.done);
  const head = todoSortMode() === "due" ? todoSortByDue(open) : open;
  return [...head, ...done];
}

// DDL 展示分四档：已过期 / 3 天内 / 7 天内 / 普通 —— 让最紧的自己跳出来
function todoDueHtml(td, now) {
  if (!td.due) return `<span class="todo-nodue">无 DDL</span>`;
  const d = new Date(td.due);
  const when = d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  if (td.done) return `<span class="todo-due">DDL ${when}</span>`;
  const hours = (d.getTime() - now) / 3600000;
  if (hours < 0) return `<span class="todo-due overdue">DDL ${when} · 已过期</span>`;
  const left = hours < 24 ? `还剩 ${Math.max(1, Math.round(hours))} 小时`
                          : `还剩 ${Math.round(hours / 24)} 天`;
  const level = hours <= 72 ? " urgent" : (hours <= 168 ? " soon" : "");
  return `<span class="todo-due${level}">DDL ${when} · ${left}</span>`;
}

function todoCourseHtml(td) {
  if (!td.course_code) return `<span class="todo-nocourse">未归类</span>`;
  const name = td.course_name ? ` title="${esc(td.course_name)}"` : "";
  return `<span class="todo-course"${name}>${esc(td.course_code)}</span>`;
}

const TODO_HANDLE_SVG = `<svg width="10" height="16" viewBox="0 0 10 16">
  <circle cx="2.5" cy="3" r="1.4" fill="currentColor"/><circle cx="7.5" cy="3" r="1.4" fill="currentColor"/>
  <circle cx="2.5" cy="8" r="1.4" fill="currentColor"/><circle cx="7.5" cy="8" r="1.4" fill="currentColor"/>
  <circle cx="2.5" cy="13" r="1.4" fill="currentColor"/><circle cx="7.5" cy="13" r="1.4" fill="currentColor"/>
</svg>`;

function todoRowHtml(td, now, withHandle) {
  const handle = withHandle
    ? `<span class="drag-handle" title="拖动排序" aria-hidden="true">${TODO_HANDLE_SVG}</span>` : "";
  return `${handle}
    <input type="checkbox" class="todo-check" ${td.done ? "checked" : ""}>
    ${todoCourseHtml(td)}
    <span class="todo-content" title="${esc(td.content)}">${esc(td.content)}</span>
    ${todoDueHtml(td, now)}
    <button class="btn btn-danger btn-sm todo-del">删除</button>`;
}

// 给「添加待办」的课程下拉填选项（选项来自已加载的课程列表，保留用户当前选择）
function fillTodoCourseSelect(sel) {
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = [`<option value="">不指定课程</option>`]
    .concat((courseState.list || []).filter(c => c.code !== "UNFILED")
      .map(c => `<option value="${esc(c.id)}">${esc(c.code)}${c.name ? " · " + esc(c.name) : ""}</option>`))
    .join("");
  sel.value = cur;
}

document.querySelectorAll("[data-close]").forEach(b =>
  b.addEventListener("click", e => e.target.closest(".modal").classList.add("hidden")));

// ---------- 视图切换 ----------
const VIEW_SELECTORS = {
  home: "#home-view", course: "#course-view", recycle: "#recycle-view",
  grade: "#grade-view", todo: "#todo-view", library: "#library-view", import: "#import-view",
};

function showView(name) {
  const missing = [];
  for (const [key, sel] of Object.entries(VIEW_SELECTORS)) {
    const el = document.querySelector(sel);
    if (!el) { missing.push(sel); continue; }
    el.classList.toggle("hidden", key !== name);
  }
  if (missing.length) reportError("视图容器缺失", new Error(missing.join(", ")));
  try { renderCourses(); } catch (e) { reportError("侧栏渲染", e); }
  // 兜底：目标视图未能显示时回退主页，绝不出现全白
  const target = name === "course" && !courseState.currentId ? null : document.querySelector(VIEW_SELECTORS[name]);
  if (!target || target.classList.contains("hidden")) {
    const home = document.querySelector("#home-view");
    if (home) home.classList.remove("hidden");
  }
}

// ---------- 流式问答：聊天面板 / 沉浸模式共用 ----------
async function streamSSE(path, body, { onDelta, onDone, onError } = {}) {
  const res = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = "请求失败";
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const line of parts) {
      if (!line.startsWith("data: ")) continue;
      let ev;
      try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      if (ev.type === "delta") onDelta && onDelta(ev.text);
      else if (ev.type === "error") onError && onError(ev.message || "");
      else if (ev.type === "done") onDone && onDone(ev.citations || []);
    }
  }
}

// ---------- 资料行：课程资料库 / 资料总库共用渲染 ----------
function buildMaterialRow(m, opts = {}) {
  const {
    editable = false, isUnfiled = false, showCourse = false, withImmersive = false,
    selected = null, onToggle = null, onTagChange = null,
  } = opts;
  const row = document.createElement("div");
  row.className = "material-row";
  const statusBadge = {
    pending: `<span class="badge badge-warn">排队中</span>`,
    processing: `<span class="badge badge-warn">解析中…</span>`,
    failed: `<span class="badge badge-err" title="${esc(m.error)}">失败</span>`,
  }[m.status] || "";
  const notesBadge = (m.notes_count || 0) > 0
    ? `<span class="badge badge-note">已注释 ${m.notes_count} 页</span>` : "";
  const tagSel = (isUnfiled || !onTagChange) ? "" : `<select class="input input-sm tag-select" title="点击更改资料性质">
      ${TAGS.map(t =>
        `<option ${t === m.tag ? "selected" : ""}>${t}</option>`).join("")}
    </select>`;
  const checkCtl = editable
    ? `<input type="checkbox" class="m-check" data-id="${m.id}" ${selected && selected.has(m.id) ? "checked" : ""}>` : "";
  // AI 摘要与关键词（入库时一次调用产生；没有就不占位）
  const kws = (m.keywords || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 4);
  const sumLine = (m.summary || kws.length)
    ? `<div class="m-sum"><span class="m-sum-text">${esc(m.summary || "")}</span>${kws.length ? `<span class="m-kw">${kws.map(esc).join(" · ")}</span>` : ""}</div>`
    : "";
  // 未分类里 AI 认出的课程：给一键归入（不自动移动，避免误判打乱已整理的数据）
  const inUnfiled = isUnfiled || m.course_code === "UNFILED";
  const adoptBtn = (inUnfiled && m.ai_course)
    ? `<button class="btn btn-ghost btn-sm btn-adopt" title="AI 从内容里认出这门课">归入 ${esc(m.ai_course)}</button>` : "";
  row.innerHTML = `
      ${checkCtl}
      ${tagSel}
      <div class="m-main">
        <span class="m-name" title="${esc(m.orig_name)}">${esc(m.orig_name)}</span>
        ${sumLine}
      </div>
      ${showCourse ? `<span class="badge">${esc(m.course_code)}</span>` : ""}
      <span class="m-meta">${m.pages ? m.pages + (m.ext === "docx" ? "段 · " : "页 · ") : ""}${fmtDate(m.created_at)}</span>
      ${notesBadge}
      ${statusBadge}
      ${adoptBtn}
      <button class="btn btn-outline btn-sm btn-read">打开</button>
      ${withImmersive && m.ext === "pdf" ? `<button class="btn btn-ghost btn-sm btn-imm">注释</button>` : ""}`;
  row.querySelector(".btn-read").onclick = guard("打开", () => openViewer(m.id, 0, m.orig_name, m.ext));
  const adoptEl = row.querySelector(".btn-adopt");
  if (adoptEl) adoptEl.onclick = guard("归入课程", async () => {
    const r = await api(`/api/materials/${m.id}/adopt-course`, { method: "POST" });
    toast(`已归入 ${r.course_code}`);
    await loadMaterials(); await loadCourses();
  });
  const check = row.querySelector(".m-check");
  if (check) check.onchange = (e) => {
    if (!selected) return;
    e.target.checked ? selected.add(m.id) : selected.delete(m.id);
    if (onToggle) onToggle();
  };
  const tagEl = row.querySelector(".tag-select");
  if (tagEl) tagEl.onchange = async (e) => {
    const newTag = e.target.value;
    await api(`/api/materials/${m.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: newTag }),
    });
    m.tag = newTag;
    toast(`已改为「${newTag}」`);
    if (onTagChange) onTagChange(newTag);
  };
  return row;
}

// ---------- AI 整理：给还没做过入库分析的资料补跑一次 ----------
// 两个入口共用：课程资料库（只整理本课程）/ 资料总库（整理全部）
let organizeRefreshedAt = 0;

function organizeScopeQuery(scope) {
  return scope ? `?course_id=${encodeURIComponent(scope)}` : "";
}

async function refreshOrganizeBtns(force) {
  if (!force && Date.now() - organizeRefreshedAt < 1500) return;
  organizeRefreshedAt = Date.now();
  for (const { sel, scope } of [
    { sel: "#btn-ai-organize", scope: () => courseState.currentId || "" },
    { sel: "#btn-lib-ai-organize", scope: () => "" },
  ]) {
    const el = $(sel);
    if (!el) continue;
    try {
      const s = await api(`/api/materials/analyze-status${organizeScopeQuery(scope())}`);
      if (s.on) {
        el.classList.remove("hidden");
        el.disabled = true;
        el.textContent = `整理中 ${s.done}/${s.total}`;
      } else {
        el.classList.toggle("hidden", !s.pending);
        el.disabled = false;
        el.textContent = s.pending ? `AI 整理（${s.pending}）` : "AI 整理";
      }
    } catch (e) { el.classList.add("hidden"); }
  }
}

async function startOrganize(scope) {
  const qs = organizeScopeQuery(scope);
  const s = await api(`/api/materials/analyze-status${qs}`);
  if (s.on) return toast("正在整理中，请稍候");
  if (!s.pending) return toast("所有资料都已经有摘要了");
  if (!confirm(`将为 ${s.pending} 份资料各调用一次 AI（生成标签与摘要），继续？`)) return;
  await api("/api/materials/analyze", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ course_id: scope || "" }),
  });
  toast(`已开始整理 ${s.pending} 份资料，可以继续做别的事`);
  pollOrganize(scope);
}

function pollOrganize(scope) {
  const qs = organizeScopeQuery(scope);
  const timer = setInterval(async () => {
    let s;
    try { s = await api(`/api/materials/analyze-status${qs}`); }
    catch (e) { clearInterval(timer); return; }
    await refreshOrganizeBtns(true);
    if (!s.on) {
      clearInterval(timer);
      toast("AI 整理完成");
      await refreshCurrentMaterialList();
      await loadCourses();
    }
  }, 2500);
}

async function refreshCurrentMaterialList() {
  const lib = $("#library-view");
  if (lib && !lib.classList.contains("hidden")) renderLibrary();
  else await loadMaterials();
}

function renderMaterials() {
  const box = $("#material-list");
  const list = materialState.list.filter(m => !materialState.tag || m.tag === materialState.tag);
  const course = courseState.list.find(c => c.id === courseState.currentId);
  const isUnfiled = course?.code === "UNFILED";
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = `<div class="material-empty">${isUnfiled ? "中转区是空的，所有资料都已归类" : "暂无资料"}${materialState.tag ? "（当前标签下）" : ""}</div>`;
    updateExportBtn();
    return;
  }
  for (const m of list) {
    const row = buildMaterialRow(m, {
      editable: materialState.editMode || isUnfiled,
      isUnfiled,
      withImmersive: true,
      selected: materialState.selected,
      onToggle: updateExportBtn,
      onTagChange: () => renderMaterials(),
    });
    const immBtn = row.querySelector(".btn-imm");
    // 「注释」入口：**不打开界面**，只在后台把这份资料的注释补齐。
    // 它和「打开」职责不同：一个让内容就绪，一个负责阅读。
    if (immBtn) immBtn.onclick = guard("生成注释", () => ensureNotesFor(m));
    box.appendChild(row);
  }
  updateExportBtn();
}

function hasNativeBridge() {
  return !!(window.pywebview && window.pywebview.api);
}

async function nativeExport(ids) {
  try {
    const path = await window.pywebview.api.export_materials(JSON.stringify(ids));
    if (path) toast(`已导出到：${path}`);
    return !!path;
  } catch (e) { return false; }
}

async function nativeExportOne(mid, name) {
  try {
    const path = await window.pywebview.api.export_one(mid);
    if (path) toast(`已导出到：${path}`);
    return !!path;
  } catch (e) { return false; }
}

function updateExportBtn() {
  const btn = $("#btn-export");
  const n = materialState.selected.size;
  const course = courseState.list.find(c => c.id === courseState.currentId);
  // 未分类是中转区：不提供导出和上传，勾选/移动/删除常驻；正式课程里这些只在编辑模式出现
  const isUnfiled = course?.code === "UNFILED";
  btn.classList.toggle("hidden", isUnfiled || !materialState.editMode);
  $("#btn-edit-mode").classList.toggle("hidden", isUnfiled);
  $("#upload-label").classList.toggle("hidden", isUnfiled);
  $("#sel-all-wrap").classList.toggle("hidden", !(materialState.editMode || isUnfiled));
  btn.disabled = isUnfiled || n === 0;
  btn.textContent = n ? `导出（${n}）` : "导出";
  const mv = $("#btn-move-selected");
  mv.classList.toggle("hidden", !isUnfiled);
  mv.disabled = n === 0;
  mv.textContent = n ? `移动（${n}）` : "移动";
  const del = $("#btn-del-selected");
  del.classList.toggle("hidden", !(materialState.editMode || isUnfiled));
  del.disabled = n === 0;
  del.textContent = n ? `删除（${n}）` : "删除";
}

// 编辑模式开关：点「编辑」后才出现勾选框、导出/删除按钮
$("#btn-edit-mode").onclick = () => {
  materialState.editMode = !materialState.editMode;
  if (!materialState.editMode) {
    materialState.selected.clear();
    $("#sel-all").checked = false;
  }
  $("#btn-edit-mode").textContent = materialState.editMode ? "退出编辑" : "编辑";
  $("#btn-edit-mode").classList.toggle("btn-primary", materialState.editMode);
  $("#btn-edit-mode").classList.toggle("btn-outline", !materialState.editMode);
  $("#btn-export").classList.toggle("hidden", !materialState.editMode);
  $("#btn-del-selected").classList.toggle("hidden", !materialState.editMode);
  $("#sel-all-wrap").classList.toggle("hidden", !materialState.editMode);
  renderMaterials();
};

$("#btn-del-selected").onclick = async () => {
  const ids = [...materialState.selected];
  if (!ids.length) return;
  if (!confirm(`确定把选中的 ${ids.length} 份资料移入回收区吗？可在回收区恢复。`)) return;
  for (const id of ids) {
    await api(`/api/materials/${id}/delete`, { method: "POST" });
  }
  toast(`已把 ${ids.length} 份资料移入回收区`);
  materialState.selected.clear();
  await loadMaterials(); await loadCourses();
};

// 批量移动：把选中的资料一起移到某个课程
function openBulkMoveModal() {
  const ids = [...materialState.selected];
  if (!ids.length) return toast("请先勾选要移动的资料");
  $("#move-file-name").textContent = `已选 ${ids.length} 份资料`;
  const box = $("#move-course-list");
  box.innerHTML = "";
  for (const c of courseState.list.filter(c => c.id !== courseState.currentId && c.code !== "UNFILED")) {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    btn.textContent = `${c.code} ${c.name || ""}`;
    btn.onclick = async () => {
      for (const id of ids) {
        await api(`/api/materials/${id}/move`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ course_id: c.id }),
        });
      }
      materialState.selected.clear();
      closeModal("#modal-move");
      toast(`已把 ${ids.length} 份资料移动到 ${c.code}`);
      await loadMaterials(); await loadCourses();
    };
    box.appendChild(btn);
  }
  if (!box.children.length) box.innerHTML = `<div class="material-empty">还没有其他课程，先去新建一个</div>`;
  openModal("#modal-move");
}
$("#btn-move-selected").onclick = openBulkMoveModal;

$("#sel-all").addEventListener("change", (e) => {
  const list = materialState.list.filter(m => !materialState.tag || m.tag === materialState.tag);
  e.target.checked ? list.forEach(m => materialState.selected.add(m.id))
                   : list.forEach(m => materialState.selected.delete(m.id));
  renderMaterials();
});

$("#btn-export").onclick = async () => {
  const ids = [...materialState.selected];
  if (!ids.length) return;
  if (hasNativeBridge()) {
    const ok = ids.length === 1
      ? await nativeExportOne(ids[0])
      : await nativeExport(ids);
    if (ok) return;
  }
  if (ids.length === 1) {
    const m = materialState.list.find(x => x.id === ids[0]);
    const a = document.createElement("a");
    a.href = `/api/materials/${ids[0]}/download`;
    // 必须给真实文件名。原来写死 "file"，浏览器就存成不带扩展名的 "file"，
    // macOS 双击会用错程序打开（或显示乱码），看着就像「文件不完整」。
    a.download = (m && m.orig_name) || "资料.pdf";
    a.click();
    return;
  }
  const res = await fetch("/api/materials/export", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) return toast((await res.json()).detail || "导出失败");
  const blob = await res.blob();
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = "资料导出.zip";
  a.click();
  // 立刻 revoke 会让还没读完的下载中断（包越大越明显），留两秒再释放
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`已导出 ${ids.length} 份资料`);
};

// 移动资料弹窗

$("#tag-filter").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  materialState.tag = chip.dataset.tag;
  document.querySelectorAll("#tag-filter .chip").forEach(c => c.classList.toggle("active", c === chip));
  renderMaterials();
});

let searchTimer;
$("#material-search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { materialState.search = e.target.value; loadMaterials(); }, 250);
});

$("#file-input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  for (const f of files) {
    const fd = new FormData();
    fd.append("file", f);
    try {
      await api(`/api/courses/${courseState.currentId}/materials`, { method: "POST", body: fd });
      toast(`已上传：${f.name}，正在后台解析`);
    } catch (err) { toast(`上传失败：${err.message}`); }
  }
  await loadMaterials(); await loadCourses();
  pollProcessing();
});

async function pollProcessing() {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    await loadMaterials();
    if (!materialState.list.some(m => m.status === "pending" || m.status === "processing")) break;
  }
}

// ---------- 全局键盘分发：集中一个监听器，避免多个模块重复处理同一次按键 ----------
// 各视图用 onGlobalKey(fn) 注册；fn 返回 true 表示"我已处理，别再传下去"
const KEY_HANDLERS = [];
function onGlobalKey(fn) { KEY_HANDLERS.push(fn); }
document.addEventListener("keydown", (e) => {
  const el = document.activeElement;
  const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  for (const fn of KEY_HANDLERS) {
    try {
      if (fn({ key: e.key, typing }, e) === true) {
        // 必须阻止默认行为：WKWebView 会对「没被消费」的按键播系统提示音，
        // 表现为"翻页是成功了，但电脑响一声"
        e.preventDefault();
        return;
      }
    } catch (err) { reportError("键盘处理", err); }
  }
});

// ---------- 阅读进度：翻页即记，防抖上报 ----------
const _progressTimers = {};
function saveProgress(mid, page, delay = 1200) {
  if (!mid || !page) return;
  clearTimeout(_progressTimers[mid]);
  _progressTimers[mid] = setTimeout(() => {
    api(`/api/materials/${mid}/progress`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page }),
    }).catch(() => {});
  }, delay);
}
async function loadProgress(mid) {
  try { return (await api(`/api/materials/${mid}/progress`)).page || 0; }
  catch (e) { return 0; }
}

// ---------- 文件笔记（阅读器与沉浸模式共用同一份） ----------
// 随手写，光标停在哪一行就切哪一行：标题 15px 加粗 / 正文 13px。
// 存 JSON；升级前的纯文本笔记读出来会自动按行转成正文行，不会丢内容。
const NOTE = { mid: null, editor: null, status: null, timer: null, dirty: false };
const NOTE_PH = { title: "小标题…", body: "记点什么…" };

function noteLegacyToBlocks(text) {
  const lines = (text || "").split("\n").map(s => s.replace(/\s+$/, "")).filter(l => l.trim());
  return lines.length ? lines.map(l => ({ kind: "body", text: l })) : [{ kind: "body", text: "" }];
}

function noteMakeBlock(kind, text) {
  const el = document.createElement("div");
  el.className = "nb" + (kind === "title" ? " is-title" : "");
  el.dataset.k = kind === "title" ? "title" : "body";
  el.textContent = text || "";
  return el;
}

function noteRender(blocks) {
  const ed = NOTE.editor;
  if (!ed) return;
  ed.innerHTML = "";
  const list = blocks && blocks.length ? blocks : [{ kind: "body", text: "" }];
  list.forEach(b => ed.appendChild(noteMakeBlock(b.kind, b.text)));
  notePlaceholders();
}

// 空块给灰字提示；顺手把浏览器自动新建的裸 div / 散落文本规范成块
function notePlaceholders() {
  const ed = NOTE.editor;
  if (!ed) return;
  [...ed.childNodes].forEach(n => {
    if (n.nodeType === 3) {                       // 散落文本 → 包成块
      const t = n.textContent;
      if (!t.trim()) { n.remove(); return; }
      ed.replaceChild(noteMakeBlock("body", t), n);
    } else if (n.nodeType === 1) {
      if (n.nodeName === "BR") { n.remove(); return; }
      if (!n.classList.contains("nb")) { n.className = "nb"; n.dataset.k = "body"; }
      const k = n.dataset.k === "title" ? "title" : "body";
      n.dataset.k = k;
      const empty = !(n.textContent || "").trim();
      if (empty && n.innerHTML !== "") n.innerHTML = "";
      n.classList.toggle("is-empty", empty);
      n.dataset.ph = NOTE_PH[k];
    }
  });
  if (!ed.children.length) ed.appendChild(noteMakeBlock("body", ""));
}

function noteReadBlocks() {
  const ed = NOTE.editor;
  if (!ed) return [];
  const out = [];
  [...ed.children].forEach(el => {
    if (!el.classList.contains("nb")) return;
    const text = (el.innerText || "").replace(/\n+$/, "").trim();
    if (text) out.push({ kind: el.dataset.k === "title" ? "title" : "body", text });
  });
  return out;
}

function noteCurrentBlock() {
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode || !NOTE.editor) return null;
  let n = sel.anchorNode;
  if (n.nodeType === 3) n = n.parentNode;
  while (n && n !== NOTE.editor) {
    if (n.classList && n.classList.contains("nb")) return n;
    n = n.parentNode;
  }
  return null;
}

function noteActiveBlock() {
  return noteCurrentBlock() || (NOTE.editor && NOTE.editor.lastElementChild) || null;
}

function noteFocusEnd(el) {
  if (!el || !NOTE.editor) return;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  NOTE.editor.focus();
}

function updateNbBtns() {
  const el = noteActiveBlock();
  const kind = el && el.dataset.k === "title" ? "title" : "body";
  document.querySelectorAll(".nb-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.kind === kind));
}

function noteSetKind(kind) {
  const el = noteActiveBlock();
  if (!el) return;
  el.dataset.k = kind;
  el.classList.toggle("is-title", kind === "title");
  notePlaceholders();
  updateNbBtns();
  noteTouch();
  noteFocusEnd(el);
}

function noteBind(ed) {
  if (!ed || ed.dataset.noteBound) return;
  ed.dataset.noteBound = "1";
  ed.addEventListener("input", () => { notePlaceholders(); updateNbBtns(); noteTouch(); });
  ed.addEventListener("keydown", (e) => {
    // Cmd/Ctrl + 1 切标题、+ 2 切正文
    if ((e.metaKey || e.ctrlKey) && (e.key === "1" || e.key === "2")) {
      e.preventDefault();
      noteSetKind(e.key === "1" ? "title" : "body");
      return;
    }
    if (e.key === "Enter") {                      // 浏览器换行后立刻规范新块
      setTimeout(() => { notePlaceholders(); updateNbBtns(); noteTouch(); }, 0);
    }
  });
  ed.addEventListener("paste", (e) => {           // 粘贴一律按纯文本，避免带入外部样式
    e.preventDefault();
    const txt = ((e.clipboardData || window.clipboardData).getData("text/plain") || "")
      .replace(/\r/g, "");
    document.execCommand("insertText", false, txt);
  });
  ed.addEventListener("blur", () => { notePlaceholders(); flushNote(); });
}

function noteTouch() {
  NOTE.dirty = true;
  if (NOTE.status) NOTE.status.textContent = "保存中…";
  clearTimeout(NOTE.timer);
  NOTE.timer = setTimeout(() => { NOTE.timer = null; saveNote(); }, 800);
}

async function saveNote() {
  if (!NOTE.dirty || !NOTE.mid || !NOTE.editor) return;
  const kept = noteReadBlocks();
  try {
    await api(`/api/materials/${NOTE.mid}/mynote`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: JSON.stringify(kept) }),
    });
    NOTE.dirty = false;
    if (NOTE.status) NOTE.status.textContent = "已保存";
  } catch (e) {
    if (NOTE.status) NOTE.status.textContent = "保存失败";
  }
}

function flushNote() {
  if (NOTE.timer) { clearTimeout(NOTE.timer); NOTE.timer = null; }
  return saveNote();
}

async function loadNoteInto(mid, editorEl, statusEl) {
  await flushNote();                                  // 换资料前先把上一份落盘
  NOTE.mid = mid || null;
  NOTE.status = statusEl || null;
  NOTE.dirty = false;
  if (editorEl) noteBind(editorEl);
  NOTE.editor = editorEl || null;
  if (statusEl) statusEl.textContent = "";
  if (!NOTE.editor) return;
  noteRender([{ kind: "body", text: "" }]);
  updateNbBtns();
  if (!mid) return;
  let raw = "";
  try { raw = (await api(`/api/materials/${mid}/mynote`)).content || ""; } catch (e) { /* 还没记过 */ }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
  noteRender(Array.isArray(parsed) ? parsed : noteLegacyToBlocks(raw));
  updateNbBtns();
}

// 标题 / 正文切换按钮（两个界面共用一套按钮）
document.querySelectorAll(".nb-btn").forEach(btn => {
  btn.addEventListener("mousedown", (e) => e.preventDefault());   // 别把编辑器焦点抢走
  btn.onclick = guard("切换笔记样式", () => noteSetKind(btn.dataset.kind));
});

// 光标移动时同步按钮状态
document.addEventListener("selectionchange", () => {
  if (!NOTE.editor) return;
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode || !NOTE.editor.contains(sel.anchorNode)) return;
  updateNbBtns();
});

// ---------- 页面圈画：阅读器与沉浸模式共用一套引擎 ----------
// 坐标按页面宽高归一化（0~1）存储，所以缩放、适应宽度、换屏幕都不会错位
const INK_PEN_COLORS = ["#1f2328", "#2563eb", "#dc2626", "#059669"];
const INK_HL_COLORS = ["#fde047", "#86efac", "#f9a8d4", "#93c5fd"];
const INK_WIDTH = { pen: 0.0026, highlight: 0.03 };   // 相对页面宽度
const INK_ALPHA = { highlight: 0.38 };                // 荧光笔透明度
const INK_MIN_MOVE = 0.004;                           // 几乎没拖动就当成误触

const INK = {
  stage: null, mid: null, page: 0, statusEl: null,
  tool: "pen",
  colors: { pen: INK_PEN_COLORS[0], highlight: INK_HL_COLORS[0] },
  strokes: [], stack: [], live: null, timer: null, dirty: false,
  tbEditing: null,   // 正在编辑（刚建）的文本框：渲染时要特例保留，即使它还是空的
};

function inkCanvas() { return INK.stage && INK.stage.querySelector(".ink-canvas"); }
function inkPdfCanvas() { return INK.stage && INK.stage.querySelector(".pv-canvas"); }

function syncInkBars() {
  document.querySelectorAll(".ink-bar").forEach(bar => {
    bar.querySelectorAll("[data-tool]").forEach(b =>
      b.classList.toggle("active", b.dataset.tool === INK.tool));
  });
  if (INK.stage) INK.stage.classList.toggle("is-pointer", INK.tool === "pointer");
}

function inkRefreshColors() {
  if (INK.tool === "pointer" || INK.tool === "text") {   // 选择 / 文本框模式不需要色板
    document.querySelectorAll(".ink-bar .ink-colors").forEach(b => b.innerHTML = "");
    return;
  }
  const isHl = INK.tool === "highlight";
  const list = isHl ? INK_HL_COLORS : INK_PEN_COLORS;
  const cur = INK.colors[isHl ? "highlight" : "pen"];
  document.querySelectorAll(".ink-bar .ink-colors").forEach(box => {
    box.innerHTML = list.map(c =>
      `<button class="ink-dot${c === cur ? " active" : ""}" data-color="${c}" style="background:${c}" title="换颜色"></button>`
    ).join("");
  });
}

// ---------- 注释：列表页的「后台补齐」（不进入阅读界面）----------
async function ensureNotesFor(m) {
  try {
    const st = await api(`/api/materials/${m.id}/notes`);
    if (st.status && st.status.running) { toast("注释正在生成中，进度会显示在资料上"); return; }
    const have = (st.notes || []).length;
    const total = (st.status && st.status.total) || m.pages || 0;
    if (total && have >= total) { toast(`注释已全部生成（${have} 页）`); return; }
    const r = await api(`/api/materials/${m.id}/notes/generate`, { method: "POST" });
    if (r.started === false) { toast("注释正在生成中…"); return; }
    toast(`已开始生成注释（现有 ${have} 页），进度会刷新在资料上`);
    pollNotesUntilDone(m.id);
  } catch (e) {
    toast("启动失败：" + (e.message || e));
  }
}

// 生成期间轻量轮询，把进度刷到列表徽标；跑完自动停
let _notePollTimer = null;
function pollNotesUntilDone(mid) {
  clearInterval(_notePollTimer);
  _notePollTimer = setInterval(async () => {
    try {
      const st = await api(`/api/materials/${mid}/notes`);
      renderMaterials();
      if (!st.status || !st.status.running) {
        clearInterval(_notePollTimer);
        _notePollTimer = null;
        toast("注释生成完成");
      }
    } catch (e) {
      clearInterval(_notePollTimer);
      _notePollTimer = null;
    }
  }, 4000);
}

function inkBarSetup() {
  document.querySelectorAll(".ink-bar").forEach(bar => {
    if (bar.dataset.ready) return;
    bar.dataset.ready = "1";
    bar.addEventListener("click", guard("圈画工具", (e) => {
      const t = e.target.closest("[data-tool]");
      if (t) { INK.tool = t.dataset.tool; inkRefreshColors(); syncInkBars(); return; }
      const a = e.target.closest("[data-act]");
      if (a) {
        if (a.dataset.act === "undo") { inkUndo(); return; }
        if (a.dataset.act === "clear") { inkClear(); return; }
        if (a.dataset.act === "copysel") { copySelection(); return; }
        return;
      }
      const c = e.target.closest("[data-color]");
      if (c) { INK.colors[INK.tool] = c.dataset.color; inkRefreshColors(); }
    }));
  });
  inkRefreshColors();
  syncInkBars();
}

function inkAttach(stageSel, mid, statusEl, getPage) {
  INK.stage = $(stageSel);
  INK.mid = mid;
  INK.statusEl = statusEl || null;
  INK.getPage = getPage || null;
  if (!INK.stage) return Promise.resolve();
  if (!INK.stage.dataset.inkReady) {
    INK.stage.dataset.inkReady = "1";
    INK.stage.addEventListener("pointerdown", guard("开始圈画", inkDown));
    INK.stage.addEventListener("pointermove", guard("圈画中", inkMove));
    INK.stage.addEventListener("pointerup", guard("结束圈画", inkUp));
    INK.stage.addEventListener("pointercancel", guard("结束圈画", inkUp));
  }
  return Promise.resolve();
}

function inkFit() {
  const ink = inkCanvas(), pdf = inkPdfCanvas();
  if (!ink || !pdf || !pdf.style.width) return;
  ink.style.width = pdf.style.width;
  ink.style.height = pdf.style.height;
}

function inkDrawStroke(ctx, s, w, h) {
  const pts = s.pts || [];
  if (!pts.length) return;
  const sw = Math.max(1, (s.w || INK_WIDTH[s.tool] || 0.0026) * w);
  ctx.save();
  ctx.lineCap = s.tool === "highlight" ? "butt" : "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = sw;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  if (s.tool === "highlight") ctx.globalAlpha = INK_ALPHA.highlight;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0] * w, pts[0][1] * h, sw / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * w, pts[i][1] * h);
    ctx.stroke();
  }
  ctx.restore();
}

function inkRedraw() {
  const cv = inkCanvas();
  if (!cv) return;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // 先铺荧光笔再画圆珠笔，保证笔迹永远压在高亮之上
  for (const s of INK.strokes) if (s.tool === "highlight") inkDrawStroke(ctx, s, w, h);
  for (const s of INK.strokes) if (s.tool !== "highlight") inkDrawStroke(ctx, s, w, h);
}

function inkPos(e) {
  const cv = inkCanvas();
  const r = cv.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
}

function inkSnapshot() {
  INK.stack.push(JSON.stringify(INK.strokes));
  if (INK.stack.length > 40) INK.stack.shift();
}

function _segDist(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

function inkHitIndex(nx, ny) {
  const cv = inkCanvas();
  const w = cv.clientWidth, h = cv.clientHeight;
  const p = [nx * w, ny * h];
  for (let i = INK.strokes.length - 1; i >= 0; i--) {
    const s = INK.strokes[i];
    const sw = Math.max(1, (s.w || INK_WIDTH[s.tool] || 0.0026) * w);
    const r = sw / 2 + 5;
    const pts = s.pts.map(q => [q[0] * w, q[1] * h]);
    if (pts.length === 1) {
      if (Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) <= r) return i;
      continue;
    }
    for (let k = 1; k < pts.length; k++) {
      if (_segDist(p, pts[k - 1], pts[k]) <= r) return i;
    }
  }
  return -1;
}

// ---------- 选择模式：交回浏览器原生选择 ----------
// 曾经自己实现过一套「拖拽框选」，但它只能做到**块级**选择（整块选中 / 不选），
// 达不到原生那种**字符级**精度（从哪个字选到哪个字），所以怎么调都不对。
// 文字层坐标修正之后原生选择本来就能用，是这套自实现用 preventDefault 把它挡住了。
// 现在 pointer 模式下完全不拦截事件 —— 高亮、双击选词、Cmd+C 全部交给浏览器。
function _selBtns() { return document.querySelectorAll('[data-act="copysel"]'); }

function currentSelectionText() {
  const sel = window.getSelection();
  return sel ? sel.toString().replace(/[ \t]+/g, " ").trim() : "";
}

function selClear() {
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  _selBtns().forEach(b => b.classList.add("hidden"));
  document.querySelectorAll(".ink-status").forEach(s => { s.textContent = ""; });
}

// 有选区时才露出「复制选中」。
// 注意别在这里更新状态栏字数：selectionchange 在拖动时**每帧都触发**，
// 而状态栏文字一变宽，flex-wrap 的工具条就要重新布局、下面的内容跟着位移，
// 选区又变 → 再位移，看上去就是「不断颤动」。
// 所以：这里只做最轻的按钮显隐（且加节流），字数提示挪到松手时更新。
let _selTick = null;
document.addEventListener("selectionchange", () => {
  if (_selTick) return;
  _selTick = setTimeout(() => {
    _selTick = null;
    const has = !!currentSelectionText();
    _selBtns().forEach(b => b.classList.toggle("hidden", !has));
  }, 150);
});

// 松手（或 Esc 取消）后才更新状态栏字数 —— 此时不再连续变化，不会引起抖动
const _syncSelStatus = () => {
  if (!INK.stage) return;
  const t = currentSelectionText();
  const next = t ? `已选 ${t.length} 字（Cmd+C 或点「复制选中」）` : "";
  document.querySelectorAll(".ink-status").forEach(s => {
    if (s.textContent !== next) s.textContent = next;   // 值没变就别写 DOM
  });
};
document.addEventListener("pointerup", () => setTimeout(_syncSelStatus, 0), true);
document.addEventListener("pointercancel", _syncSelStatus, true);

// （自实现的矩形框选、块级判定、手工拼接文字都已在 2026-10-06 移除：
//   块级选择达不到原生字符级精度，改由浏览器原生处理）

async function copySelection() {
  const t = currentSelectionText();
  if (!t) { toast("没有选中文字：切到「选择」后拖选，或双击选词"); return; }
  try {
    await navigator.clipboard.writeText(t);
    toast(`已复制 ${t.length} 个字符`);
  } catch (e) {
    toast("复制失败：" + (e.message || e));
  }
}

// ---------- 文本框：在页面上打字 ----------
// 固定字号（取页面宽度的比例，缩放时视觉一致），不做字号选择。
// 数据直接放进 INK.strokes（归一化坐标），复用圈画那套加载 / 保存 / 切页逻辑。
const TB_SIZE = 0.019;      // 字号 = 页面宽度 × 该比例
const TB_COLOR = "#1a1a1a";

function tbLayer() {
  if (!INK.stage) return null;
  let el = INK.stage.querySelector(".tb-layer");
  if (!el) {
    el = document.createElement("div");
    el.className = "tb-layer";
    INK.stage.appendChild(el);
  }
  return el;
}

// 只在换页 / 缩放 / 增删文本框时重建，**不能**放进 inkRedraw ——
// 画线时 inkRedraw 每帧都跑，重建 DOM 会把正在输入的光标弄丢
function tbRender() {
  const layer = tbLayer();
  if (!layer) return;
  const w = layer.clientWidth || (INK.stage && INK.stage.clientWidth) || 1;
  // 重建前**先回收**：直接拆 DOM 不会触发 blur，正在编辑的空框的清理逻辑就永远跑不到
  layer.querySelectorAll(".tb-item").forEach(el => {
    if (el.__tbStroke) tbSync(el, el.__tbStroke);
  });
  layer.innerHTML = "";
  // 清掉「没内容且不是正在编辑」的框（历史脏数据 + 前面失焦留下的空框）。
  // 关键：必须把 INK.tbEditing 排除在外 —— 刚新建的框内容为空，
  // 无差别过滤会让它被自己的渲染函数删掉，表现就是「点一下什么都没出现」。
  const before = INK.strokes.length;
  INK.strokes = INK.strokes.filter(s =>
    s.tool !== "text" || s === INK.tbEditing || (s.text && s.text.trim()));
  if (INK.strokes.length !== before) inkTouch();

  for (const s of INK.strokes) {
    if (s.tool !== "text") continue;
    if (!s.text && s !== INK.tbEditing) continue;

    // 外面套一层 wrap：删除按钮 / 缩放把手不能放进 contenteditable 里，
    // 否则它们会变成可编辑内容（退格删不掉，还会被 tbSync 的 textContent 读进去）
    const wrap = document.createElement("div");
    wrap.className = "tb-wrap";
    wrap.style.left = (s.x * 100) + "%";
    wrap.style.top = (s.y * 100) + "%";

    const el = document.createElement("div");
    el.className = "tb-item";
    el.contentEditable = "true";
    el.spellcheck = false;
    el.textContent = s.text || "";
    el.style.fontSize = Math.max(11, s.size * w) + "px";
    if (s.w) el.style.width = (s.w * w) + "px";                            // 拖过宽度就固定下来
    el.__tbStroke = s;                                                     // 回收时要靠它找回数据
    el.addEventListener("blur", () => { if (!tbSync(el, s)) tbRender(); }); // 空框失焦 → 立刻从画面移除
    el.addEventListener("keydown", (ev) => {
      ev.stopPropagation();                    // 编辑时不触发全局快捷键（翻页等）
      if (ev.key === "Escape") { ev.preventDefault(); el.blur(); }
    });

    // 未聚焦时按住框体 = 拖动移动；已聚焦则交给浏览器选字
    wrap.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();                    // 别让 stage 当成「新建框」
      if (document.activeElement === el) return;
      tbStartDrag(ev, s, wrap, el);
    });

    const rz = document.createElement("div");
    rz.className = "tb-resize";
    rz.title = "拖动调整宽度";
    rz.addEventListener("pointerdown", (ev) => { ev.preventDefault(); ev.stopPropagation(); tbStartResize(ev, s, el); });

    const del = document.createElement("button");
    del.className = "tb-del";
    del.type = "button";
    del.textContent = "×";
    del.title = "删除这个文本框";
    del.addEventListener("pointerdown", (ev) => { ev.preventDefault(); ev.stopPropagation(); });
    del.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const i = INK.strokes.indexOf(s);
      if (i >= 0) INK.strokes.splice(i, 1);
      inkTouch();
      tbRender();
    });

    wrap.appendChild(el);
    wrap.appendChild(rz);
    wrap.appendChild(del);
    layer.appendChild(wrap);
    if (s === INK.tbEditing) el.focus();       // 新建的框直接进入编辑，不再靠 lastElementChild 猜
  }
}

// 拖动移动：直接改 wrap 的位置，**不重渲染**（重建会丢编辑焦点）。
// 位移不足 3px 视为「点击」→ 转成进入编辑，这样「点一下就能打字」的手感还在。
function tbStartDrag(ev, s, wrap, el) {
  ev.preventDefault();
  const rect = INK.stage.getBoundingClientRect();
  const x0 = ev.clientX, y0 = ev.clientY, sx = s.x, sy = s.y;
  let moved = false;
  wrap.classList.add("dragging");
  const move = (e) => {
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;
    s.x = Math.min(0.98, Math.max(0, sx + dx / rect.width));
    s.y = Math.min(0.98, Math.max(0, sy + dy / rect.height));
    wrap.style.left = (s.x * 100) + "%";
    wrap.style.top = (s.y * 100) + "%";
  };
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    wrap.classList.remove("dragging");
    if (moved) inkTouch();     // 真移动过才落库
    else el.focus();           // 没移动 = 点击 → 进入编辑
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

// 拖动右下角调宽度：只改换行范围，字号保持固定（本项目刻意不做字号选择）
function tbStartResize(ev, s, el) {
  ev.preventDefault();
  const rect = INK.stage.getBoundingClientRect();
  const x0 = ev.clientX;
  const w0 = el.getBoundingClientRect().width;
  const move = (e) => {
    const nw = Math.max(40, w0 + (e.clientX - x0));
    el.style.width = nw + "px";
    s.w = nw / rect.width;
  };
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    inkTouch();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

// 把 DOM 里的内容同步回数据；空框则从 INK.strokes 里剔除（返回是否保留）
function tbSync(el, s) {
  const txt = (el.textContent || "").replace(/\u00a0/g, " ").trim();
  if (!txt) {
    const i = INK.strokes.indexOf(s);
    if (i >= 0) INK.strokes.splice(i, 1);
    inkTouch();
    return false;
  }
  if (s.text !== txt) { s.text = txt; inkTouch(); }
  return true;
}

function tbAdd(nx, ny) {
  const s = { tool: "text", size: TB_SIZE, color: TB_COLOR, text: "",
              x: Math.min(0.98, Math.max(0, nx)), y: Math.min(0.98, Math.max(0, ny)) };
  INK.strokes.push(s);
  INK.tbEditing = s;      // 标明「这个框正要编辑」，渲染时才不会被当成空框清掉
  tbRender();
  INK.tbEditing = null;
}

function inkDown(e) {
  if (!INK.stage || !inkCanvas()) return;
  if (INK.tool === "pointer") return;    // 选择模式：完全不拦截，交给浏览器原生选择
  if (INK.tool === "text") {             // 文本框：点哪儿在哪儿建一个
    e.preventDefault();
    const r = INK.stage.getBoundingClientRect();
    tbAdd((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    return;
  }
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  const [x, y] = inkPos(e);
  if (x < 0 || y < 0 || x > 1 || y > 1) return;
  inkSnapshot();
  if (INK.tool === "eraser") {
    const i = inkHitIndex(x, y);
    if (i >= 0) { INK.strokes.splice(i, 1); inkRedraw(); inkTouch(); }
    else INK.stack.pop();                      // 没擦到东西就不留撤销点
    return;
  }
  INK.live = {
    tool: INK.tool,
    color: INK.colors[INK.tool] || INK_PEN_COLORS[0],
    w: INK_WIDTH[INK.tool] || INK_WIDTH.pen,
    pts: [[x, y]],
  };
  INK.strokes.push(INK.live);
  if (INK.stage.setPointerCapture) { try { INK.stage.setPointerCapture(e.pointerId); } catch (_) {} }
  inkRedraw();
}

function inkMove(e) {
  if (!INK.live) return;
  e.preventDefault();
  const [x, y] = inkPos(e);
  const pts = INK.live.pts, last = pts[pts.length - 1];
  const w = inkCanvas().clientWidth || 1;
  if (Math.abs(x - last[0]) * w < 1.2 && Math.abs(y - last[1]) * w < 1.2) return;
  pts.push([x, y]);
  inkRedraw();
}

function inkUp() {
  if (!INK.live) return;
  const pts = INK.live.pts;
  let moved = 0;
  for (let i = 1; i < pts.length; i++) moved += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (moved < INK_MIN_MOVE) { INK.strokes.pop(); INK.stack.pop(); }   // 点一下不算画
  INK.live = null;
  inkRedraw();
  inkTouch();
}

function inkUndo() {
  if (!INK.stack.length) return toast("没有可撤销的操作");
  INK.strokes = JSON.parse(INK.stack.pop());
  inkRedraw();
  inkTouch();
}

function inkClear() {
  if (!INK.strokes.length) return;
  if (!confirm("清空本页所有圈画？")) return;
  inkSnapshot();
  INK.strokes = [];
  inkRedraw();
  inkTouch();
}

function inkTouch() {
  INK.dirty = true;
  if (INK.statusEl) INK.statusEl.textContent = "保存中…";
  clearTimeout(INK.timer);
  INK.timer = setTimeout(() => { INK.timer = null; inkSave(); }, 700);
}

async function inkSave() {
  if (!INK.dirty || !INK.mid || !INK.page) return;
  try {
    await api(`/api/materials/${INK.mid}/ink/${INK.page}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: JSON.stringify(INK.strokes) }),
    });
    INK.dirty = false;
    if (INK.statusEl) INK.statusEl.textContent = "已保存";
  } catch (e) {
    if (INK.statusEl) INK.statusEl.textContent = "保存失败";
  }
}

function inkFlush() {
  if (INK.timer) { clearTimeout(INK.timer); INK.timer = null; }
  return inkSave();
}

// 翻页时调用：先落盘上一页，再加载这一页的圈画
async function inkGotoPage(page) {
  await inkFlush();
  INK.page = page || 0;
  INK.strokes = [];
  INK.stack = [];
  INK.live = null;
  if (INK.mid && INK.page) {
    try {
      const r = await api(`/api/materials/${INK.mid}/ink/${INK.page}`);
      const parsed = JSON.parse(r.data || "[]");
      if (Array.isArray(parsed)) INK.strokes = parsed;
    } catch (e) { /* 没有圈画就是空的 */ }
  }
  inkFit();
  inkRedraw();
  tbRender();   // 换了页就要重建文本框层，否则会残留上一页的框、也显示不出本页的
}

// PDF 重渲染后（缩放 / 换页）尺寸变了，重新对齐并重绘
function inkAfterRender() { inkFit(); inkRedraw(); selClear(); tbRender(); }   // 换页 / 缩放后重排文本框并清掉旧选区

// ---------- PDF 文本层：让位图上的文字可以选中、复制 ----------
// 位图给视觉，文本层给"可选中可复制"。文字透明，浏览器原生选中高亮可见。
// 与 pdf.js 的 Util.transform 完全一致。
// 注意：两个矩阵的分量顺序很容易写错（把 m1 的平移项当成 m2 的用），
// 写错的表现是文字层坐标跑到页面外几万像素处 —— 拖选时鼠标下没有元素，
// 于是「怎么都选不中文字」。
function _applyTransform(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

async function renderTextLayer(page, viewport) {
  const container = INK.stage && INK.stage.querySelector(".text-layer");
  if (!container) return;
  let tc;
  try { tc = await page.getTextContent(); }
  catch (e) { container.innerHTML = ""; return; }
  container.innerHTML = "";
  container.style.width = viewport.width + "px";
  container.style.height = viewport.height + "px";
  const vt = viewport.transform;
  const frag = document.createDocumentFragment();
  for (const item of (tc.items || [])) {
    if (!item.str) continue;
    const t = _applyTransform(vt, item.transform);
    const fontSize = Math.max(1, Math.hypot(t[0], t[1]));
    const span = document.createElement("span");
    span.className = "tl-item";
    span.textContent = item.str;
    span.style.left = t[4] + "px";
    // 盒子上沿对齐到文字的**视觉顶部**（基线上方约 0.82 倍字高），而不是从基线往上
    // 整整一个字高 —— 后者会让盒子比视觉文字高出一截，和上一行的盒子重叠，
    // 拖选时指针落在重叠区就会被判成上一行，表现就是「动不动往上多选一行」。
    span.style.top = (t[5] - fontSize * 0.82) + "px";
    span.style.height = (fontSize * 0.9) + "px";
    span.style.lineHeight = "1";
    span.style.fontSize = fontSize + "px";
    span.dataset.w = String((item.width || 0) * Math.hypot(vt[0], vt[1]));   // PDF 里的原始宽度
    frag.appendChild(span);
  }
  container.appendChild(frag);
  // 字宽校正：浏览器字体的宽度和 PDF 里的实际宽度对不上，逐块累积会让相邻块**互相重叠**
  // （实测首行块间重叠 5.6~15px），鼠标落进重叠区就选不准，视觉上文字也会从位图漂开。
  // 用 scaleX 把每块压到 PDF 原始宽度 —— 这正是 pdf.js 官方 textLayer 的做法。
  // 先批量读宽度、再批量写，避免边读边写触发反复重排。
  const spans = [...container.querySelectorAll(".tl-item")];
  const measured = spans.map(s => s.getBoundingClientRect().width);
  spans.forEach((s, i) => {
    const w = Number(s.dataset.w || 0);
    if (w > 0.5 && measured[i] > 0.5) {
      s.style.transform = `scaleX(${(w / measured[i]).toFixed(4)})`;
    }
  });

  // 行间空白归属：PDF 的行距常常远大于字高（标题到正文尤其明显），拖动时指针落在
  // 空白处，浏览器会把选择起点吸附到**上一行**（实测点标题下方 8~40px 仍选中标题），
  // 表现就是「只想选下面一行，却把上面一行也带上了」。
  // 这里把每行的盒子**向上扩到与上一行间隙的中点**，空白区就变成「离谁近选谁」。
  // 只处理明显间隙（>6px），普通行距不动，避免盒子互相重叠反而更糟。
  const rows = new Map();
  spans.forEach(s => {
    const k = Math.round(parseFloat(s.style.top) || 0);
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push(s);
  });
  const rowTops = [...rows.keys()].sort((a, b) => a - b);
  for (let i = 1; i < rowTops.length; i++) {
    const prev = rows.get(rowTops[i - 1])[0];
    const cur = rows.get(rowTops[i])[0];
    const prevTop = parseFloat(prev.style.top) || 0;
    const prevH = parseFloat(prev.style.height) || 0;
    const curTop = parseFloat(cur.style.top) || 0;
    const curH = parseFloat(cur.style.height) || 0;
    const gap = curTop - (prevTop + prevH);
    if (gap > 6) {
      // 一口气扩到中点（gap * 0.5 天然不会碰到上一行），
      // 再用 2 倍字高兜住「页尾大段空白」——那种情况不该把盒子拉到几十像素高
      const grow = Math.min(gap * 0.5, curH * 2);
      rows.get(rowTops[i]).forEach(s => {
        s.style.top = ((parseFloat(s.style.top) || 0) - grow) + "px";
        s.style.height = ((parseFloat(s.style.height) || 0) + grow) + "px";
      });
    }
  }
}

// ---------- PDF 目录（内嵌书签）----------
// 后端一次解析好整棵目录树，前端只渲染；同一份资料的结果缓存在内存里
const OUTLINE_CACHE = {};
async function loadOutline(mid) {
  if (OUTLINE_CACHE[mid]) return OUTLINE_CACHE[mid];
  try {
    const r = await api(`/api/materials/${mid}/outline`);
    OUTLINE_CACHE[mid] = r.items || [];
  } catch (e) { OUTLINE_CACHE[mid] = []; }
  return OUTLINE_CACHE[mid];
}

function renderOutline(container, items, currentPage, onJump) {
  if (!container) return;
  container.innerHTML = "";
  if (!items.length) {
    container.innerHTML = '<div class="toc-empty">这份 PDF 没有内嵌目录。'
      + '<br><span class="muted">扫描版、或制作者没加书签的文档通常没有。</span></div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const a = document.createElement("a");
    a.className = "toc-item" + (it.page === currentPage ? " active" : "");
    a.href = "javascript:void(0)";
    a.dataset.page = it.page;
    a.style.paddingLeft = (10 + Math.min(it.level, 4) * 14) + "px";
    a.innerHTML = `<span class="toc-title">${esc(it.title || "(无标题)")}</span>`
                + (it.page ? `<span class="toc-page">${it.page}</span>` : "");
    a.onclick = () => onJump(it.page, a);
    frag.appendChild(a);
  }
  container.appendChild(frag);
}

// 翻页后：高亮当前页所在项，并保证它在可视区内
function markOutline(container, page) {
  if (!container) return;
  let hit = null;
  container.querySelectorAll(".toc-item").forEach(a => {
    const on = Number(a.dataset.page) === page;
    a.classList.toggle("active", on);
    if (on) hit = a;
  });
  if (hit) hit.scrollIntoView({ block: "nearest" });
}

// 圈画工具条事件只需绑一次（阅读器与沉浸模式各一条）
inkBarSetup();

// ---------- 通用拖拽排序（待办等列表共用） ----------
function makeSortable(container, onReorder) {
  const items = [...container.querySelectorAll("[data-sort-id]")];
  let dragId = null;
  for (const el of items) {
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      dragId = el.dataset.sortId;
      el.classList.add("dragging");
      try { e.dataTransfer.setData("text/plain", dragId); e.dataTransfer.effectAllowed = "move"; } catch (_) {}
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("dragging");
      dragId = null;
    });
    el.addEventListener("dragover", (e) => {
      if (!dragId || dragId === el.dataset.sortId) return;
      e.preventDefault();
      const moving = container.querySelector(`[data-sort-id="${dragId}"]`);
      if (!moving) return;
      const r = el.getBoundingClientRect();
      const after = (e.clientY - r.top) > r.height / 2;
      container.insertBefore(moving, after ? el.nextSibling : el);
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      const ids = [...container.querySelectorAll("[data-sort-id]")].map(x => x.dataset.sortId);
      onReorder(ids);
    });
  }
}

// ---------- 按时间自动切换深浅色（19:00–07:00 深色） ----------
const DARK_FROM_HOUR = 19;
const DARK_TO_HOUR = 7;
function applyThemeByTime() {
  const h = new Date().getHours();
  const dark = h >= DARK_FROM_HOUR || h < DARK_TO_HOUR;
  document.body.classList.toggle("theme-dark", dark);
}
applyThemeByTime();
setInterval(applyThemeByTime, 60 * 60 * 1000);   // 每小时检查一次即可
