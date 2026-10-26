/* 出题与对话域：一键出题 / 问答面板 / 设置 */
// ---------- 出题 ----------
$("#btn-toggle-quiz-scope").onclick = () => $("#quiz-scope").classList.toggle("hidden");

function quizCandidates() {
  return materialState.list.filter(m => m.status === "ready" && (!quizState.scopeTag || m.tag === quizState.scopeTag));
}

function renderQuizScope() {
  const box = $("#quiz-material-list");
  if (!box) return;
  const list = quizCandidates();
  box.innerHTML = "";
  for (const m of list) {
    const label = document.createElement("label");
    label.title = m.orig_name;
    label.innerHTML = `<input type="checkbox" value="${m.id}" ${quizState.selected.has(m.id) ? "checked" : ""}>
      <span>${esc(m.orig_name)}</span>`;
    label.querySelector("input").onchange = (e) => {
      e.target.checked ? quizState.selected.add(m.id) : quizState.selected.delete(m.id);
      updateScopeCount();
    };
    box.appendChild(label);
  }
  // 清掉已不在列表里的选中项
  const ids = new Set(list.map(m => m.id));
  for (const id of [...quizState.selected]) if (!ids.has(id)) quizState.selected.delete(id);
  updateScopeCount();
}

function updateScopeCount() {
  const el = $("#quiz-scope-count");
  if (el) el.textContent = `已选 ${quizState.selected.size} 份资料`;
}

$("#quiz-tag-filter").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  quizState.scopeTag = chip.dataset.tag;
  document.querySelectorAll("#quiz-tag-filter .chip").forEach(c => c.classList.toggle("active", c === chip));
  renderQuizScope();
});
$("#btn-quiz-all").onclick = () => { quizCandidates().forEach(m => quizState.selected.add(m.id)); renderQuizScope(); };
$("#btn-quiz-none").onclick = () => { quizState.selected.clear(); renderQuizScope(); };

$("#btn-quiz").onclick = async () => {
  if (materialState.busy) return;
  const ids = [...quizState.selected];
  if (!ids.length) return toast("请先点「选择范围」勾选资料");
  const box = $("#quiz-result");
  materialState.busy = true;
  quizState.session = null;
  renderQuizBar();
  box.innerHTML = `<div class="quiz-empty">正在基于所选 ${ids.length} 份资料出题…</div>`;
  try {
    const r = await api(`/api/courses/${courseState.currentId}/quiz`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        material_ids: ids,
        num: Number($("#quiz-num").value),
        kind: $("#quiz-kind").value,
      }),
    });
    startQuiz(r.questions || []);
    loadCoverage();          // 出题会记台账，覆盖率要跟着动
  } catch (err) {
    box.innerHTML = `<div class="quiz-empty">${esc(err.message)}</div>`;
  } finally {
    materialState.busy = false;
  }
};

// ---------- 作答判分与错题重练 ----------
// 环闭在这里：作答落库 → 错题累积 → 只重练错过的 → 答对后自动移出错题。

