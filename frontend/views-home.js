/* 主页域：主页仪表盘渲染 + 顶部入口（导航 / 品牌 / 快捷入口）绑定 */
function showHome() {
  courseState.currentId = null;
  showView("home");
  renderDashboard();
  renderQuote();          // 每次进主页换一句
}

async function renderDashboard() {
  try {
    if (!courseState.list.length) await loadCourses();
    const [mats, todos] = await Promise.all([api("/api/materials/all"), api("/api/todos")]);
    const courses = courseState.list.filter(c => c.code !== "UNFILED").length;
    $("#dash-courses").textContent = courses;
    $("#dash-materials").textContent = mats.length;
    $("#dash-annot").textContent = mats.filter(m => (m.notes_count || 0) > 0).length;
    $("#dash-todos").textContent = todos.filter(t => !t.done).length;
    const unf = courseState.list.find(c => c.code === "UNFILED");
    const unfN = unf ? unf.material_count : 0;
    const alert = $("#dash-unfiled");
    if (unfN > 0) {
      alert.classList.remove("hidden");
      alert.innerHTML = `未分类还有 <b>${unfN}</b> 份资料待整理 —— <a href="javascript:void(0)" id="dash-unfiled-go">去处理</a>`;
      const go = document.getElementById("dash-unfiled-go");
      if (go) go.onclick = () => openCourse(unf.id);
    } else {
      alert.classList.add("hidden");
    }
    $("#dash-sub").textContent = "欢迎回来，一切尽在掌握";
    renderHomeTodos(todos);
    // 继续上次阅读：进度存在服务端（换设备/清缓存也不会丢）
    const last = await api("/api/progress/latest");
    const cont = $("#dash-continue");
    if (last && last.material_id) {
      cont.classList.remove("hidden");
      cont.textContent = `继续上次：${last.orig_name} · 第 ${last.page} 页${last.course_code ? `（${last.course_code}）` : ""}`;
      cont.onclick = guard("继续上次阅读", () =>
        openViewer(last.material_id, last.page, last.orig_name, last.ext || "pdf"));
    } else {
      cont.classList.add("hidden");
    }
  } catch (e) {
    console.warn("[dashboard]", e);
    const sub = document.getElementById("dash-sub");
    if (sub) sub.textContent = "部分数据加载失败：" + (e.message || e);
  }
}
$("#dash-lib").onclick = () => document.getElementById("btn-library").click();
$("#dash-grades").onclick = () => document.getElementById("btn-grades").click();

$("#btn-overview").onclick = guard("打开主页", showHome);
$("#btn-import").onclick = guard("打开批量导入", () => { courseState.currentId = null; showView("import"); });
$("#brand-home").onclick = guard("打开主页", showHome);


