/* 课程与资料域：侧栏课程 / 课程内标签页 / 资料列表 / 批量导入 / 回收区 / PDF 阅读器 */
/* 学习域视图：课程 / 资料 / 批量导入 / 回收区 / 出题 / 聊天 / 设置 / 阅读器 */
/* 各视图渲染与交互（依赖 core.js 提供的工具层）*/
// ---------- 课程 ----------
async function loadCourses() {
  courseState.list = await api("/api/courses");
  renderCourses();
}

const GROUP_LABEL = { major: "专业课", easy: "水课", elective: "额外选修课" };

// 侧栏折叠状态（localStorage 持久化，默认全展开）
function getCollapsed() {
  return storage.getJSON("sls-collapsed", {});
}
function isCollapsed(key) { return !!getCollapsed()[key]; }
function toggleCollapsed(key) {
  const s = getCollapsed();
  s[key] = !s[key];
  storage.setJSON("sls-collapsed", s);
  renderCourses();
}

function parseYearSem(semester) {
  const s = (semester || "").trim();
  const m = s.match(/^(Year\s*\d)\s*(S\d)?$/i);
  if (m) return { year: m[1].replace(/\s+/, " "), sem: (m[2] || "").toUpperCase() };
  if (s) return { year: s, sem: "" };  // 非标准学期串，整串作为年份组
  return { year: "", sem: "" };        // 未指定
}

function renderCourses() {
  const box = $("#course-list");
  box.innerHTML = "";

  const unfiled = courseState.list.filter(c => c.code === "UNFILED");
  const groups = { major: [], easy: [], elective: [] };
  for (const c of courseState.list) {
    if (c.code === "UNFILED") continue;
    (groups[c.course_group] || groups.major).push(c);
  }

  renderGroup(box, "major", "专业课", groups.major);
  renderGroup(box, "easy", "水课", groups.easy);
  renderGroup(box, "elective", "额外选修课", groups.elective);

  // 未分类：独立可折叠一栏
  renderGroup(box, "unfiled", "未分类", unfiled);
}

function renderGroup(box, key, label, courses) {
  const collapsed = isCollapsed(key);
  addGroupHeader(box, key, label, courses.length, collapsed);
  if (collapsed) return;
  if (!courses.length) { addHint(box, "暂无"); return; }

  if (key !== "major") {
    courses.forEach(c => box.appendChild(courseBtn(c)));
    return;
  }
  // 专业课：Year → Semester 两级折叠
  const yearMap = {};
  for (const c of courses) {
    const { year, sem } = parseYearSem(c.semester);
    (yearMap[year] = yearMap[year] || {})[sem] = (yearMap[year][sem] || []).concat(c);
  }
  const yearRank = (y) => { const m = y.match(/^Year (\d)$/i); return m ? -Number(m[1]) : (y === "" ? 100 : 99); };
  const semRank = (s) => s === "S2" ? 0 : s === "S1" ? 1 : 99;
  const years = Object.keys(yearMap).sort((a, b) => yearRank(a) - yearRank(b));
  for (const y of years) {
    const yKey = `major:${y}`;
    const yCollapsed = isCollapsed(yKey);
    const yCount = Object.values(yearMap[y]).reduce((n, arr) => n + arr.length, 0);
    addGroupHeader(box, yKey, y || "未指定学年", yCount, yCollapsed, true);
    if (yCollapsed) continue;
    const sems = Object.keys(yearMap[y]).sort((a, b) => semRank(a) - semRank(b));
    for (const s of sems) {
      const list = yearMap[y][s];
      const sKey = `major:${y}|${s}`;
      const sCollapsed = isCollapsed(sKey);
      if (s) {
        addGroupHeader(box, sKey, s, list.length, sCollapsed, true);
        if (sCollapsed) continue;
      }
      list.forEach(c => box.appendChild(courseBtn(c, !!s)));
    }
  }
}