function pickLetter(s) {
  const m = String(s ?? "").match(/^\s*[（(]?\s*([A-Za-z])/);
  return m ? m[1].toUpperCase() : "";
}

function startQuiz(questions) {
  quizState.session = { total: questions.length, answered: 0, correct: 0 };
  renderQuiz(questions);
  renderQuizBar();
}

function renderQuizBar() {
  const bar = $("#quiz-bar");
  if (!bar) return;
  const s = quizState.session;
  if (!s || !s.total) { bar.classList.add("hidden"); bar.innerHTML = ""; return; }
  const acc = s.answered ? Math.round(s.correct * 100 / s.answered) : null;
  bar.classList.remove("hidden");
  bar.innerHTML =
    `<span>已答 <b>${s.answered}</b>/${s.total}</span>` +
    `<span>对 <b>${s.correct}</b></span>` +
    `<span>错 <b>${s.answered - s.correct}</b></span>` +
    (acc === null ? "" : `<span>正确率 <b>${acc}%</b></span>`);
}

function renderQuiz(questions) {
  const box = $("#quiz-result");
  box.innerHTML = "";
  if (!questions.length) {
    box.innerHTML = `<div class="quiz-empty">没有题目，换个范围试试</div>`;
    return;
  }
  questions.forEach((q, i) => box.appendChild(quizCard(q, i)));
}

function quizCard(q, i) {
  const card = document.createElement("div");
  card.className = "quiz-card";
  const opts = q.options || [];
  const choices = opts.map((o, k) =>
    `<div class="q-opt" data-letter="${String.fromCharCode(65 + k)}">${esc(o)}</div>`).join("");
  const refs = (q.refs || []).map(r =>
    `<a class="cite" href="javascript:void(0)" data-mid="${r.material_id}" data-page="${r.page}" data-ext="${r.ext || "pdf"}">${esc(r.orig_name)} · ${unitLabel(r.ext, r.page)}</a>`
  ).join(" ");
  card.innerHTML = `
    <div class="q-title">${i + 1}. ${esc(q.question)}</div>
    ${choices ? `<div class="q-opts">${choices}</div>`
              : `<div class="q-short-hint">简答题：参考答案在下方，不参与判分</div>`}
    ${refs ? `<div class="q-refs">${refs}</div>` : ""}
    <div class="q-fb hidden"></div>`;
  card.querySelectorAll(".q-refs .cite").forEach(a => {
    a.onclick = () => openViewer(a.dataset.mid, Number(a.dataset.page), "", a.dataset.ext);
  });
  card.querySelectorAll(".q-opt").forEach(el => {
    el.onclick = () => submitAnswer(card, q, el);
  });
  if (!choices) {                       // 简答题：直接摊开参考答案
    card.dataset.done = "1";
    showFeedback(card, q, null, null);
  }
  return card;
}

async function submitAnswer(card, q, el) {
  if (card.dataset.done) return;
  card.dataset.done = "1";
  const pick = el.dataset.letter;
  el.classList.add("picked");
  let res;
  try {
    res = await api(`/api/quiz/questions/${q.id}/attempt`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: pick }),
    });
  } catch (e) {                         // 没记上就解锁，别让用户以为已作答
    toast("作答没记上：" + e.message);
    card.dataset.done = "";
    el.classList.remove("picked");
    return;
  }
  // 对错以服务端返回为准（前端只负责着色），避免两处判定口径漂移
  showFeedback(card, q, pick, res.correct);
  const s = quizState.session;
  if (s) {
    s.answered++;
    if (res.correct) s.correct++;
    renderQuizBar();
    if (s.answered >= s.total) finishQuiz();
  }
}

function showFeedback(card, q, pick, correct) {
  const ans = pickLetter(q.answer);
  card.querySelectorAll(".q-opt").forEach(o => {
    o.classList.add("locked");
    const L = o.dataset.letter;
    if (L === ans) o.classList.add("correct");
    else if (pick && L === pick) o.classList.add("wrong");
  });
  const fb = card.querySelector(".q-fb");
  fb.classList.remove("hidden");
  if (pick === null || pick === undefined) {          // 简答题
    fb.className = "q-fb";
    fb.innerHTML = `<b>参考答案：</b>${esc(q.answer)}` +
      (q.explanation ? `<div class="q-exp">${esc(q.explanation)}</div>` : "");
    return;
  }
  fb.className = "q-fb " + (correct ? "ok" : "bad");
  fb.innerHTML = `<b>${correct ? "答对了" : "答错了"}</b> · 正确答案 ${esc(q.answer)}` +
    (q.explanation ? `<div class="q-exp">${esc(q.explanation)}</div>` : "");
  // 答错 = 薄弱点 → 直接给一条「回到学习」的路。
  // 少了这一步，闭环只是「测验 → 测验」，错题永远回不到讲解。
  if (!correct) {
    const btn = document.createElement("button");
    btn.className = "btn btn-outline btn-sm q-ask";
    btn.textContent = "让 AI 讲讲这个知识点";
    btn.onclick = () => askAboutQuestion(q, pick);
    fb.appendChild(btn);
  }
}