// ---------- 主页下半区：待办大事框 ----------
// 叶子渲染函数：只读传入数据 + 写自己那块 DOM，不调用任何其他渲染函数
function renderHomeTodos(todos) {
  const list = todos.filter(t => !t.done);
  const done = todos.filter(t => t.done);
  const now = Date.now();
  // 顺带报一下 7 天内到期的条数 —— 首页一眼就能看出「最近有什么要交」
  const soon = list.filter(t => {
    if (!t.due) return false;
    const ms = new Date(t.due).getTime() - now;
    return ms >= 0 && ms <= 7 * 86400000;
  }).length;
  $("#home-todo-count").textContent = list.length
    ? `未完成 ${list.length} 项${soon ? ` · ${soon} 项 7 天内到期` : ""}${done.length ? ` · 已完成 ${done.length}` : ""}`
    : (done.length ? `已全部完成 · ${done.length} 项` : "");
  const box = $("#home-todo-list");
  box.innerHTML = "";
  if (!todos.length) {
    box.innerHTML = `<div class="material-empty">还没有待办。上面写一条，或在「全部管理」里批量整理</div>`;
    return;
  }
  const manual = todoSortMode() === "manual";
  const sortBtn = $("#home-todo-sort");
  if (sortBtn) sortBtn.textContent = manual ? "排序：手动" : "排序：按 DDL";
  fillTodoCourseSelect($("#home-todo-course"));
  // 顺序：默认按 DDL 升序（最紧的在最上），切到手动则完全按你拖出来的 ord
  for (const td of todoOrder(todos)) {
    const row = document.createElement("div");
    row.className = "todo-row" + (td.done ? " todo-done" : "");
    row.dataset.sortId = td.id;
    row.title = manual ? "可拖动调整顺序" : "当前按 DDL 排序；切到「手动」后可拖动";
    row.innerHTML = todoRowHtml(td, now, manual);
    row.querySelector(".todo-check").onchange = guard("勾选待办", async (e) => {
      await api(`/api/todos/${td.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: e.target.checked }) });
      renderDashboard();   // 改数据 → 回统一入口刷新（不与其他渲染函数互调）
    });
    row.querySelector(".todo-del").onclick = guard("删除待办", async () => {
      await api(`/api/todos/${td.id}`, { method: "DELETE" });
      renderDashboard();
    });
    box.appendChild(row);
  }
  // 拖完即存顺序（未完成与已完成一起提交，保持展示顺序一致）
  if (manual) {
    makeSortable(box, (ids) => {
      api("/api/todos/reorder", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      }).catch(() => toast("排序保存失败"));
    });
  }
}

$("#home-todo-sort").onclick = () => {
  todoSetSortMode(todoSortMode() === "due" ? "manual" : "due");
  renderDashboard();
};

$("#home-todo-form").addEventListener("submit", guard("添加待办", async (e) => {
  e.preventDefault();
  const content = $("#home-todo-input").value.trim();
  if (!content) return toast("事项内容不能为空");
  await api("/api/todos", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      due: $("#home-todo-due").value,
      course_id: $("#home-todo-course").value,
    }),
  });
  $("#home-todo-input").value = "";
  $("#home-todo-due").value = "";
  $("#home-todo-course").value = "";
  renderDashboard();
}));
$("#home-todo-go").onclick = guard("打开待办事项", () => document.getElementById("btn-todos").click());

// ---------- 主页下半区：每日一句 ----------
// 原创短句，不带署名（避免张冠李戴）；每次进主页换一句，且不与上一句重复
const QUOTES = [
  "今天多做的十分钟，会在考场上变成别人追不上的十分钟。",
  "你不必每天都赢，只要别停下。",
  "复习的意义，是把「好像懂了」变成「确实会了」。",
  "慢一点没关系，方向对就行。",
  "你现在的每一页笔记，都是将来坐到考场里时的底气。",
  "所谓运气，多半是准备到位的另一个名字。",
  "今天不想学是正常的；今天不学也只是一天，别把它变成一周。",
  "难题不是用来证明你不行的，是用来标出你该补的地方。",
  "把大目标拆成今天能做完的一件小事。",
  "你不是记不住，你只是还没复习够遍数。",
  "上课听懂是运气，课后自己会做才算数。",
  "每一次想放弃的瞬间，都是在把别人留下、把自己筛出去。",
  "计划可以慢，但不能没有。",
  "状态是等不来的。先坐下来，状态会自己跟上。",
  "别和别人比进度，和昨天的自己比。",
  "一次考试的分数，定义不了一个人的上限。",
  "你觉得枯燥的那部分，往往是最能拉开差距的部分。",
  "复习到第几遍不重要，能讲出来才重要。",
  "累了就休息，但别在休息的时候恨自己。",
  "把今天该做的做完，明天才有底气做想做的。",
  "你羡慕的那些人，只是把枯燥的事重复了很多遍。",
  "别怕起步晚，怕的是从来没开始。",
  "成绩是结果，习惯才是本金。",
  "与其焦虑考不考得好，不如现在把这一节看完。",
  "每一次认真，都会在某个你不知道的地方帮到你。",
  "你不是没有时间，你只是把时间分给了太多不重要的东西。",
  "学习不是拼时长，是拼「真的弄懂了」的那一刻。",
  "撑住，你已经走了很远了。",
];
let _lastQuote = -1;
function renderQuote() {
  let i = Math.floor(Math.random() * QUOTES.length);
  if (QUOTES.length > 1 && i === _lastQuote) i = (i + 1) % QUOTES.length;
  _lastQuote = i;
  $("#home-quote-text").textContent = QUOTES[i];
}
$("#home-quote-next").onclick = guard("换一句", renderQuote);

// ---------- 番茄钟（25 分钟专注 / 5 分钟休息） ----------
const POMO_FOCUS = 25 * 60;
const POMO_BREAK = 5 * 60;
const POMO_RING = 2 * Math.PI * 55;               // 与 SVG 里 r=55 对应
const pomo = { mode: "focus", left: POMO_FOCUS, running: false, timer: null };

function pomoTodayKey() {
  const d = new Date();
  return `pomo-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function pomoTotal() { return pomo.mode === "focus" ? POMO_FOCUS : POMO_BREAK; }

function renderPomo() {
  const m = Math.floor(pomo.left / 60), s = pomo.left % 60;
  $("#pomo-time").textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  $("#pomo-mode").textContent = pomo.mode === "focus" ? "专注" : "休息";
  $(".pomo").classList.toggle("pomo-break", pomo.mode === "break");
  const done = 1 - pomo.left / pomoTotal();
  $("#pomo-arc").setAttribute("stroke-dashoffset", String(POMO_RING * done));
  $("#pomo-start").textContent = pomo.running ? "暂停" : (pomo.left === pomoTotal() ? "开始" : "继续");
  const n = storage.get(pomoTodayKey()) || "0";
  $("#pomo-count").textContent = Number(n) > 0 ? `今日 ${n} 个` : "";
}

function pomoBeep() {
  try {                                             // 计时结束的提示音（WebAudio，无外部文件）
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880; gain.gain.value = 0.08;
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, 700);
  } catch (e) { /* 静音也行 */ }
}

function pomoFinish() {
  pomo.running = false;
  clearInterval(pomo.timer); pomo.timer = null;
  pomoBeep();
  if (pomo.mode === "focus") {
    const n = (Number(storage.get(pomoTodayKey())) || 0) + 1;
    storage.set(pomoTodayKey(), String(n));
    toast(`专注结束，完成第 ${n} 个番茄。休息 5 分钟`);
    pomo.mode = "break"; pomo.left = POMO_BREAK;
  } else {
    toast("休息结束，开始下一个番茄");
    pomo.mode = "focus"; pomo.left = POMO_FOCUS;
  }
  renderPomo();
}

function pomoTick() {
  pomo.left -= 1;
  if (pomo.left <= 0) { pomo.left = 0; renderPomo(); return pomoFinish(); }
  renderPomo();
}

$("#pomo-start").onclick = guard("番茄钟", () => {
  if (pomo.running) {
    clearInterval(pomo.timer); pomo.timer = null; pomo.running = false;
  } else {
    pomo.running = true;
    pomo.timer = setInterval(pomoTick, 1000);
  }
  renderPomo();
});
$("#pomo-reset").onclick = guard("重置番茄钟", () => {
  clearInterval(pomo.timer); pomo.timer = null;
  pomo.running = false; pomo.left = pomoTotal();
  renderPomo();
});
renderPomo();
