/* 工具域视图：均分计算 / HandBook / 待办 / 沉浸模式 / 资料总库 */
// ---------- 均分计算 ----------
const gradeEdit = new Set();  // 处于编辑状态的专业课 id

$("#btn-grades").onclick = guard("打开均分计算", () => { courseState.currentId = null; showView("grade"); renderGrades(); });
$("#btn-back-grade").onclick = () => showHome();

function totalOf(list) {
  let w = 0, s = 0, any = false;
  for (const it of list) {
    const sc = Number(it.score), wt = Number(it.weight) || 0;
    if (it.score !== "" && it.score !== null && it.score !== undefined && !isNaN(sc)) {
      any = true; w += wt; s += wt * sc;
    }
  }
  return any ? (w ? s / w : null) : null;
}

function refreshOverall() {
  let sw = 0, ss = 0, cnt = 0;
  document.querySelectorAll(".grade-card").forEach(el => {
    const cr = Number(el.dataset.credits) || 0;
    const tt = el.dataset.total;
    if (cr > 0 && tt !== "") { sw += cr; ss += cr * Number(tt); cnt++; }
  });
  $("#overall-score").textContent = sw ? (ss / sw).toFixed(2) : "-";
  $("#overall-note").textContent = sw ? `已计入 ${cnt} 门课，总学分 ${sw}` : "录入分数和学分后自动计算";
}

async function renderGrades() {
  const box = $("#grade-list");
  box.innerHTML = `<div class="material-empty">加载中…</div>`;
  const majors = courseState.list.filter(c => c.code !== "UNFILED" && (c.course_group || "major") === "major");
  box.innerHTML = "";
  if (!majors.length) {
    box.innerHTML = `<div class="material-empty">还没有专业课。先在课程编辑里把分组设为专业课并填写学分</div>`;
    return;
  }
  for (const c of majors) {
    const comps = await api(`/api/courses/${c.id}/assessments`);
    box.appendChild(gradeCard(c, comps));
  }
  refreshOverall();
}