function addGroupHeader(box, key, text, count, collapsed, sub) {
  const div = document.createElement("button");
  div.className = "group-header" + (sub ? " sub" : "");
  div.innerHTML = `<span class="arr">${collapsed ? "▸" : "▾"}</span><span>${esc(text)}</span><span class="cnt">${count}</span>`;
  div.onclick = () => toggleCollapsed(key);
  box.appendChild(div);
}
function addHint(box, text) {
  const div = document.createElement("div");
  div.className = "group-hint";
  div.textContent = text;
  box.appendChild(div);
}
function courseBtn(c, showSem) {
  const isUnfiled = c.code === "UNFILED";
  const wrap = document.createElement("div");
  wrap.className = "course-row";
  const btn = document.createElement("button");
  btn.className = "course-item" + (c.id === courseState.currentId ? " active" : "");
  btn.innerHTML = `<span class="code">${isUnfiled ? "未分类" : esc(c.code)}</span>
    <span class="name">${showSem && c.semester ? esc(c.semester) + " · " : ""}${isUnfiled ? "未识别出课程代码的资料" : esc(c.name || "未命名课程")} · ${c.material_count} 份资料</span>`;
  btn.onclick = guard(`打开课程 ${c.code}`, () => openCourse(c.id));
  wrap.appendChild(btn);
  // 箭头：展开该课程的操作菜单（编辑 / 导出 / 删除）
  const arrow = document.createElement("button");
  arrow.className = "course-arrow";
  arrow.title = "课程操作";
  arrow.textContent = "▸";
  const menu = document.createElement("div");
  menu.className = "course-menu hidden";
  const mkItem = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = (e) => { e.stopPropagation(); menu.classList.add("hidden"); fn(); };
    menu.appendChild(b);
  };
  if (!isUnfiled) mkItem("编辑课程", () => openEditModal(c));
  mkItem("导出资料", async () => {
    await openCourse(c.id);
    materialState.selected.clear();
    (await api(`/api/courses/${c.id}/materials`)).forEach(m => materialState.selected.add(m.id));
    renderMaterials();
    toast("已全选本课程资料，点击上方「导出所选」即可导出");
  });
  mkItem("删除课程", async () => {
    const n = c.material_count;
    // 先取真实条数，确认框里把「能恢复的」和「不可恢复的」分清
    let msgCount = 0;
    try { msgCount = (await api(`/api/courses/${c.id}/messages`)).length; } catch (e) { /* 取不到就不显示 */ }
    const lines = [
      `确定要删除课程「${c.code}」吗？`,
      "",
      `· ${n} 份资料 → 移入回收区，之后可以恢复`,
      msgCount ? `· ${msgCount} 条对话记录 → 永久删除，无法恢复` : "· 无对话记录",
      "· 课程从课表移除（重新导入课表可找回）",
      "",
      "注意：此操作无法整体撤销。",
    ];
    if (!confirm(lines.join("\n"))) return;
    // 第二道关：输入课程代码确认，防止手滑点到
    const typed = prompt(`为防止误删，请输入课程代码确认：\n${c.code}`);
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== c.code.toUpperCase()) {
      toast("课程代码不匹配，已取消删除");
      return;
    }
    await api(`/api/courses/${c.id}`, { method: "DELETE" });
    toast(`已删除课程 ${c.code}，${n} 份资料在回收区`);
    if (courseState.currentId === c.id) courseState.currentId = null;
    await loadCourses();
    showHome();
  });
  arrow.onclick = (e) => {
    e.stopPropagation();
    document.querySelectorAll(".course-menu").forEach(m => { if (m !== menu) m.classList.add("hidden"); });
    menu.classList.toggle("hidden");
  };
  wrap.appendChild(arrow);
  wrap.appendChild(menu);
  return wrap;
}
document.addEventListener("click", () =>
  document.querySelectorAll(".course-menu").forEach(m => m.classList.add("hidden")));

let editingCourseId = null;

function syncSemesterField() {
  const isMajor = $("#course-group").value === "major";
  $("#field-semester").classList.toggle("hidden", !isMajor);
  $("#field-credits").classList.toggle("hidden", !isMajor);
}
$("#course-group").addEventListener("change", syncSemesterField);