// ---------- 错题回流学习 ----------
// 带着题目上下文跳进问答：题干 + 我错选了什么 + 正确答案 + 出自哪一页，
// 这样检索能锁定到这道题对应的知识点，而不是泛泛地聊。
async function askAboutQuestion(q, pick) {
  switchTab("study");
  const ref = (q.refs || [])[0];
  const src = ref ? `（出自《${ref.orig_name}》第 ${ref.page} 页）` : "";
  const brief = q.question.length > 34 ? q.question.slice(0, 34) + "…" : q.question;
  appendMsg("user", `这道题答错了，讲讲这个知识点：${brief}`);
  await runChat({
    question:
      `我答错了下面这道题，请结合课程资料把这个知识点讲清楚${src}。\n\n` +
      `题目：${q.question}\n` +
      `我的答案：${pick}\n` +
      `正确答案：${q.answer}\n\n` +
      `请先说明正确答案为什么对、我选的为什么错，再把相关知识点完整讲一遍，` +
      `最后指出我容易混淆的地方。`,
    mode: "ask",
  });
}

function finishQuiz() {
  const s = quizState.session;
  const wrong = s.total - s.correct;
  const acc = Math.round(s.correct * 100 / s.total);
  const el = document.createElement("div");
  el.className = "quiz-summary";
  el.innerHTML = `<div>本轮 ${s.total} 题：对 <b>${s.correct}</b> · 错 <b>${wrong}</b> · 正确率 <b>${acc}%</b></div>` +
    (wrong ? `<button class="btn btn-primary btn-sm" id="btn-retry-wrong">重练这 ${wrong} 道错题</button>` : "");
  const box = $("#quiz-result");
  box.appendChild(el);
  const b = el.querySelector("#btn-retry-wrong");
  if (b) b.onclick = loadWrongQuiz;
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function loadWrongQuiz() {
  const box = $("#quiz-result");
  quizState.session = null;
  renderQuizBar();
  box.innerHTML = `<div class="quiz-empty">正在取出错题…</div>`;
  try {
    const r = await api(`/api/courses/${courseState.currentId}/quiz/wrong`);
    if (!r.questions?.length) {
      box.innerHTML = `<div class="quiz-empty">错题已经清空了，这门课暂时没有要重练的题</div>`;
      return;
    }
    startQuiz(r.questions);
  } catch (e) {
    box.innerHTML = `<div class="quiz-empty">${esc(e.message)}</div>`;
  }
}

$("#btn-quiz-wrong").onclick = loadWrongQuiz;

// ---------- 覆盖率与全面覆盖 ----------
// 全面覆盖会遍历范围内所有还没出过题的知识点，可能几十批、十几分钟，所以：
//   ① 启动前把代价摊给用户看（批数 / 预计耗时 / 还剩多少）；
//   ② 放后台跑，前端轮询进度，不阻塞界面；
//   ③ 一轮跑不完可以再点一次接着跑（台账记着进度，不会重来）。

let covTimer = null;

// 覆盖率按用户勾选的范围算；一份没勾就按整门课算
function coverageScopeIds() { return [...quizState.selected]; }
function coverageQuery(ids) { return ids.length ? `?material_ids=${ids.join(",")}` : ""; }

async function loadCoverage() {
  const box = $("#quiz-coverage");
  if (!box) return null;
  let cov;
  try {
    const ids = coverageScopeIds();
    cov = await api(`/api/courses/${courseState.currentId}/quiz/coverage${coverageQuery(ids)}`);
  } catch (e) {
    return null;
  }
  if (!cov || !cov.total) { box.classList.add("hidden"); return null; }
  box.classList.remove("hidden");
  $("#cov-fill").style.width = cov.percent + "%";
  $("#cov-pct").textContent = cov.percent + "%";
  $("#cov-nums").textContent = `已覆盖 ${cov.covered} / ${cov.total} 个知识点`
    + (cov.pending ? `　未覆盖 ${cov.pending}` : "　范围已全部覆盖");
  const det = $("#cov-detail");
  if (!det.classList.contains("hidden")) {
    det.innerHTML = cov.by_material.map(m => {
      const pct = m.total ? Math.round(m.covered * 100 / m.total) : 0;
      return `<div class="cov-line">
        <span class="cov-name" title="${esc(m.orig_name)}">${esc(m.orig_name)}</span>
        <span class="cov-track sm"><i style="width:${pct}%"></i></span>
        <span class="cov-num">${m.covered}/${m.total}</span></div>`;
    }).join("");
  }
  return cov;
}

$("#btn-cov-detail").onclick = async () => {
  const det = $("#cov-detail");
  det.classList.toggle("hidden");
  const open = !det.classList.contains("hidden");
  $("#btn-cov-detail").textContent = open ? "收起明细" : "按资料明细";
  if (open) await loadCoverage();
};

$("#btn-quiz-full").onclick = async () => {
  if (materialState.busy) return;
  const ids = coverageScopeIds();
  if (!ids.length) return toast("请先点「选择范围」勾选资料");
  const cov = await loadCoverage();
  if (!cov) return toast("拿不到覆盖情况，稍后再试");
  if (!cov.pending) return toast("范围内所有知识点都已出过题");

  const mins = Math.max(1, Math.round(cov.eta_seconds / 60));
  const msg = [
    `本轮处理 ${cov.this_run_batches} 批，预计 ${mins} 分钟，约新增 ${Math.min(cov.pending, cov.this_run_batches * 6)} 道题。`,
    cov.truncated
      ? `范围内还有 ${cov.pending} 个知识点未覆盖，一轮跑不完，之后可以再点一次继续。`
      : "",
    "",
    "现在开始吗？开始后可以继续用界面，进度会显示在覆盖率下面。",
  ].filter(Boolean).join("\n");
  if (!confirm(msg)) return;

  materialState.busy = true;
  try {
    const r = await api(`/api/courses/${courseState.currentId}/quiz/full`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ material_ids: ids, kind: $("#quiz-kind").value }),
    });
    if (!r.started) {
      toast(r.reason || "无需覆盖");
      materialState.busy = false;
      return;
    }
    startCovPolling();
  } catch (e) {
    toast("启动失败：" + e.message);
    materialState.busy = false;
  }
};