function gradeCard(c, comps) {
  const editing = gradeEdit.has(c.id);
  const card = document.createElement("div");
  card.className = "panel grade-card";
  card.innerHTML = `
    <div class="grade-head">
      <div class="grade-title">
        <b>${esc(c.code)}</b> <span class="muted">${esc(c.name || "")}</span>
        <label class="credit-label">学分
          ${editing
            ? `<input type="number" class="input input-sm g-credits" min="0" step="2.5" value="${c.credits || ""}" placeholder="0">`
            : `<b>${c.credits || 0}</b>`}
        </label>
      </div>
      <div class="grade-tools">
        <span class="g-total"></span>
        ${editing
          ? `<button class="btn btn-primary btn-sm g-save">保存</button>
             <button class="btn btn-ghost btn-sm g-cancel">取消</button>`
          : `<button class="btn btn-outline btn-sm g-edit">编辑</button>`}
      </div>
    </div>
    <div class="grade-note muted">${editing
      ? "编辑中：修改学分、权重、得分后点「保存」才生效"
      : "HandBook 在课程页的「HandBook」标签页上传扫描；点「编辑」修改内容。"}</div>
    <table class="grade-table">
      <thead><tr><th>考核构成</th><th>权重 %</th><th>得分</th><th>小计</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
    ${editing ? `<button class="btn btn-ghost btn-sm g-add">＋ 添加考核项</button>` : ""}`;
  const tbody = card.querySelector("tbody");

  function readItems() {
    return [...tbody.querySelectorAll("tr")].map(tr => ({
      name: tr.querySelector(".c-name").value,
      weight: tr.querySelector(".c-weight").value,
      score: tr.querySelector(".c-score").value,
    }));
  }

  function refreshCard() {
    // 小计列
    [...tbody.querySelectorAll("tr")].forEach(tr => {
      const sc = tr.querySelector(".c-score").value;
      const w = Number(tr.querySelector(".c-weight").value) || 0;
      const n = Number(sc);
      tr.querySelector(".c-sub").textContent = (sc !== "" && !isNaN(n)) ? (n * w / 100).toFixed(1) : "";
    });
    const t = totalOf(readItems());
    card.querySelector(".g-total").innerHTML = t == null
      ? `<span class="muted">待录入分数</span>` : `课程总分：<b>${t.toFixed(1)}</b>`;
    card.dataset.total = t == null ? "" : t;
    card.dataset.credits = Number(card.querySelector(".g-credits").value) || 0;
    refreshOverall();
  }

  if (!editing) {
    // 常态：纯展示，不可编辑
    card.dataset.credits = c.credits || 0;
    const t = totalOf(comps);
    for (const it of comps) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(it.name)}</td>
        <td>${it.weight}%</td>
        <td>${it.score == null ? `<span class="muted">未出分</span>` : it.score}</td>
        <td class="c-sub">${it.score == null ? "" : (it.score * it.weight / 100).toFixed(1)}</td>
        <td></td>`;
      tbody.appendChild(tr);
    }
    if (!comps.length) tbody.innerHTML = `<tr><td colspan="5" class="muted">暂无考核项：点「编辑」手工添加，或在课程页上传 HandBook 扫描</td></tr>`;
    card.querySelector(".g-total").innerHTML = t == null
      ? `<span class="muted">待录入分数</span>` : `课程总分：<b>${t.toFixed(1)}</b>`;
    card.dataset.total = t == null ? "" : t;
    card.querySelector(".g-edit").onclick = () => { gradeEdit.add(c.id); renderGrades(); };
  } else {
    const mkRow = (it = { name: "", weight: "", score: "" }) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input class="input input-sm c-name" value="${esc(it.name)}" placeholder="如 Coursework 1"></td>
        <td><input class="input input-sm c-weight" type="number" min="0" max="100" step="1" value="${it.weight}"></td>
        <td><input class="input input-sm c-score" type="number" min="0" max="100" step="0.5" value="${it.score ?? ""}" placeholder="未出分"></td>
        <td class="c-sub muted"></td>
        <td><button class="btn btn-danger btn-sm c-del">删除</button></td>`;
      tr.querySelector(".c-del").onclick = () => { tr.remove(); refreshCard(); };
      tr.querySelectorAll("input").forEach(inp => inp.addEventListener("input", refreshCard));
      return tr;
    };
    (comps.length ? comps : [{ name: "", weight: "", score: "" }]).forEach(it => tbody.appendChild(mkRow(it)));
    card.querySelector(".g-add").onclick = () => { tbody.appendChild(mkRow()); refreshCard(); };
    card.querySelector(".g-cancel").onclick = () => { gradeEdit.delete(c.id); renderGrades(); };
    card.querySelector(".g-save").onclick = async () => {
      const items = readItems().map(it => ({
        name: (it.name || "").trim() || "未命名",
        weight: Number(it.weight) || 0,
        score: it.score === "" ? null : Number(it.score),
      }));
      const cr = Number(card.querySelector(".g-credits").value) || 0;
      try {
        await api(`/api/courses/${c.id}/assessments`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items }),
        });
        c.credits = cr;
        await api(`/api/courses/${c.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credits: cr }),
        });
        toast("已保存");
        gradeEdit.delete(c.id);
        await renderGrades();
      } catch (e) {
        toast(`保存失败：${e.message}`);
      }
    };
  }
  return card;
}

// ---------- 课程页 HandBook ----------
async function renderHandbook() {
  if (!courseState.currentId) return;
  const info = await api(`/api/courses/${courseState.currentId}/handbook/info`);
  $("#hb-read").classList.toggle("hidden", !info.has);
  const comps = await api(`/api/courses/${courseState.currentId}/assessments`);
  const editing = !!courseState.hbEdit;
  $("#hb-rescan").classList.toggle("hidden", !info.has || editing);   // 有手册且不在编辑态才给重扫
  $("#btn-hb-edit").classList.toggle("hidden", editing);
  $("#btn-hb-save").classList.toggle("hidden", !editing);
  $("#btn-hb-cancel").classList.toggle("hidden", !editing);
  $("#hb-add").classList.toggle("hidden", !editing);
  $("#hb-note").textContent = editing
    ? "编辑中：修改后点「保存」才生效"
    : (info.has
      ? "HandBook 是学习指引：可随时点「阅读手册」查看原文；重新上传会重新扫描并覆盖考核构成（分数留空）。"
      : "HandBook 是学习指引：上传后 AI 扫描考核构成作预填，帮你理清这门课要做什么、各占多少分。");
  const tbody = $("#hb-tbody");
  tbody.innerHTML = "";



  if (!editing) {
    for (const it of comps) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(it.name)}</td>
        <td>${it.weight}%</td>
        <td>${it.score == null ? `<span class="muted">未出分</span>` : it.score}</td>
        <td class="c-sub">${it.score == null ? "" : (it.score * it.weight / 100).toFixed(1)}</td>
        <td></td>`;
      tbody.appendChild(tr);
    }
    if (!comps.length) tbody.innerHTML = `<tr><td colspan="5" class="muted">暂无考核项：点「编辑」手工添加，或上传 HandBook 扫描</td></tr>`;
    return;
  }

  const mkRow = (it = { name: "", weight: "", score: "" }) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input class="input input-sm c-name" value="${esc(it.name)}" placeholder="如 Coursework 1"></td>
      <td><input class="input input-sm c-weight" type="number" min="0" max="100" step="1" value="${it.weight}"></td>
      <td><input class="input input-sm c-score" type="number" min="0" max="100" step="0.5" value="${it.score ?? ""}" placeholder="未出分"></td>
      <td class="c-sub muted"></td>
      <td><button class="btn btn-danger btn-sm c-del">删除</button></td>`;
    const upd = () => {
      const sc = Number(tr.querySelector(".c-score").value);
      const w = Number(tr.querySelector(".c-weight").value) || 0;
      const has = tr.querySelector(".c-score").value !== "";
      tr.querySelector(".c-sub").textContent = (has && !isNaN(sc)) ? (sc * w / 100).toFixed(1) : "";
    };
    tr.querySelectorAll("input").forEach(inp => inp.addEventListener("input", upd));
    tr.querySelector(".c-del").onclick = () => tr.remove();
    return tr;
  };
  (comps.length ? comps : [{ name: "", weight: "", score: "" }]).forEach(it => tbody.appendChild(mkRow(it)));
  $("#hb-add").onclick = () => tbody.appendChild(mkRow());
}

$("#btn-hb-edit").onclick = () => { courseState.hbEdit = true; renderHandbook(); };

// 重新扫描：对已上传的 HandBook 重跑 AI 扫描（考核构成 + DDL → 待办），不必重新上传。
// DDL 待办按「名称+日期」去重，重复点这个按钮不会刷出重复待办。
$("#hb-rescan").onclick = guard("重新扫描 HandBook", async () => {
  if (!courseState.currentId) return;
  const btn = $("#hb-rescan");
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "扫描中…";
  try {
    const r = await api(`/api/courses/${courseState.currentId}/handbook/scan`, { method: "POST" });
    const parts = [`考核 ${r.components.length} 项`];
    parts.push(r.added_todos ? `新增待办 ${r.added_todos} 条` : "待办无新增");
    toast(`扫描完成：${parts.join("，")}${r.note ? "。" + r.note : ""}`);
    renderHandbook();
  } catch (e) {
    toast("扫描失败：" + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
});
$("#btn-hb-cancel").onclick = () => { courseState.hbEdit = false; renderHandbook(); };
$("#btn-hb-save").onclick = async () => {
  const items = [...document.querySelectorAll("#hb-tbody tr")].map(tr => ({
    name: (tr.querySelector(".c-name").value || "").trim() || "未命名",
    weight: Number(tr.querySelector(".c-weight").value) || 0,
    score: tr.querySelector(".c-score").value === "" ? null : Number(tr.querySelector(".c-score").value),
  }));
  try {
    await api(`/api/courses/${courseState.currentId}/assessments`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    toast("已保存");
    courseState.hbEdit = false;
    renderHandbook();
  } catch (e) {
    toast(`保存失败：${e.message}`);
  }
};

$("#hb-upload-btn").onclick = () => $("#hb-file").click();
$("#hb-file").addEventListener("change", async () => {
  const f = $("#hb-file").files[0]; $("#hb-file").value = "";
  if (!f || !courseState.currentId) return;
  const note = $("#hb-note");
  note.textContent = `正在扫描「${f.name}」…（约 10-30 秒）`;
  const fd = new FormData();
  fd.append("file", f);
  try {
    const r = await api(`/api/courses/${courseState.currentId}/handbook`, { method: "POST", body: fd });
    note.textContent = r.note || (r.components.length ? `扫描到 ${r.components.length} 个考核项，已预填（分数需自己录入）` : "未扫描到考核构成，请手工添加");
    if (r.note) toast(r.note, 4000);
    courseState.hbEdit = false;
    renderHandbook();
  } catch (err) {
    note.textContent = `扫描失败：${err.message}`;
  }
});

$("#hb-read").onclick = async () => {
  const info = await api(`/api/courses/${courseState.currentId}/handbook/info`);
  if (!info.has) return toast("还未上传 HandBook");
  if (info.ext === "docx") {
    pvSetDocxMode(true);
    $("#pdf-viewer").classList.remove("hidden");
    $("#pv-loading").classList.remove("hidden");
    $("#pv-loading").textContent = "加载中…";
    $("#pv-title").textContent = "HandBook";
    pv.doc = null;
    try {
      const r = await api(`/api/courses/${courseState.currentId}/handbook/html`);
      $("#pv-html").innerHTML = r.html || "<p>（空文档）</p>";
      $("#pv-loading").classList.add("hidden");
      $("#pv-scroll").scrollTop = 0;
    } catch (err) { $("#pv-loading").textContent = `加载失败：${err.message}`; }
  } else {
    $("#pdf-viewer").classList.remove("hidden");
    $("#pv-loading").classList.remove("hidden");
    $("#pv-loading").textContent = "加载中…";
    $("#pv-title").textContent = "HandBook";
    pvSetDocxMode(false);
    try {
      pv.doc = await pdfjsLib.getDocument({ url: `/api/courses/${courseState.currentId}/handbook/file` }).promise;
      pv.doc._materialId = "handbook_" + courseState.currentId;
      $("#pv-total").textContent = pv.doc.numPages;
      pv.page = 1; $("#pv-page-input").value = 1;
      $("#pv-loading").classList.add("hidden");
      renderPage();
    } catch (err) { $("#pv-loading").textContent = `加载失败：${err.message}`; }
  }
};

// ---------- 待办事项 ----------
$("#btn-todos").onclick = guard("打开待办事项", () => { courseState.currentId = null; showView("todo"); loadTodos(); });
$("#btn-back-todo").onclick = () => showHome();

async function loadTodos() {
  const todos = await api("/api/todos");
  const box = $("#todo-list");
  box.innerHTML = "";
  if (!todos.length) { box.innerHTML = `<div class="material-empty">还没有待办，添加一条吧</div>`; return; }
  const now = Date.now();
  const manual = todoSortMode() === "manual";
  const sortBtn = $("#todo-sort");
  if (sortBtn) sortBtn.textContent = manual ? "排序：手动" : "排序：按 DDL";
  fillTodoCourseSelect($("#todo-course"));
  for (const td of todoOrder(todos)) {
    const row = document.createElement("div");
    row.className = "todo-row" + (td.done ? " todo-done" : "");
    row.dataset.sortId = td.id;
    row.title = manual ? "可拖动调整顺序" : "当前按 DDL 排序；切到「手动」后可拖动";
    row.innerHTML = todoRowHtml(td, now, manual);
    row.querySelector(".todo-check").onchange = async (e) => {
      await api(`/api/todos/${td.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: e.target.checked }) });
      loadTodos();
    };
    row.querySelector(".todo-del").onclick = async () => {
      await api(`/api/todos/${td.id}`, { method: "DELETE" });
      loadTodos();
    };
    box.appendChild(row);
  }
  if (manual) {
    makeSortable(box, (ids) => {
      api("/api/todos/reorder", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      }).catch(() => toast("排序保存失败"));
    });
  }
}