$("#btn-new-course").onclick = () => {
  editingCourseId = null;
  $("#modal-course-title").textContent = "新建课程";
  $("#btn-save-course").textContent = "创建";
  $("#course-code").value = ""; $("#course-name").value = ""; $("#course-semester").value = ""; $("#course-credits").value = "";
  $("#course-code").disabled = false;
  syncSemesterField();
  openModal("#modal-course");
};

function openEditModal(c) {
  editingCourseId = c.id;
  $("#modal-course-title").textContent = "编辑课程";
  $("#btn-save-course").textContent = "保存";
  $("#course-code").value = c.code;
  $("#course-code").disabled = true;
  $("#course-name").value = c.name || "";
  $("#course-semester").value = c.semester || "";
  $("#course-credits").value = c.credits || "";
  $("#course-group").value = c.course_group || "major";
  syncSemesterField();
  openModal("#modal-course");
}
$("#btn-edit-course").onclick = () => {
  const c = courseState.list.find(x => x.id === courseState.currentId);
  if (c && c.code !== "UNFILED") openEditModal(c);
};

$("#btn-save-course").onclick = async () => {
  const code = $("#course-code").value.trim();
  const name = $("#course-name").value.trim();
  const group = $("#course-group").value;
  const semester = group === "major" ? $("#course-semester").value.trim() : "";
  if (editingCourseId) {
    const patch = { name, semester, group };
    if (group === "major") patch.credits = parseFloat($("#course-credits").value) || 0;
    await api(`/api/courses/${editingCourseId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    closeModal("#modal-course");
    await loadCourses();
    toast("课程已更新");
    if (courseState.currentId) openCourse(courseState.currentId);
    return;
  }
  if (!code) return toast("课程代码不能为空");
  const fd = new FormData();
  fd.append("code", code);
  fd.append("name", name);
  fd.append("semester", semester);
  fd.append("group", group);
  if (group === "major") fd.append("credits", $("#course-credits").value || "0");
  await api("/api/courses", { method: "POST", body: fd });
  closeModal("#modal-course");
  await loadCourses();
  const fresh = courseState.list.find(c => c.code === code);
  if (fresh) openCourse(fresh.id);
  toast("课程已创建");
};

async function openCourse(id) {
  courseState.currentId = id;
  materialState.selected.clear();
  $("#sel-all").checked = false;
  // 重置筛选与编辑状态：防止上一次的标签/搜索残留把列表“清空”
  materialState.tag = ""; materialState.search = ""; quizState.scopeTag = "";
  materialState.editMode = false; courseState.hbEdit = false;
  $("#material-search").value = "";
  document.querySelectorAll("#tag-filter .chip").forEach(c => c.classList.toggle("active", c.dataset.tag === ""));
  document.querySelectorAll("#quiz-tag-filter .chip").forEach(c => c.classList.toggle("active", c.dataset.tag === ""));
  $("#btn-edit-mode").textContent = "编辑";
  $("#btn-edit-mode").classList.remove("btn-primary");
  $("#btn-edit-mode").classList.add("btn-outline");
  $("#btn-del-selected").classList.add("hidden");
  $("#btn-export").classList.add("hidden");
  $("#sel-all-wrap").classList.add("hidden");
  const c = courseState.list.find(x => x.id === id);
  const isUnfiled = c.code === "UNFILED";
  $("#course-title").textContent = isUnfiled ? "未分类" : c.code + (c.name ? ` ${c.name}` : "");
  $("#course-sub").textContent = isUnfiled
    ? "批量导入未能识别课程代码的资料，可移动到对应课程"
    : [GROUP_LABEL[c.course_group] || "专业课", c.semester, `${c.material_count} 份资料`].filter(Boolean).join(" · ");
  $("#btn-clear-chat").classList.toggle("hidden", isUnfiled);
  $("#btn-edit-course").classList.toggle("hidden", isUnfiled);
  // 未分类只是中转区：不需要 HandBook 和互动学习，只留资料库
  $("#tab-bar").classList.toggle("hidden", isUnfiled);
  showView("course");
  switchTab("materials");   // 进课程直接看资料库，HandBook 不会有人一直翻
  await loadMaterials();
  if (!isUnfiled) await loadMessages();
}

// ---------- 课程内标签页 ----------
function switchTab(tab) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  $("#panel-materials").classList.toggle("hidden", tab !== "materials");
  $("#panel-study").classList.toggle("hidden", tab !== "study");
  $("#panel-handbook").classList.toggle("hidden", tab !== "handbook");
  if (tab === "study") { renderQuizScope(); loadCoverage(); }
  if (tab === "handbook") renderHandbook();
}
document.querySelectorAll(".tab").forEach(t => t.onclick = () => switchTab(t.dataset.tab));

// ---------- 资料 ----------
async function loadMaterials() {
  if (!courseState.currentId) return;
  const qs = new URLSearchParams();
  if (materialState.search) qs.set("q", materialState.search);
  materialState.list = await api(`/api/courses/${courseState.currentId}/materials?${qs}`);
  renderMaterials();
  renderQuizScope();
  refreshOrganizeBtns();
}

// AI 整理：给本课程还没生成摘要的资料补跑一次入库分析
$("#btn-ai-organize").onclick = guard("AI 整理", () => startOrganize(courseState.currentId || ""));

// ---------- 批量导入 ----------
const dz = $("#drop-zone");
["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => {
  e.preventDefault(); dz.classList.add("dragover");
}));
["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => {
  e.preventDefault(); dz.classList.remove("dragover");
}));
dz.addEventListener("drop", e => {
  const f = [...e.dataTransfer.files].find(f => f.name.toLowerCase().endsWith(".zip"));
  f ? runBatchImport(f) : toast("请拖入 .zip 压缩包");
});
$("#zip-input").addEventListener("change", e => {
  const f = e.target.files[0];
  e.target.value = "";
  if (f) runBatchImport(f);
});

async function runBatchImport(file) {
  const report = $("#import-report");
  report.classList.remove("hidden");
  report.innerHTML = `⏳ 正在导入「${esc(file.name)}」…（导入后各文件会在后台依次解析）`;
  const fd = new FormData();
  fd.append("file", file);
  try {
    const r = await api("/api/batch-import", { method: "POST", body: fd });
    await loadCourses();
    const lines = [];
    lines.push(`<div class="ok">成功归类 ${r.matched.length} 份 → ${r.courses_touched.map(esc).join("、") || "无"}</div>`);
    if (r.handbooks?.length) {
      lines.push(`<div class="ok">HandBook ${r.handbooks.length} 份已导入，后台 AI 扫描考核构成中（1-2 分钟后到课程页/均分页查看）：</div>`);
      lines.push(r.handbooks.map(u => `&nbsp;&nbsp;· ${esc(u.file)} → ${esc(u.course)}`).join("<br>"));
    }
    if (r.hb_skipped?.length) {
      lines.push(`<div class="warn">以下 HandBook 因文件名没有课程代码被跳过：</div>`);
      lines.push(r.hb_skipped.map(u => `&nbsp;&nbsp;· ${esc(u)}`).join("<br>"));
    }
    if (r.unmatched.length) {
      lines.push(`<div class="warn">${r.unmatched.length} 份未识别出课程代码（已放入「未分类」）：</div>`);
      lines.push(r.unmatched.map(u => `&nbsp;&nbsp;· ${esc(u.file)}`).join("<br>"));
    }
    if (r.skipped_note) lines.push(`<div class="muted">${esc(r.skipped_note)}</div>`);
    if (!r.matched.length && !r.unmatched.length) lines.push(`<div class="warn">压缩包里没有找到 PDF 文件</div>`);
    report.innerHTML = lines.join("");
    toast("批量导入完成");
  } catch (err) {
    report.innerHTML = `<div class="warn">导入失败：${esc(err.message)}</div>`;
  }
}

// ---------- 回收区 ----------
// 勾选状态统一在 core.js 的 courseState 里初始化，这里不再做二次赋值

function updateRecycleBtn() {
  const n = courseState.recycleSelected.size;
  const rs = $("#btn-recycle-restore"), del = $("#btn-recycle-del");
  rs.classList.remove("hidden"); del.classList.remove("hidden");
  rs.disabled = n === 0; rs.textContent = n ? `恢复（${n}）` : "恢复";
  del.disabled = n === 0; del.textContent = n ? `删除（${n}）` : "删除";
}

$("#btn-recycle").onclick = guard("打开回收区", async () => {
  showView("recycle");
  const items = await api("/api/recycle");
  courseState.recycleSelected = new Set();
  const box = $("#recycle-list");
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = `<div class="material-empty">回收区是空的</div>`;
    $("#btn-recycle-restore").classList.add("hidden");
    $("#btn-recycle-del").classList.add("hidden");
    return;
  }
  for (const m of items) {
    const row = document.createElement("div");
    row.className = "material-row";
    row.innerHTML = `
      <input type="checkbox" class="m-check" data-id="${m.id}">
      <span class="badge">${esc(m.course_code)}</span>
      <span class="m-name">${esc(m.orig_name)}</span>
      <span class="m-meta">删除于 ${fmtDate(m.deleted_at)}</span>`;
    row.querySelector(".m-check").onchange = (e) => {
      e.target.checked ? courseState.recycleSelected.add(m.id) : courseState.recycleSelected.delete(m.id);
      updateRecycleBtn();
    };
    box.appendChild(row);
  }
  updateRecycleBtn();
});

$("#recycle-sel-all").addEventListener("change", (e) => {
  const boxes = [...document.querySelectorAll("#recycle-list .m-check")];
  boxes.forEach(b => { b.checked = e.target.checked; });
  e.target.checked ? boxes.forEach(b => courseState.recycleSelected.add(b.dataset.id))
                   : courseState.recycleSelected.clear();
  updateRecycleBtn();
});

$("#btn-recycle-restore").onclick = async () => {
  const ids = [...courseState.recycleSelected];
  if (!ids.length) return;
  for (const id of ids) {
    await api(`/api/materials/${id}/restore`, { method: "POST" });
  }
  toast(`已恢复 ${ids.length} 份资料`);
  $("#btn-recycle").click();
};
$("#btn-recycle-del").onclick = async () => {
  const ids = [...courseState.recycleSelected];
  if (!ids.length) return;
  if (!confirm(`彻底删除选中的 ${ids.length} 份资料？此操作不可恢复！`)) return;
  for (const id of ids) {
    await api(`/api/materials/${id}/purge`, { method: "POST" });
  }
  toast(`已彻底删除 ${ids.length} 份资料`);
  courseState.recycleSelected.clear();
  $("#btn-recycle").click();
};
$("#btn-back-recycle").onclick = () => {
  courseState.currentId ? openCourse(courseState.currentId) : showHome();
};

// ---------- 阅读器两侧栏：左目录 / 右笔记（都可折叠，状态记本地） ----------
// 笔记的读写逻辑在 core.js，与沉浸模式共用
const PV_COLS_KEY = "sls-pv-cols-v2";   // key 带 v2：默认改成「只开笔记」（目录收起）
function pvColEl(which) { return which === "toc" ? $("#pv-toc-col") : $("#pv-note"); }
function pvSyncColBtns() {
  const tocOn = !$("#pv-toc-col").classList.contains("collapsed");
  const noteOn = !$("#pv-note").classList.contains("collapsed");
  $("#pv-toc-toggle").textContent = tocOn ? "收起目录" : "显示目录";
  $("#pv-note-toggle").textContent = noteOn ? "收起笔记" : "显示笔记";
}
function pvToggleCol(which) {
  pvColEl(which).classList.toggle("collapsed");
  const on = ["toc", "note"].filter(k => !pvColEl(k).classList.contains("collapsed"));
  storage.set(PV_COLS_KEY, on.join(","));
  pvSyncColBtns();
  // 栏宽变了，适应宽度的 PDF 要按新宽度重排（等过渡动画走完再渲染）
  if (pv.doc && pv.fitWidth) setTimeout(() => renderPage(), 220);
}
function initViewerNote() {
  const on = (storage.get(PV_COLS_KEY) || "note").split(",");   // 默认收起目录，只开笔记
  $("#pv-toc-col").classList.toggle("collapsed", !on.includes("toc"));
  $("#pv-note").classList.toggle("collapsed", !on.includes("note"));
  pvSyncColBtns();
  $("#pv-toc-toggle").onclick = guard("切换目录栏", () => pvToggleCol("toc"));
  $("#pv-note-toggle").onclick = guard("切换笔记栏", () => pvToggleCol("note"));
  $("#pv-toc-hide").onclick = guard("收起目录栏", () => pvToggleCol("toc"));
  $("#pv-note-hide").onclick = guard("收起笔记栏", () => pvToggleCol("note"));
}

// ---------- PDF 阅读器 ----------
pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.js";
const pv = {
  doc: null, page: 1, scale: 1.2, fitWidth: true, renderTask: null, materialId: null,
};

function unitLabel(ext, n) {
  return (ext === "docx" ? `第${n}段` : `第${n}页`);
}

function pvSetDocxMode(on) {
  $("#pv-canvas").classList.toggle("hidden", on);
  $("#pv-html").classList.toggle("hidden", !on);
  $("#pv-ink-stage").classList.toggle("hidden", on);
  $("#pv-ink-bar").classList.toggle("hidden", on);   // Word 文档不支持圈画
  ["#pv-prev", "#pv-next", "#pv-zoom-in", "#pv-zoom-out", "#pv-fit"].forEach(s => $(s).disabled = on);
  $("#pv-page-input").disabled = on;
}

async function openViewer(materialId, page = 0, name = "", ext = "") {   // page=0 表示"接着上次读"
  if (!ext) {
    const m = materialState.list.find(x => x.id === materialId);
    ext = (m && m.ext) || "pdf";
  }
  // PDF 走统一的三栏阅读界面（原「阅读」与「沉浸」已合并成一套，见 openImmersive）
  // docx 仍走下面 #pdf-viewer 这套：沉浸界面只支持 PDF，所以旧代码保留
  if (ext !== "docx") {
    return openImmersive({ id: materialId, orig_name: name || "阅读中…", ext }, page);
  }
  const isDocx = ext === "docx";
  $("#pv-title").textContent = name || "阅读中…";
  $("#pdf-viewer").classList.remove("hidden");
  $("#pv-loading").classList.remove("hidden");
  $("#pv-loading").textContent = "加载中…";
  pv.materialId = materialId;
  loadNoteInto(materialId, $("#pv-note-edit"), $("#pv-note-status"));   // 左侧笔记跟着换
  try {
    if (isDocx) {
      pvSetDocxMode(true);
      pv.doc = null;
      $("#pv-total").textContent = "-";
      const res = await fetch(`/api/materials/${materialId}/docx-html`);
      if (!res.ok) throw new Error("无法加载 Word 文档");
      const data = await res.json();
      $("#pv-html").innerHTML = data.html || "<p>（空文档）</p>";
      $("#pv-loading").classList.add("hidden");
      $("#pv-scroll").scrollTop = 0;
      return;
    }
    pvSetDocxMode(false);
    if (!pv.doc || pv.doc._materialId !== materialId) {
      const res = await fetch(`/api/materials/${materialId}/pdf`);
      if (!res.ok) throw new Error("无法加载 PDF");
      const data = await res.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data }).promise;
      doc._materialId = materialId;
      pv.doc = doc;
    }
    $("#pv-total").textContent = pv.doc.numPages;
    if (!page) page = (await loadProgress(materialId)) || 1;   // 续读记忆
    pv.page = Math.min(Math.max(1, page), pv.doc.numPages);
    $("#pv-page-input").value = pv.page;
    $("#pv-loading").classList.add("hidden");
    inkAttach("#pv-ink-stage", materialId, $("#pv-ink-status"), () => pv.page);
    loadOutline(materialId).then(items => {      // 目录（内嵌书签）：后台加载，不阻塞首屏
      renderOutline($("#pv-toc-list"), items, pv.page, (page) => { if (page) pvGoto(page); });
    });
    await renderPage();
    await inkGotoPage(pv.page);                       // 圈画跟着页走
  } catch (err) {
    $("#pv-loading").textContent = `加载失败：${err.message}`;
    setTimeout(() => closeViewer(), 2500);
  }
}

function closeViewer() {
  flushNote();                                   // 未保存的笔记立即落盘
  inkFlush();
  $("#pdf-viewer").classList.add("hidden");
  if (pv.renderTask) { try { pv.renderTask.cancel(); } catch {} pv.renderTask = null; }
  pv.doc = null;
}

async function renderPage() {
  if (!pv.doc) return;
  const page = await pv.doc.getPage(pv.page);
  const scroll = $("#pv-scroll");
  if (pv.fitWidth) {
    pv.scale = (scroll.clientWidth - 36) / page.getViewport({ scale: 1 }).width;
    pv.scale = Math.max(0.3, Math.min(pv.scale, 3));
  }
  const viewport = page.getViewport({ scale: pv.scale });
  const canvas = $("#pv-canvas");
  canvas.width = viewport.width * devicePixelRatio;
  canvas.height = viewport.height * devicePixelRatio;
  canvas.style.width = viewport.width + "px";
  canvas.style.height = viewport.height + "px";
  if (pv.renderTask) { try { pv.renderTask.cancel(); } catch {} }
  const ctx = canvas.getContext("2d");
  pv.renderTask = page.render({ canvasContext: ctx, viewport, transform: [devicePixelRatio, 0, 0, devicePixelRatio, 0, 0] });
  try { await pv.renderTask.promise; } catch (e) { /* 渲染被取消属正常 */ }
  scroll.scrollTop = 0;
  inkAfterRender();                              // 尺寸变了，标注层跟着对齐重绘
  renderTextLayer(page, viewport);              // 文本层：让位图上的文字可选中复制
  markOutline($("#pv-toc-list"), pv.page);      // 目录高亮跟着翻页走
  saveProgress(pv.materialId, pv.page);          // 记住读到哪一页
}

async function pvGoto(p) {
  if (!pv.doc) return;
  pv.page = Math.min(Math.max(1, p), pv.doc.numPages);
  $("#pv-page-input").value = pv.page;
  await renderPage();
  await inkGotoPage(pv.page);
}
$("#pv-prev").onclick = () => pvGoto(pv.page - 1);
$("#pv-next").onclick = () => pvGoto(pv.page + 1);
$("#pv-page-input").onchange = (e) => pvGoto(Number(e.target.value) || 1);
$("#pv-zoom-in").onclick = () => { pv.fitWidth = false; pv.scale = Math.min(pv.scale * 1.2, 4); renderPage(); };
$("#pv-zoom-out").onclick = () => { pv.fitWidth = false; pv.scale = Math.max(pv.scale / 1.2, 0.3); renderPage(); };
$("#pv-fit").onclick = () => { pv.fitWidth = true; renderPage(); };
// 触控板捏合缩放：浏览器把双指捏合映射成 ctrl+wheel；普通滚轮不拦截，保持原生滚动
let pvZoomTimer = null;
$("#pv-scroll").addEventListener("wheel", (e) => {
  if (!e.ctrlKey || !pv.doc) return;
  e.preventDefault();
  pv.fitWidth = false;
  pv.scale = Math.max(0.3, Math.min(pv.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 4));
  clearTimeout(pvZoomTimer);                    // 防抖：捏合会连续触发大量 wheel
  pvZoomTimer = setTimeout(() => { renderPage(); }, 70);
}, { passive: false });
$("#pv-close").onclick = closeViewer;
initViewerNote();
// 键盘：注册到全局分发器（同一按键只会被处理一次）
onGlobalKey(({ key, typing }) => {
  if ($("#pdf-viewer").classList.contains("hidden")) return false;
  if (key === "Escape") { closeViewer(); return true; }
  if (typing) return false;                      // 输入框里不拦截任何键：返回 false 才不会 preventDefault
  if (key === "ArrowLeft" || key === "PageUp") { pvGoto(pv.page - 1); return true; }
  if (key === "ArrowRight" || key === "PageDown") { pvGoto(pv.page + 1); return true; }
  return false;
});
// 窗口尺寸变化时若为适应宽度模式则重渲染
window.addEventListener("resize", () => { if (pv.doc && pv.fitWidth && !$("#pdf-viewer").classList.contains("hidden")) renderPage(); });