function startCovPolling() {
  stopCovPolling();
  $("#cov-progress").classList.remove("hidden");
  const tick = async () => {
    let r;
    try {
      const ids = coverageScopeIds();
      r = await api(`/api/courses/${courseState.currentId}/quiz/full${coverageQuery(ids)}`);
    } catch (e) {
      stopCovPolling();
      materialState.busy = false;
      return;
    }
    const el = $("#cov-progress");
    const job = r.job;
    if (!job) { el.textContent = "任务已结束"; stopCovPolling(); materialState.busy = false; return; }
    if (job.status === "running") {
      el.textContent = `覆盖进行中：${job.done}/${job.total} 批，已新增 ${job.added} 道题`;
    } else if (job.status === "ok") {
      el.textContent = job.note || "完成";
      stopCovPolling();
      materialState.busy = false;
      await loadCoverage();
      return;
    } else {
      el.textContent = "覆盖失败：" + (job.error || "未知错误");
      stopCovPolling();
      materialState.busy = false;
      return;
    }
    await loadCoverage();
  };
  tick();
  covTimer = setInterval(tick, 3000);
}

function stopCovPolling() {
  if (covTimer) { clearInterval(covTimer); covTimer = null; }
}

// ---------- 聊天 ----------
async function loadMessages() {
  const msgs = await api(`/api/courses/${courseState.currentId}/messages`);
  const log = $("#chat-log");
  log.innerHTML = `<div class="chat-hint">提问会<strong>只在当前课程的资料范围内</strong>检索回答，并标注出处页码。</div>`;
  for (const m of msgs) appendMsg(m.role, m.content, m.citations);
  log.scrollTop = log.scrollHeight;
}