$("#todo-sort").onclick = () => {
  todoSetSortMode(todoSortMode() === "due" ? "manual" : "due");
  loadTodos();
};

$("#todo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const content = $("#todo-input").value.trim();
  if (!content) return toast("事项内容不能为空");
  await api("/api/todos", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      due: $("#todo-due").value,
      course_id: $("#todo-course").value,
    }) });
  $("#todo-input").value = ""; $("#todo-due").value = ""; $("#todo-course").value = "";
  loadTodos();
});



// ---------- 沉浸模式（上课专用） ----------
// 注释支持多语言：各语言分别生成、分开存储，切换语言不会覆盖别的语言版本。
const NOTE_LANG_KEY = "sls-note-lang";
const NOTE_LANG_LABEL = { zh: "中文", en: "英文", es: "西班牙语" };
function immLangPref() {
  const v = storage.get(NOTE_LANG_KEY) || "zh";
  return NOTE_LANG_LABEL[v] ? v : "zh";
}

const imm = { mid: null, courseId: null, doc: null, page: 1, total: 0,
              notes: {}, status: null, poll: null, editing: false,
              lang: "zh", scale: 1, fitWidth: true };

async function openImmersive(m, startPage = 0) {   // startPage=0 表示接着上次读
  Object.assign(imm, { mid: m.id, courseId: m.course_id, doc: null, page: startPage,
                       total: 0, notes: {}, status: null, editing: false,
                       lang: immLangPref(),
                       scale: 1, fitWidth: true });   // 每份资料默认「适应宽度」
  $("#imm-note-lang").value = imm.lang;
  $("#imm-title").textContent = m.orig_name;
  $("#imm-progress").textContent = "";
  immApplyCols();                                    // 恢复上次的栏折叠状态
  $("#imm-total").textContent = "";
  $("#immersive").classList.remove("hidden");
  $("#imm-note").innerHTML = `<span class="muted">加载中…</span>`;
  loadNoteInto(m.id, $("#imm-note-body"), $("#imm-note-status"));   // 我的笔记（与阅读器同一份）
  try {
    const res = await fetch(`/api/materials/${m.id}/pdf`);
    const data = await res.arrayBuffer();
    imm.doc = await pdfjsLib.getDocument({ data }).promise;
    imm.total = imm.doc.numPages;
    $("#imm-total").textContent = `/ ${imm.total}`;
    if (!imm.page) imm.page = (await loadProgress(m.id)) || 1;   // 续读记忆
    imm.page = Math.min(Math.max(1, imm.page), imm.total);
    $("#imm-page-input").value = imm.page;
    inkAttach("#imm-ink-stage", m.id, $("#imm-ink-status"), () => imm.page);
    // 目录（内嵌书签）：后台加载，不阻塞首屏渲染
    loadOutline(m.id).then(items => {
      renderOutline($("#imm-toc-list"), items, imm.page, (page) => { if (page) immGo(page); });
    });
    await renderImmPage();
    await inkGotoPage(imm.page);
  } catch (err) {
    $("#imm-note").innerHTML = `<span class="muted">课件加载失败：${esc(err.message)}</span>`;
    return;
  }
  await refreshImmNotes();
  // 打开界面**不**自动生成注释（原先每次打开都会触发全量补齐，白耗 API 额度）。
  // 但如果别处正在跑（比如列表页点了「注释」），就跟着轮询把进度刷出来。
  if (imm.status && imm.status.running) startImmPoll();
}

