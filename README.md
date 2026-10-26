> **This is a derivative copy.** Original project: [Terrence20070515/Self-study_AI_Assistant](https://github.com/Terrence20070515/Self-study_AI_Assistant) · MIT · author **Terrence**.
> This repository exists to experiment with retrieval quality. See [ATTRIBUTION.md](ATTRIBUTION.md) and [CHANGES.md](CHANGES.md).

# Self-Learning Space · 本地 AI 学习助手

**中文** | [English](README.en.md)

一个**完全本地运行**的课程学习工作台：把 PDF/Word 课件按课程整理入库，基于自己的资料做**精准问答**（RAG，标注出处页码，检索不到就明说，不编造），并在阅读器里做圈画、批注、AI 逐页注释。

> 定位：给自己的「第二大脑」。数据全部留在本机（SQLite + 文件），只有调用大模型时才联网。

## 它解决什么问题

真实的痛点场景：一门课的课件是**英文 PDF**，但我习惯用**中文提问**。通用 AI 助手会：
- 不知道课程讲到哪、用了什么教材
- 回答不标注依据，无法核对
- 问它「这份课件里怎么讲的」时，它靠的是训练数据而不是我的资料

这个工具的核心就一件事：**回答必须来自你的资料，且能点着出处跳到原文那一页。**

## 功能

| 模块 | 说明 |
|---|---|
| **课程与资料管理** | 按课程代码组织，支持 PDF / docx，批量导入（含 zip 包），标签分类（讲义/习题/往年卷…），回收区可恢复；导出支持单份直接下载 / 多份打包 |
| **RAG 精准问答** | 混合检索（向量 + 词面）+ 中文术语映射，回答附 `[n]` 出处，点击跳转到 PDF 对应页；资料不足时**明确拒答**而非编造。支持「讲 L01 的重点」这类按资料点名的问法 |
| **AI 逐页注释** | 每页自动生成要点与考点，可手工编辑；支持**中文 / English / Español** 三种语言，各自独立生成、互不覆盖 |
| **PDF 阅读器** | 圈画（圆珠笔/荧光笔）、页面上加文本框、目录跳转、内嵌书签、每份资料独立笔记 |
| **练习闭环** | 选择题点选即判分（对错由服务端判定），错题按「最近一次仍错」判定、答对自动移出；答错可「让 AI 讲讲这个知识点」，带着题干跳回问答 |
| **覆盖率台账** | 把资料切成知识点单元并记录哪些出过题；日常练习与「全面覆盖」都在推进覆盖率，跨轮累积、可断点续跑 |
| **学习辅助** | HandBook 手册、考核构成记录、加权均分计算、待办清单 |

## 界面预览

**问答必须标注出处，点一下跳到原文那一页：**

![RAG 问答](docs/screenshots/rag-answer.png)

**练习闭环：点选即判分，答错的那道题可以「让 AI 讲讲这个知识点」—— 从测验回到学习：**

![练习闭环](docs/screenshots/practice-closed-loop.png)

**逐页注释支持中文 / 英文 / 西班牙语，三种语言分开存：**

![多语言注释](docs/screenshots/notes-multilingual.png)

**覆盖率：把「这门课复习了多少」变成可量化的数字：**

![知识点覆盖率](docs/screenshots/coverage.png)

## 快速开始

```bash
git clone git@github.com:Terrence20070515/Self-study_AI_Assistant.git
cd Self-study_AI_Assistant

python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 配置 API Key（二选一）
cp .env.example .env        # 方式一：填进 .env
export DEEPSEEK_API_KEY=sk-xxx   # 或直接给环境变量
# 方式二：启动后在界面右上角「设置」里填（存本地 data/config.json）

python launcher.py          # 桌面窗口（pywebview）
# 或
bash start.sh               # 浏览器模式
```

首次启动会自动下载向量模型（约 250MB，本地 ONNX 推理，之后离线可用）。

> 需要 Python 3.10+。桌面窗口模式依赖系统 WebView（macOS 自带；Linux 需 `webkit2gtk`）。

## 技术设计

### RAG 链路

```
PDF/docx 解析 → 分块(600字滑窗/重叠100) → 向量化(384维多语言模型)
             → 混合检索(向量0.72 + 词面0.28) → 阈值过滤 → DeepSeek 生成(附 [n] 引用)
```

**防幻觉的两道设计**：
- 严格模式下 system prompt 明确「只依据资料片段回答，禁止使用资料之外的知识」
- 检索分数低于阈值时，直接返回「资料库中未找到足够相关的内容」，**不给模型编造的机会**

### 几个值得说的技术决策

**1. 向量模型：从中文专用换成多语言**

最初的选型是 `BAAI/bge-small-zh-v1.5`（中文专用）。但我的库里资料以英文为主、提问却是中文，实测跨语言检索严重掉分：

| 提问 | 中文模型 | 多语言模型 |
|---|---|---|
| 中文「什么是外键」 | 0.464（勉强） | **0.530** |
| 中文「外键的作用」 | 0.469 | **0.508** |
| 英文「How to create a table?」 | 0.794 | **0.826** |

**同样的意思、同样的资料，只是把问题换成中文，相似度就掉 30%。**

**结论**：资料语言 ≠ 提问语言时，必须用多语言模型。换模型后需要**全量重编码**（维度从 512 变 384，新旧向量无法拼成矩阵）。

**2. 为什么是「混合检索」而不是纯向量**

向量检索对精确术语不敏感——问 `3NF`、`FOREIGN KEY`、`B+ tree` 这类词，纯向量经常召回语义相近但术语不对的内容。所以加了词面重合度打分：

```python
final = 向量相似度 × 0.72 + 词面重合度 × 0.28
```

其中中文提问会通过一张**中英术语对照表**补出英文写法（外键 → foreign key），让词面信号在跨语言场景也能起作用。

**3. 文字选择：删掉自实现，交回浏览器原生**（三次返工的教训）

这个功能我迭代了三次：

1. 第一次「完全选不中」→ 以为是 WebView 兼容性 → **真因是文字层坐标矩阵写错**
2. 第二次「选得不准」→ 以为是判定阈值不好 → **真因是我实现的只是「块级选择」，达不到原生字符级精度**
3. 第三次**做减法**：删掉自己写的约 100 行，让事件完全不拦截，交回浏览器 —— **一次到位**

**教训**：**动手前先问「浏览器原生是不是已经支持」**。我在重造一个更差的轮子，还用 `preventDefault()` 把原生方案挡住了。

**4. PDF 文字层的两个几何坑**

文字层是「透明文字覆盖在位图上」的实现，位置算错会有很反直觉的后果：

- **矩阵乘法写错** → 文字层整体偏移 → 选择和圈画全部失效
- **盒子高度按「基线往上一个字高」定位** → 盒子比视觉文字高，**和上一行的盒子重叠** → 拖选时动不动往上多选一行
- **字宽不匹配 PDF 原始宽度** → 相邻块**水平方向互相重叠** 5~15px → 鼠标落进重叠区就选不准

后两个的修法：盒子上沿对齐文字视觉顶部（0.82 倍字高）、用 `scaleX` 把每块压到 PDF 原始宽度（这也是 pdf.js 官方 textLayer 的做法）。

### 目录结构

```
backend/
  core.py         RAG 主链路：解析 → 分块 → 向量化 → 检索 → 生成
  store.py        SQLite 数据层
  routers/        按域拆分的 HTTP 接口
frontend/         无框架多模块前端（原生 JS）
docs/screenshots/ README 用的界面截图
tools/            回归脚本（知识点单元一致性 / 练习闭环 / DDL 解析）
data/             运行期数据（课件、数据库、配置）—— 已 gitignore
launcher.py       pywebview 桌面窗口
```

## 已知限制

- **扫描版 PDF（纯图片）不支持**，需要 OCR 才能入库
- 分块是固定长度滑窗，单个块可能从句子中间开始；检索时会把命中块的前后各扩一块、
  按 ord 拼回并裁掉重叠来补偿，但没有做语义边界切分
- 检索没有重排序（rerank）环节，`top_k` 直接取前 N
- 跨语言（中文提问 + 英文资料）依赖 `_TERM_MAP` 里维护的术语对照，覆盖不到的专业词
  仍可能检索不到
- 回答质量取决于检索命中率与所配模型的能力

## 数据与隐私

- 所有数据（课件、数据库、笔记、聊天记录）**只存在本机 `data/` 目录**，拷走该目录即完整备份
- API Key 支持 `.env` 环境变量或界面内填写，不存在代码里
- 除调用大模型 API 外，全程离线（向量模型本地推理）

## 平台支持

| 平台 | 状态 |
|---|---|
| macOS | ✓ 主要开发平台 |
| Windows | ✓ 浏览器模式用 `start.bat`；桌面模式需 WebView2（Win11 自带，Win10 需安装） |
| Linux | ✓ 桌面模式需 `webkit2gtk` |

```bash
python launcher.py      # macOS / Linux 桌面窗口
start.bat               # Windows 浏览器模式
```

## 附：本机三系统安装与新手教程（2026-10-26）

> 这一节不是本项目功能的一部分，而是维护者本机真实在跑的三个 AI 系统的**安装 + 新手笔记**：**OpenClaw**（agent 网关）、**DeepSeek Harness**（本地编码 agent）、**本应用**（Self-Learning Space）。统一按「是什么 → 安装 → 首次运行 → 新手怎么用 → 踩过的坑」记录，换电脑时可照着复现。

### 1️⃣ OpenClaw — AI agent 网关 + Control UI

**是什么**：本地常驻的 agent 网关。CLI、浏览器 Control UI、多渠道（webchat / 微信 / QQ 等）都接在它上面，所有对话与记忆落在 `~/.openclaw/`。

**安装要求**：Node **24.22.1+**（推荐 26.12.1+）；macOS / Linux / WSL2 / Windows 均可。

```bash
# macOS / Linux / WSL2
curl -fsSL https://openclaw.ai/install.sh | bash
```

```powershell
# Windows (PowerShell)
iwr -useb https://openclaw.ai/install.ps1 | iex
```

> 也可以直接装桌面版（Windows Hub / macOS 菜单栏 app），首次启动即可建本地 Gateway。

**首次运行**：安装器自动跑 onboarding（选模型、填 API Key）→ `openclaw status` 确认网关活着。

**新手怎么用**

- `openclaw status` 看健康 · `openclaw models list` 看可用模型 · `openclaw doctor` 排障
- 浏览器打开 Control UI 直接聊天；多设备可加 node
- 改配置：`openclaw config set <字段路径> '<json>' --strict-json`（先加 `--dry-run` 预演）
- 扩展：skills、MCP 服务（`openclaw mcp set / probe`）、定时 automations

**踩过的坑**

- WSL **mirrored 网络**模式下端口会和 Windows 进程冲突（微信常占一批）→ 选注册段空闲端口
- `openclaw agent --model ...` 在 agent 回合内会被拒（丢失会话归属）→ 验证模型请用 `openclaw infer model run --model <provider>/<model>`
- 不要用 shell 重启网关，用聊天里的 `/restart` 或专用工具

### 2️⃣ DeepSeek Harness（dsh）— 本地终端编码 agent

**是什么**：DeepSeek 官方终端编码 agent，自带 Web UI，可选工作目录、直接用自然语言下任务。

**安装要求**：Node + npm。

```bash
npm i -g @deepseek-ai/dsh@<版本> --registry=https://registry.npmmirror.com
```

> ⚡ 走 npmmirror 镜像明显更快；**查最新版别只看 npm `latest`**——新版常在 GitHub Releases / npm `next` tag。

**首次运行 / 每次启动**

```bash
bash ~/.local/bin/start-dsh.sh    # 打印带 token 的访问地址
```

Windows 端可双击 `.bat` 启动器（内部调 WSL 脚本再打开默认浏览器）。

**新手怎么用**：打开带 token 的 URL → 选工作目录 → 直接用自然语言说任务；**升级后先结束旧进程再启动**，否则跑的还是老版本。

**踩过的坑**

- 换端口要改两处：脚本里的 `PORT` **以及** 启动参数 `--port "$PORT"`（只改变量无效）
- 别 `pkill -f dsh`（会匹配到执行它的 shell 自己）→ 先 `ps -eo pid,cmd | grep` 找 PID 再 kill

### 3️⃣ 本应用（Self-Learning Space）— 本地课程 RAG 工作台

**是什么**：把 PDF/DOCX 课件按课程入库，基于自己的资料做**带出处页码**的问答；另有 AI 逐页注释、PDF 圈画批注、练习闭环、知识点覆盖率台账。数据全在本机，仅调大模型时联网。

**安装要求**：Python 3.10+；首次启动需下载约 250MB 本地向量模型（fastembed ONNX），之后离线可用。

```bash
git clone git@github.com:QuuuuuuuuuX/Self-study_AI_Assistant.git
cd Self-study_AI_Assistant
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # 填 DEEPSEEK_API_KEY（也可启动后在「设置」里填）
```

**首次运行**

```bash
bash start.sh        # 浏览器模式 → http://127.0.0.1:8765
# 或
python launcher.py   # 桌面窗口（pywebview）
```

**新手怎么用**

1. **建课程**：课程代码（如 ADS106TC）+ 名称
2. **传资料**：单份直接上传；整门课批量先 `.venv/bin/python import_courses.py --dry-run` 看清单，去掉 `--dry-run` 再真导
3. **问答**：用中文问英文课件，答案带 `[n]` 出处，点一下跳到原文那一页
4. **练习**：选择题点选即判分，答错可「让 AI 讲讲这个知识点」，带着题干跳回问答

**踩过的坑**

- 只收 **PDF / DOCX**，`.md` 不收；自有笔记要入库需先转 docx，建议单独打「笔记」标签，别与原始讲义混在一起
- 数据在 `data/study.db`（courses / materials / chunks 含 embedding）+ `data/files/`；核对是否真入库：
  `select count(*), sum(embedding is not null) from chunks where material_id='<id>'`
- 首次启动下载向量模型需要等待，不要误判为卡死
- 默认端口 **8765**，与其它本地服务共存时注意避开占用

## License

MIT