function appendMsg(role, content, citations = []) {
  const log = $("#chat-log");
  const div = document.createElement("div");
  div.className = role === "user" ? "msg msg-user" : "msg msg-ai";
  div.innerHTML = formatAiText(content);
  if (role === "assistant" && citations?.length) div.appendChild(citeRow(citations));
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function formatAiText(text) {
  let html = esc(text);
  html = html.replace(/\[(\d{1,2})\]/g, '<span style="color:var(--accent);font-size:12px">[$1]</span>');
  return html.replace(/\n/g, "<br>");
}

function citeRow(citations) {
  const row = document.createElement("div");
  row.className = "cite-row";
  for (const c of citations) {
    const a = document.createElement("a");
    a.className = "cite";
    a.href = "javascript:void(0)";
    if (c.material_id) a.onclick = () => openViewer(c.material_id, c.page, c.orig_name, c.ext);
    else { a.style.pointerEvents = "none"; a.style.opacity = ".7"; }
    a.textContent = `[${c.n}] ${c.orig_name} · ${unitLabel(c.ext, c.page)}`;
    row.appendChild(a);
  }
  return row;
}

// 「允许外部资料」开关：开启后跨课程检索 + 允许 AI 补充资料外知识；状态记在本地
const EXT_KEY = "sls-allow-external";
const extBox = $("#chat-allow-external");
extBox.checked = storage.get(EXT_KEY) === "1";
$("#ext-switch").classList.toggle("on", extBox.checked);
extBox.onchange = () => {
  storage.set(EXT_KEY, extBox.checked ? "1" : "0");
  $("#ext-switch").classList.toggle("on", extBox.checked);
  toast(extBox.checked
    ? "已开启外部资料：可跨课程检索，资料不足时 AI 会补充并标明"
    : "已关闭：只在当前课程资料范围内回答");
};

$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (materialState.busy) return;
  const input = $("#chat-input");
  const question = input.value.trim();
  if (!question) return;
  input.value = "";
  appendMsg("user", question);
  await runChat({ question, mode: "ask", allow_external: extBox.checked });
});

// ---------- 设置 ----------
$("#btn-settings").onclick = async () => {
  const s = await api("/api/settings");
  $("#set-key").value = "";
  $("#set-threshold").value = s.threshold;
  $("#set-key-state").textContent = s.has_key ? "已配置 API Key（留空则不修改）" : "尚未配置，问答功能不可用";
  openModal("#modal-settings");
};
$("#btn-save-settings").onclick = async () => {
  const body = { threshold: parseFloat($("#set-threshold").value) || 0.42 };
  const key = $("#set-key").value.trim();
  if (key) body.api_key = key;
  await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  closeModal("#modal-settings");
  toast("设置已保存");
};


// ---------- 对话执行（依赖 core 的 streamSSE） ----------
async function runChat({ question, mode, allow_external = false }) {
  materialState.busy = true;
  $("#btn-send").disabled = true;
  const log = $("#chat-log");
  const div = document.createElement("div");
  div.className = "msg msg-ai";
  div.innerHTML = `<span class="cursor"></span>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  let text = "";
  const paint = (withCursor) => {
    div.innerHTML = formatAiText(text) + (withCursor ? `<span class="cursor"></span>` : "");
    log.scrollTop = log.scrollHeight;
  };
  try {
    await streamSSE(`/api/courses/${courseState.currentId}/chat`, { question, mode, allow_external }, {
      onDelta: (d) => { text += d; paint(true); },
      onError: (msg) => { text += `\n\n${msg}`; paint(false); },
      onDone: (citations) => {
        paint(false);
        if (citations.length) div.appendChild(citeRow(citations));
        log.scrollTop = log.scrollHeight;
      },
    });
    if (!text) div.innerHTML = `<span class="muted">（无返回内容）</span>`;
  } catch (err) {
    div.innerHTML = `${esc(err.message)}`;
  } finally {
    materialState.busy = false;
    $("#btn-send").disabled = false;
    log.scrollTop = log.scrollHeight;
  }
}

$("#btn-clear-chat").onclick = async () => {
  if (!confirm("清空当前课程的全部对话记录？")) return;
  await api(`/api/courses/${courseState.currentId}/messages`, { method: "DELETE" });
  loadMessages();
};

// 导学：切到互动学习页并请求 AI 导学
$("#btn-guide").onclick = async () => {
  if (materialState.busy) return;
  switchTab("study");
  appendMsg("user", "请求 AI 导学…");
  await runChat({ question: "", mode: "guide" });
};