function startImmPoll() {
  stopImmPoll();
  imm.poll = setInterval(async () => {
    const st = await refreshImmNotes();
    if (st && !st.running && Object.keys(imm.notes).length >= (st.total || 0)) stopImmPoll();
  }, 2500);
}
function stopImmPoll() {
  if (imm.poll) { clearInterval(imm.poll); imm.poll = null; }
}
function closeImmersive() {
  stopImmPoll();
  flushNote();                                   // 未保存的笔记立即落盘
  inkFlush();
  $("#immersive").classList.add("hidden");
  imm.doc = null;
}
$("#imm-close").onclick = closeImmersive;

// 右栏页签：本页注释 / 我的笔记（目录已独立到左侧栏）
function immShowPane(which) {
  for (const k of ["ai", "mine"]) {              // 页签与面板同源，以后加页签只改这一处
    $(`#imm-tab-${k}`).classList.toggle("active", which === k);
    $(`#imm-pane-${k}`).classList.toggle("hidden", which !== k);
  }
}
$("#imm-tab-ai").onclick = guard("看本页注释", () => immShowPane("ai"));
$("#imm-tab-mine").onclick = guard("看我的笔记", () => immShowPane("mine"));
// 界面内只补**当前页**：全量补齐交给列表页的「注释」按钮 ——
// 同一件事做两个入口没有意义
$("#imm-note-gen").onclick = guard("生成本页注释", async () => {
  if (!imm.mid || !imm.page) return;
  const page = imm.page;
  const langLabel = NOTE_LANG_LABEL[imm.lang] || "中文";
  toast(`正在生成第 ${page} 页的${langLabel}注释…`);
  try {
    const r = await api(`/api/materials/${imm.mid}/notes/${page}/generate?lang=${imm.lang}`, { method: "POST" });
    imm.notes[page] = r.note;
    renderImmNote();
    toast(`第 ${page} 页${langLabel}注释已生成`);
  } catch (e) {
    toast("生成失败：" + (e.message || e));
  }
});

