# 工作台代码审查报告 · 耦合专项

- **日期**：2026-10-09
- **范围**：study-tool 全项目（前端 3758 行 / 后端 2452 行）
- **重点**：模块耦合
- **方法**：静态扫描（专家脚本 `analyze.sh` 有 bug 未能运行，改为读代码 + 量化统计）

---

## 摘要

| 级别 | 问题 | 客观证据 |
|---|---|---|
| **P1** | `views-course` ⇄ `views-tools` **双向依赖** | 8 处跨模块访问 |
| **P1** | 全局 `state` 无边界 | 5 个文件 **158 处**直接读写 |
| **P2** | `core.js` 上帝模块 | 1398 行 / 84 函数 / 20 个分区 |
| **P3** | 跨模块裸调，靠加载顺序维系 | 4 处 |
| **P3** | 后端分层基本干净 | 仅 `todos.py` 直连 store（有权衡） |

---

## P1-1 `views-course` ⇄ `views-tools` 双向依赖

### 事实

**正向**（`views-tools.js` 直接操作 `views-course.js` 的私有状态 `pv`）：

| 行号 | 代码 |
|---|---|
| 267 / 284 | `pvSetDocxMode(true/false)` |
| 272 / 286 | `pv.doc = null` / `pv.doc = await pdfjsLib.getDocument(...)` |
| 287 | `pv.doc._materialId = "handbook_" + state.courseId` |
| 288 / 289 | `pv.doc.numPages` / `pv.page = 1` |
| 291 | `renderPage()` |

**反向**：`views-course.js:479` 调用 `openImmersive()`（定义在 `views-tools.js`）

→ 两个文件**互相依赖对方内部实现**，形成循环。

### 影响

- 读 `views-course.js` 无法知道 `pv` 会不会被外部改；改 HandBook 要动阅读器内部
- 加载顺序成为隐性约束（谁先谁后有讲究）
- 无法单独理解或测试任一模块

### 根因推断

HandBook（学习手册）当初**复用了资料阅读器那套 `#pdf-viewer` UI**——为了省事，
直接操作了它的内部状态。这是「复用 UI」时很常见的代价：复用的是 DOM 和状态，而不只是样式。

### 正确方案（根治）

**完成阅读器合并**，让 `#pdf-viewer` 整套消失：

```
现状：
  资料阅读 → #immersive（沉浸界面）
  HandBook / docx → #pdf-viewer ← 双向依赖就出在这里

目标：
  资料阅读 → #immersive
  HandBook / docx → #immersive（给它补上 docx 渲染能力）
  → #pdf-viewer + pv* 整套可删 → 双向依赖自然消失
```

- **收益**：不只是消除耦合，还顺手清掉 58 处 `pv*` 引用
- **成本**：约一轮工作量（沉浸界面加 docx 渲染 + HandBook 接线 + 清理）

**降级方案**（成本低、收益小）：把 `pv` 的读写收口成 `views-course` 导出的显式 API
（如 `pvLoadDocxInto(...)`），让耦合**显式化**而非消除。**建议优先做根治。**

---

## P1-2 全局 `state` 无边界

### 事实

```js
const state = {
  courses: [], courseId: null, tag: "", search: "",
  materials: [], busy: false, editMode: false, selected: new Set(),
  quizScopeTag: "", quizSelected: new Set(),
};
```

**10 个字段，被 5 个文件直接读写 158 次**：

| 文件 | 次数 |
|---|---|
| `views-tools.js` | 47 |
| `core.js` | 42 |
| `views-course.js` | 40 |
| `views-quiz.js` | 24 |
| `views-home.js` | 5 |

### 影响

任何一处改动都可能波及别处；无法追踪「谁改了这个状态」；单元测试几乎无法写。

### 根因推断

项目早期只有 2 个文件时，一个全局对象最省事；后来拆到 5 个模块，**没人来做收口**。
属于「演进遗留」而非设计失误。

### 正确方案：按域拆分（字段已经天然分好三组）

```js
// 课程域 —— 只有课程列表和侧栏关心
const courseState = { list: [], currentId: null };

// 资料域 —— 资料列表、勾选、搜索、编辑模式
const materialState = {
  list: [], tag: "", search: "", busy: false,
  editMode: false, selected: new Set(),
};

// 出题域 —— 只有出题页用
const quizState = { scopeTag: "", selected: new Set() };
```