// 整份补齐：给当前语言的整份课件生成注释（西语/英文没有注释时一次补齐，
// 不必一页页点）。开销大，先确认。
$("#imm-note-gen-all").onclick = guard("生成整份注释", async () => {
  if (!imm.mid) return;
  const langLabel = NOTE_LANG_LABEL[imm.lang] || "中文";
  const have = Object.keys(imm.notes).length;
  const total = imm.total || 0;
  if (total && have >= total) return toast(`这一份的${langLabel}注释已经补全了`);
  const rest = total ? total - have : "若干";
  if (!confirm(`为这份课件补齐${langLabel}注释？\n\n还有约 ${rest} 页没有${langLabel}注释，`
    + `会消耗较多 API 额度，耗时几分钟。已有其他语言的注释不受影响。`)) return;
  try {
    const r = await api(`/api/materials/${imm.mid}/notes/generate?lang=${imm.lang}`, { method: "POST" });
    if (!r.started) return toast("已经在生成中，稍等");
    toast(`${langLabel}注释开始生成，进度显示在顶部`);
    await refreshImmNotes();
    startImmPoll();
  } catch (e) {
    toast("启动失败：" + (e.message || e));
  }
});

// ---------- 左目录栏 / 右注释栏 折叠（状态记在本地）----------
// key 带 v2：默认从「两栏都开」改成「只开笔记」，换 key 新默认才能对已用过的用户生效
const IMM_COLS_KEY = "sls-imm-cols-v2";
function immColEl(which) { return which === "toc" ? $("#imm-toc-col") : $("#imm-right-col"); }
function immApplyCols() {
  // 默认收起目录：它是「按需查」的东西，不占常驻宽度。用户手动展开过就按用户的记
  const on = (storage.get(IMM_COLS_KEY) || "notes").split(",");
  $("#imm-toc-col").classList.toggle("collapsed", !on.includes("toc"));
  $("#imm-right-col").classList.toggle("collapsed", !on.includes("notes"));
}
function immToggleCol(which) {
  immColEl(which).classList.toggle("collapsed");
  const on = ["toc", "notes"].filter(k => !immColEl(k).classList.contains("collapsed"));
  storage.set(IMM_COLS_KEY, on.join(","));
  // 栏宽变了，适应宽度的 PDF 要按新宽度重排（等过渡动画走完再渲染）
  if (imm.doc && imm.fitWidth) setTimeout(() => renderImmPage(), 220);
}
$("#imm-toggle-toc").onclick = guard("切换目录栏", () => immToggleCol("toc"));
$("#imm-toggle-notes").onclick = guard("切换注释栏", () => immToggleCol("notes"));
$("#imm-toc-hide").onclick = guard("收起目录栏", () => immToggleCol("toc"));
$("#imm-notes-hide").onclick = guard("收起右侧栏", () => immToggleCol("notes"));
// 键盘：注册到全局分发器（以前这里和阅读器各管一套，导致方向键一次跳两页）
onGlobalKey(({ key, typing }) => {
  if ($("#immersive").classList.contains("hidden")) return false;
  if (key === "Escape") { closeImmersive(); return true; }
  if (typing) return false;                    // 输入框里不拦截任何键：返回 false 才不会 preventDefault
  if (key === "ArrowLeft" || key === "PageUp") { immGo(imm.page - 1); return true; }
  if (key === "ArrowRight" || key === "PageDown") { immGo(imm.page + 1); return true; }
  return false;
});

async function refreshImmNotes() {
  try {
    const r = await api(`/api/materials/${imm.mid}/notes?lang=${imm.lang}`);
    imm.notes = {};
    for (const n of r.notes) imm.notes[n.page] = n;
    imm.status = r.status || { running: false };
  } catch (e) { imm.status = { running: false }; }
  updateImmProgress();
  renderImmNote();
  return imm.status;
}

// 切语言：只换显示哪一份，不会改动已生成的其他语言注释
$("#imm-note-lang").onchange = async (e) => {
  imm.lang = e.target.value;
  storage.set(NOTE_LANG_KEY, imm.lang);
  stopImmPoll();                       // 换语言后旧轮询的任务不再相关
  await refreshImmNotes();
  if (imm.status && imm.status.running) startImmPoll();
};

function updateImmProgress() {
  const st = imm.status || {};
  const el = $("#imm-progress");
  if (!st.total) {
    el.textContent = "";
    el.removeAttribute("title");
    return;
  }
  let txt = `注释 ${st.done || 0}/${st.total}`;
  if (st.running) txt += " 生成中…";
  else if (st.failed) txt += `（${st.failed} 页失败）`;
  else txt += " 已全部生成";
  el.textContent = txt;
  // 悬停看具体失败原因（服务端会记下最后一条）
  const why = st.last_error || st.error;
  if (why) el.title = why; else el.removeAttribute("title");
}

function renderImmNote() {
  const n = imm.notes[imm.page];
  const el = $("#imm-note");
  const langLabel = NOTE_LANG_LABEL[imm.lang] || "中文";
  if (n) {
    el.innerHTML = renderNote(n.content);
    $("#imm-note-edit").classList.remove("hidden");
  } else if (imm.status && imm.status.running) {
    el.innerHTML = `<span class="muted">本页${langLabel}注释生成中…（生成完自动显示）</span>`;
    $("#imm-note-edit").classList.add("hidden");
  } else {
    el.innerHTML = `<span class="muted">本页暂无${langLabel}注释（点上方「生成注释」）</span>`;
    $("#imm-note-edit").classList.add("hidden");
  }
  $("#imm-note-edit-wrap").classList.add("hidden");
}

function renderNote(text) {
  const lines = esc(text).split("\n");
  return lines.map(l => {
    let s = l.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    if (/^【.+】/.test(s)) return `<div class="note-h">${s}</div>`;
    if (/^\s*[•\-]\s/.test(s)) return `<div class="note-li">${s.replace(/^\s*[•\-]\s/, "• ")}</div>`;
    if (/^\s*\d+\.\s/.test(s)) return `<div class="note-li">${s}</div>`;
    return s ? `<div>${s}</div>` : "<div>&nbsp;</div>";
  }).join("");
}