- **收益**：一眼看出「哪个状态归哪个模块」，误改他域状态在 code review 时会很显眼
- **成本**：约 158 处**机械改名**，逻辑一行不变
- **风险**：**低**（纯重命名，无行为变化）

---

## P2 `core.js` 上帝模块

### 事实

**1398 行 / 84 个函数 / 20 个分区**。它同时承担：

基础设施（`guard`/`api`/`toast`/`esc`/`openModal`）、视图路由（`showView`）、SSE 流式、
资料行渲染、AI 整理、全局键盘分发、阅读进度、**文件笔记编辑器（~190 行）**、
**圈画引擎（~200 行）**、注释后台补齐、选择复制、**文本框（~220 行）**、
**PDF 文本层**、**PDF 目录**、拖拽排序、深浅色切换。

### 判断：建议暂缓（这是权衡，不是忽略）

**暂缓的理由**：

1. 它内部**已有 20 个分区注释**，秩序是有的——问题是物理体积，不是混乱
2. **单人开发**，不存在多人改同一文件的冲突
3. **关键约束**：项目是**纯 `<script>` 加载、没有模块系统**。拆分会产生
   更多全局符号 + **新的加载顺序依赖**——很可能把 P3 的问题放大
4. 拆分要处理 `INK` / `NOTE` / `state` 的共享，**牵连 P1-2**

**建议**：等 P1-2 做完（状态分域后共享面变小）再考虑；且一次只拆
「**零共享依赖**的段」（PDF 目录 / 拖拽排序 / 深浅色）。

**如果你判断这个文件已经影响到日常修改效率，那优先级就该提前** —— 这取决于你的实际体感，
我把它标为「建议暂缓」而非「可以忽略」。

---

## P3 跨模块裸调，靠加载顺序维系

### 事实

| 调用方 | 被调函数 | 定义在 |
|---|---|---|
| `views-home.js:38` | `openViewer()` | `views-course.js` |
| `views-quiz.js:87 / 131` | `openViewer()` | `views-course.js` |
| `views-course.js:479` | `openImmersive()` | `views-tools.js` |

加载顺序：`core → home → course → quiz → tools → main`

**当前不会报错**（都在函数体内调用，运行时才解析），但这是**隐式契约**：
靠全局函数名 + 加载顺序。若某文件加载失败，调用方**静默不可用**（虽然有 `guard` 兜错）。

### 正确方案：显式注册表

```js
// core.js
const App = { actions: {} };
function register(name, fn) { App.actions[name] = fn; }

// views-course.js 末尾
register("openViewer", openViewer);

// 调用方（明确表达「可能未加载」）
const open = App.actions.openViewer;
if (!open) { toast("阅读器未加载"); return; }
open(mid, page, name, ext);
```

- 成本低、改动小，可顺手做

---

## P3-2 后端分层：基本干净

**事实**：`backend/routers/` 7 个文件中，**只有 `todos.py` 直接 `import store`**，
其余都经 `core` → 分层方向清楚。

**判断：可接受**。todos 逻辑简单（增删改查），直连 store 无实质风险；
但建议**加一行注释标注这是有意例外**，避免后来者以为是遗漏而"纠正"成 core 调用。

---

## 优先建议

| 顺序 | 事项 | 成本 | 收益 | 风险 |
|---|---|---|---|---|
| **1** | P1-2 状态分域 | 低（机械改名） | 中高 | 低 |
| **2** | P1-1 阅读器合并 | 中（一轮） | **最高**（根治双向依赖 + 清 58 处引用） | 中 |
| **3** | P3 显式注册表 | 低 | 中 | 低 |
| **4** | P2 `core.js` 拆分 | 高 | 中 | 中（可能放大顺序依赖） |

**最该先修的是 P1-2**：成本最低、风险最低，而它又是 P2 的前置条件。

---

## 附：本次顺带完成的清理

删除「复制本页」功能（用户判定无用）：

- 前端：2 个按钮（`index.html:425/494`）+ `copyPageText()` 函数 + `act` 分发分支
- 后端：`GET /api/materials/{mid}/page-text/{page}` 路由 + `store.page_text()`
- 验证：`page-text` 已从接口表下线（总接口 42 个），全项目残留引用 0