let immRendering = false;
async function renderImmPage() {
  if (!imm.doc || immRendering) return;
  immRendering = true;
  try {
    const page = await imm.doc.getPage(imm.page);
    const wrap = $("#imm-canvas").closest(".imm-left");
    const base = page.getViewport({ scale: 1 });
    // fitWidth 时按窗口宽度算；手动缩放（触控板捏合 / ±按钮）时用 imm.scale
    if (imm.fitWidth) {
      imm.scale = Math.max(0.25, Math.min((wrap.clientWidth - 40) / base.width, 3));
    }
    const scale = Math.max(0.2, Math.min(imm.scale, 6));
    const viewport = page.getViewport({ scale });
    const canvas = $("#imm-canvas");
    // retina 屏必须按 devicePixelRatio 放大 canvas 内部尺寸，否则浏览器把低分辨率画布拉伸 → 模糊
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(viewport.width * dpr);
    canvas.height = Math.round(viewport.height * dpr);
    canvas.style.width = viewport.width + "px";
    canvas.style.height = viewport.height + "px";
    await page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;
    $("#imm-page-input").value = imm.page;
    inkAfterRender();                    // 尺寸变了，标注层跟着对齐重绘
    renderTextLayer(page, viewport);     // 文本层：让位图上的文字可选中复制
    markOutline($("#imm-toc-list"), imm.page);   // 目录高亮跟着翻页走
    saveProgress(imm.mid, imm.page);      // 进度统一存服务端，主页「继续上次」读它
    renderImmNote();
  } finally { immRendering = false; }
}

// ---------- 沉浸模式缩放：触控板捏合 / ±按钮 / 适应宽度 ----------
let immZoomTimer = null;
function immApplyZoom(factor) {
  if (!imm.doc) return;
  imm.fitWidth = false;                    // 从「适应宽度」切到手动缩放，以当前尺寸为基准
  imm.scale = Math.max(0.2, Math.min(imm.scale * factor, 6));
  clearTimeout(immZoomTimer);
  immZoomTimer = setTimeout(() => { renderImmPage(); }, 70);   // 防抖：捏合会连续触发
}
function immFitWidth() {
  imm.fitWidth = true;
  clearTimeout(immZoomTimer);
  immZoomTimer = setTimeout(() => { renderImmPage(); }, 30);
}
$("#imm-zoom-in").onclick = guard("放大", () => immApplyZoom(1.2));
$("#imm-zoom-out").onclick = guard("缩小", () => immApplyZoom(1 / 1.2));
$("#imm-fit").onclick = guard("适应宽度", immFitWidth);
// 触控板捏合：浏览器把双指捏合映射成 ctrl+wheel；普通滚轮保持原生滚动不受影响
document.querySelector(".imm-left").addEventListener("wheel", (e) => {
  if (!e.ctrlKey || !imm.doc) return;
  e.preventDefault();
  immApplyZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });

async function immGo(p) {
  if (!imm.doc) return;
  imm.page = Math.min(Math.max(1, p), imm.total);
  $("#imm-note").innerHTML = `<span class="muted">加载中…</span>`;
  await renderImmPage();
  await inkGotoPage(imm.page);
}
$("#imm-prev").onclick = () => immGo(imm.page - 1);
$("#imm-next").onclick = () => immGo(imm.page + 1);
$("#imm-page-input").addEventListener("change", (e) => immGo(Number(e.target.value) || 1));
window.addEventListener("resize", () => { if (!$("#immersive").classList.contains("hidden")) renderImmPage(); });

$("#imm-note-edit").onclick = () => {
  const n = imm.notes[imm.page];
  $("#imm-note-textarea").value = n ? n.content : "";
  $("#imm-note").classList.add("hidden");
  $("#imm-note-edit-wrap").classList.remove("hidden");
  $("#imm-note-edit").classList.add("hidden");
};
$("#imm-note-cancel").onclick = () => {
  $("#imm-note-edit-wrap").classList.add("hidden");
  $("#imm-note").classList.remove("hidden");
  $("#imm-note-edit").classList.toggle("hidden", !imm.notes[imm.page]);
};
$("#imm-note-save").onclick = async () => {
  const content = $("#imm-note-textarea").value.trim();
  if (!content) return toast("注释内容不能为空");
  await api(`/api/materials/${imm.mid}/notes/${imm.page}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, lang: imm.lang }),   // 只改当前语言这一份
  });
  toast("注释已保存（你的版本不会再被覆盖）");
  await refreshImmNotes();
};

// ---------- 资料总库 ----------
// 状态统一在 core.js 的 libraryState 里初始化，这里不再补字段

$("#btn-library").onclick = guard("打开资料总库", () => {
  courseState.currentId = null;
  showView("library");
  libraryState.tag = ""; libraryState.search = ""; libraryState.editMode = false; libraryState.selected.clear();
  $("#lib-search").value = "";
  $("#btn-lib-edit").textContent = "编辑";
  $("#btn-lib-edit").classList.remove("btn-primary"); $("#btn-lib-edit").classList.add("btn-outline");
  $("#btn-lib-export").classList.add("hidden");
  $("#btn-lib-del-selected").classList.add("hidden");
  $("#lib-sel-all-wrap").classList.add("hidden");
  document.querySelectorAll("#lib-tag-filter .chip").forEach(c => c.classList.toggle("active", c.dataset.tag === ""));
  renderLibrary();
});
$("#btn-back-library").onclick = () => showHome();

async function renderLibrary() {
  const qs = new URLSearchParams();
  if (libraryState.search) qs.set("q", libraryState.search);
  if (libraryState.tag) qs.set("tag", libraryState.tag);
  const items = await api(`/api/materials/all?${qs}`);
  const box = $("#library-list");
  box.innerHTML = "";
  if (!items.length) { box.innerHTML = `<div class="material-empty">没有符合条件的资料</div>`; updateLibBtns(); return; }
  for (const m of items) {
    box.appendChild(buildMaterialRow(m, {
      editable: libraryState.editMode,
      showCourse: true,
      selected: libraryState.selected,
      onToggle: updateLibBtns,
      onTagChange: () => {},   // 总库改标签后无需重渲染
    }));
  }
  updateLibBtns();
  refreshOrganizeBtns();
}

// AI 整理：给全库还没生成摘要的资料补跑一次入库分析
$("#btn-lib-ai-organize").onclick = guard("AI 整理", () => startOrganize(""));

function updateLibBtns() {
  const n = libraryState.selected.size;
  const ex = $("#btn-lib-export"), del = $("#btn-lib-del-selected");
  ex.disabled = n === 0; ex.textContent = n ? `导出（${n}）` : "导出";
  del.disabled = n === 0; del.textContent = n ? `删除（${n}）` : "删除";
}

$("#lib-tag-filter").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  libraryState.tag = chip.dataset.tag;
  document.querySelectorAll("#lib-tag-filter .chip").forEach(c => c.classList.toggle("active", c === chip));
  renderLibrary();
});
let libSearchTimer;
$("#lib-search").addEventListener("input", (e) => {
  clearTimeout(libSearchTimer);
  libSearchTimer = setTimeout(() => { libraryState.search = e.target.value; renderLibrary(); }, 250);
});
$("#btn-lib-edit").onclick = () => {
  libraryState.editMode = !libraryState.editMode;
  if (!libraryState.editMode) { libraryState.selected.clear(); $("#lib-sel-all").checked = false; }
  $("#btn-lib-edit").textContent = libraryState.editMode ? "退出编辑" : "编辑";
  $("#btn-lib-edit").classList.toggle("btn-primary", libraryState.editMode);
  $("#btn-lib-edit").classList.toggle("btn-outline", !libraryState.editMode);
  $("#btn-lib-export").classList.toggle("hidden", !libraryState.editMode);
  $("#btn-lib-del-selected").classList.toggle("hidden", !libraryState.editMode);
  $("#lib-sel-all-wrap").classList.toggle("hidden", !libraryState.editMode);
  renderLibrary();
};
$("#lib-sel-all").addEventListener("change", (e) => {
  const boxes = [...document.querySelectorAll("#library-list .m-check")];
  boxes.forEach(b => b.checked = e.target.checked);
  e.target.checked ? boxes.forEach(b => libraryState.selected.add(b.dataset.id)) : libraryState.selected.clear();
  updateLibBtns();
});
$("#btn-lib-export").onclick = async () => {
  const ids = [...libraryState.selected];
  if (!ids.length) return;
  if (hasNativeBridge()) {
    const ok = ids.length === 1 ? await nativeExportOne(ids[0]) : await nativeExport(ids);
    if (ok) return;
  }
  // 只选一份就直接下载原文件：比打包成 zip 快，文件名也能保留原样
  if (ids.length === 1) {
    const m = libraryState.list.find(x => x.id === ids[0]);
    const a = document.createElement("a");
    a.href = `/api/materials/${ids[0]}/download`;
    a.download = (m && m.orig_name) || "资料.pdf";
    a.click();
    return;
  }
  const res = await fetch("/api/materials/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
  if (!res.ok) return toast((await res.json()).detail || "导出失败");
  const blob = await res.blob();
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url; a.download = "资料导出.zip"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);   // 立即 revoke 会掐断还没读完的大文件
};
$("#btn-lib-del-selected").onclick = async () => {
  const ids = [...libraryState.selected];
  if (!ids.length) return;
  if (!confirm(`确定把选中的 ${ids.length} 份资料移入回收区吗？可在回收区恢复。`)) return;
  for (const id of ids) await api(`/api/materials/${id}/delete`, { method: "POST" });
  toast(`已把 ${ids.length} 份资料移入回收区`);
  libraryState.selected.clear();
  renderLibrary();
};
