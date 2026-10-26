"""核心 RAG 链路：PDF 解析 → 分块 → 向量化 → 检索 → DeepSeek 生成。"""
import os

# 国内网络默认走 HF 镜像下载向量模型（已缓存时无影响）
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
# 禁用 HF 的 xet 传输协议：它要求登录认证，匿名访问会报 401（实测踩过这个坑）
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

import json
import re
import threading
from typing import Iterator

import fitz  # PyMuPDF
import httpx
import numpy as np

from . import store
from .config import load_config, material_file_path

_embedder = None
_embedder_lock = threading.Lock()

# 多语言向量模型：库里资料以英文为主（实测中文占比≈0%），但提问常是中文。
# 中文专用模型（bge-small-zh，512 维）在这套语料上跨语言检索会掉约 30% 相似度，
# 导致「无相关资料」频发。换成多语言模型（384 维）后中英可在同一坐标空间对齐。
# 注意：换模型必须**全量重编码** chunks.embedding —— 维度不同不能混用（见 data/reembed.py）。
EMBED_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

# 导入 DeepSeek SDK（延迟到使用时，避免没配 Key 时也报错）
from openai import OpenAI  # noqa: E402


# ---------- embedding ----------

def get_embedder():
    global _embedder
    if _embedder is None:
        with _embedder_lock:
            if _embedder is None:
                from fastembed import TextEmbedding
                _embedder = TextEmbedding(model_name=EMBED_MODEL)
    return _embedder


def embed_texts(texts: list[str]) -> np.ndarray:
    model = get_embedder()
    vecs = np.array(list(model.embed(texts)), dtype=np.float32)
    norm = np.linalg.norm(vecs, axis=1, keepdims=True)
    norm[norm == 0] = 1.0
    return vecs / norm


# ---------- PDF 处理 ----------

def parse_pdf(path: str) -> list[tuple[int, str]]:
    """返回 [(page_no(从1起), page_text)]，跳过几乎为空的页。"""
    pages = []
    with fitz.open(path) as doc:
        for i, page in enumerate(doc):
            text = page.get_text("text").strip()
            if len(text) >= 20:
                pages.append((i + 1, text))
    return pages


# 分块参数：块大小与相邻块重叠字数（检索召回率与上下文体量的折中）
CHUNK_SIZE = 600
CHUNK_OVERLAP = 100


def chunk_pages(pages: list[tuple[int, str]], size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP):
    """把每页文本切成约 size 字的块，保留页码。"""
    out = []
    for page_no, text in pages:
        text = re.sub(r"\s+", " ", text)
        if len(text) <= size:
            out.append((page_no, text))
            continue
        step = size - overlap
        for i in range(0, len(text), step):
            piece = text[i : i + size]
            if len(piece) < 30 and out and out[-1][0] == page_no:
                break
            out.append((page_no, piece))
            if i + size >= len(text):
                break
    return out


# ---------- PDF / DOCX 处理 ----------

def parse_docx(path: str) -> list[str]:
    """提取 docx 的段落和表格文本块。"""
    import docx
    d = docx.Document(path)
    blocks = []
    for para in d.paragraphs:
        t = para.text.strip()
        if t:
            blocks.append(t)
    for table in d.tables:
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                blocks.append(" | ".join(cells))
    return blocks


def chunk_docx(blocks: list[str], size: int = 600) -> list[tuple[int, str]]:
    """把 docx 文本块合并成约 size 字的分块，page 记为块序号（引用时显示为段落号）。"""
    out, buf, no = [], "", 0
    for b in blocks:
        b = re.sub(r"\s+", " ", b)
        if not b:
            continue
        if len(buf) + len(b) <= size:
            buf = f"{buf}\n{b}" if buf else b
            continue
        if buf:
            no += 1
            out.append((no, buf))
        buf = b if len(b) <= size else b[:size]
        # 超长单块再切
        while len(buf) >= size:
            no += 1
            out.append((no, buf[:size]))
            buf = buf[size:]
    if buf.strip():
        no += 1
        out.append((no, buf.strip()))
    return out


# ---------- 资料性质自动判定 ----------

# 优先级从高到低：往年卷 > 习题 > 课程具体要求 > 文献 > 讲义（越具体的越先匹配）
# 注意：这里是「规则兜底」，入库后还有一次 AI 判定会覆盖它（人工改过标签的除外）
TAG_RULES = [
    ("往年卷", ["past paper", "pastpaper", "past-paper", "past exam", "exam", "final",
               "midterm", "mid-term", "quiz", "试卷", "往年", "真题", "考试", "期末", "期中"]),
    ("习题", ["exercise", "tutorial", "worksheet", "problem set", "problemset",
             "homework", "assignment", "hw", "practice", "习题", "作业", "练习", "题库"]),
    ("课程具体要求", ["handbook", "syllabus", "module spec", "module specification",
                    "assessment brief", "coursework brief", "requirement", "learning outcome",
                    "marking scheme", "grading", "课程要求", "考核要求", "评分标准",
                    "教学大纲", "课程大纲", "作业要求", "课程说明"]),
    ("文献", ["reference", "reading list", "reading", "literature", "bibliography",
             "journal", "article", "paper", "citation", "文献", "参考文献", "阅读材料", "论文"]),
    ("讲义", ["lecture", "slide", "note", "chapter", "handout", "week",
             "讲义", "课件", "笔记", "教案", "复习"]),
]


def pick_sample(texts: list[str], limit: int = 2000) -> str:
    """取「首 + 中 + 尾」拼出判定样本。

    只看开头会漏掉中后段才出现的关键词，三段采样成本几乎为零、命中率明显更高。
    """
    if not texts:
        return ""
    if sum(len(t) for t in texts) <= limit:
        return " ".join(texts)
    n = len(texts)
    idxs = []
    for i in (0, n // 2, n - 1):
        if i not in idxs:
            idxs.append(i)
    per = limit // len(idxs)
    return " ".join(texts[i][:per] for i in idxs)


def guess_tag(filename: str, sample_text: str = "") -> str:
    s = (filename + " " + sample_text[:2000]).lower()
    for tag, kws in TAG_RULES:
        if any(k in s for k in kws):
            return tag
    return "其他"


def process_material(material_id: str):
    """后台任务：解析 PDF/DOCX → 分块 → 向量化 → 入库 → 一次 AI 分析。"""
    ready = False
    try:
        store.update_material(material_id, status="processing")
        mat = store.get_material(material_id)
        ext = (mat.get("ext") or "pdf").lower()
        path = material_file_path(material_id, ext)
        if ext == "docx":
            blocks = parse_docx(path)
            chunks = chunk_docx(blocks)
            total_units = len(chunks)
            empty_msg = "Word 文档中没有可提取的文字（可能是纯图片内容）"
        else:
            pages = parse_pdf(path)
            chunks = chunk_pages(pages)
            total_units = max((p for p, _ in pages), default=0)
            empty_msg = "PDF 中没有可提取的文字（可能是扫描件，本工具暂不支持 OCR）"
        if not chunks:
            store.update_material(material_id, status="failed", error=empty_msg)
            return
        texts = [t for _, t in chunks]
        # 规则兜底：用「文件名 + 首/中/尾采样」判定性质，人工改过的标签锁定不动
        if not mat.get("tag_locked"):
            store.update_material(
                material_id, tag=guess_tag(mat["orig_name"], pick_sample(texts))
            )
        vecs = embed_texts(texts)
        rows = [
            (chunks[i][0], i, chunks[i][1], vecs[i].tobytes())
            for i in range(len(chunks))
        ]
        store.add_chunks(mat["course_id"], material_id, rows)
        store.update_material(material_id, status="ready", pages=total_units)
        ready = True
    except Exception as e:  # noqa: BLE001
        store.update_material(material_id, status="failed", error=str(e)[:300])
    # 资料已经可用。这一步只在后台补信息，失败不影响任何功能。
    if ready:
        analyze_material(material_id)


def process_material_async(material_id: str):
    threading.Thread(target=process_material, args=(material_id,), daemon=True).start()


# ---------- 入库 AI 分析（每份资料只跑一次） ----------

AI_TAGS = ("讲义", "习题", "往年卷", "文献", "课程具体要求", "其他")

ANALYZE_PROMPT = (
    "下面是一份大学课程资料的文件名和内容片段（开头、中间、结尾）。"
    "请判断这份资料，只输出 JSON，不要输出任何解释文字：\n"
    '{"tag":"讲义","summary":"一句话摘要","keywords":["关键词1","关键词2"],"course_code":"CPT203"}\n'
    "规则：\n"
    "1. tag 只能从这 6 个里选一个：讲义 / 习题 / 往年卷 / 文献 / 课程具体要求 / 其他。\n"
    "2. summary 用不超过 30 字的中文说清「这是什么资料、覆盖什么内容」。\n"
    "3. keywords 给 3-5 个最能代表内容的知识点词，保留英文原词。\n"
    "4. course_code 填内容里出现的课程代码（如 CPT203、BUS102）；没有就填空字符串。\n"
)


def analyze_material(material_id: str, texts: list | None = None) -> dict | None:
    """入库后一次性 AI 分析：性质标签 / 一句话摘要 / 关键词 / 课程代码提示。

    - 每份资料只调用一次（ai_analyzed 落库，不重复花钱）
    - 人工改过标签的（tag_locked）不会被覆盖
    - 任何失败都返回 None，绝不影响资料本身的可用性
    """
    try:
        cfg = load_config()
        if not cfg.get("api_key"):
            return None
        mat = store.get_material(material_id)
        if not mat or mat.get("ai_analyzed"):
            return None
        sample = pick_sample(texts if texts is not None else store.material_sample_texts(material_id))
        if len(sample.strip()) < 50:
            return None
        prompt = (ANALYZE_PROMPT
                  + f"【文件名】{mat['orig_name']}\n【内容片段】\n{sample}")
        resp = _client().chat.completions.create(
            model=cfg["model"],
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=320,
            response_format={"type": "json_object"},
        )
        data = json.loads(resp.choices[0].message.content or "{}")
        tag = str(data.get("tag") or "").strip()
        if tag not in AI_TAGS:
            tag = ""
        keywords = [str(k).strip() for k in (data.get("keywords") or []) if str(k).strip()][:6]
        code = re.sub(r"[^A-Za-z0-9]", "", str(data.get("course_code") or ""))[:12].upper()
        fields = {
            "summary": str(data.get("summary") or "").strip()[:120],
            "keywords": ",".join(keywords),
            "ai_course": code,
            "ai_analyzed": 1,
        }
        if tag and not mat.get("tag_locked"):
            fields["tag"] = tag
        store.update_material(material_id, **fields)
        return fields
    except Exception as e:  # noqa: BLE001
        print(f"[analyze] {material_id} 分析失败：{e}")
        return None


# ---------- 检索 ----------

# 常见 CS 术语中英对照：中文提问时补出英文写法，让词面信号也能命中英文资料
_TERM_MAP = {
    # —— 数据库 ——
    "外键": "foreign key", "主键": "primary key", "候选键": "candidate key",
    "范式": "normal form", "索引": "index", "事务": "transaction",
    "视图": "view", "触发器": "trigger", "存储过程": "stored procedure",
    "游标": "cursor", "元组": "tuple", "属性": "attribute", "关系": "relation",
    "连接": "join", "查询": "query", "数据库": "database",
    # —— 通用 ——
    "进程": "process", "线程": "thread", "死锁": "deadlock", "并发": "concurrency",
    "缓存": "cache", "内存": "memory", "指针": "pointer", "数组": "array",
    "链表": "linked list", "栈": "stack", "队列": "queue", "哈希": "hash",
    "二叉树": "binary tree", "递归": "recursion", "编译": "compile",
    "算法": "algorithm", "操作系统": "operating system",
    # —— 计算机组成 / 体系结构（CSI 教材语言）——
    "指令": "instruction", "指令集": "instruction set", "指令周期": "instruction cycle",
    "操作码": "opcode", "操作数": "operand", "寻址方式": "addressing mode",
    "寄存器": "register", "寄存器堆": "register file", "程序计数器": "program counter",
    "数据通路": "datapath", "控制单元": "control unit", "算术逻辑单元": "arithmetic logic unit",
    "微程序": "microprogram", "微指令": "microinstruction", "微架构": "microarchitecture",
    "时钟周期": "clock cycle", "总线": "bus", "仲裁": "arbitration",
    # 流水线（含 hazard 一族——实测缺这些词时中文提问完全匹配不上英文教材。
    # 注意「冒险」映射到三个词：这本教材主要用 dependence，hazard 只是顺带一提，
    # 只映射 hazard 会漏掉真正讲 RAW/WAR 依赖的那几页）
    "流水线": "pipeline", "冒险": "hazard dependence stall", "冲突": "conflict hazard",
    "依赖": "dependence", "停顿": "stall",
    "前递": "forwarding", "旁路": "bypassing", "分支预测": "branch prediction",
    "数据相关": "data dependence", "控制相关": "control dependence",
    "超标量": "superscalar", "乱序执行": "out-of-order", "并行": "parallelism",
    "多核": "multicore",
    # 存储层次
    "命中": "hit", "未命中": "miss", "缓存行": "cache line",
    "写回": "write-back", "写直达": "write-through", "一致性": "coherence",
    "虚拟内存": "virtual memory", "页表": "page table", "页错误": "page fault",
    "快表": "translation lookaside buffer", "主存": "primary memory",
    "只读存储器": "read only memory", "随机存取": "random access",
    # 中断 / IO
    "中断": "interrupt", "异常": "exception", "直接内存访问": "direct memory access",
    "输入输出": "input output",
    # 语言层
    "汇编": "assembly", "汇编器": "assembler", "链接器": "linker", "装载器": "loader",
    "编译器": "compiler", "解释器": "interpreter", "过程调用": "procedure call",
    # 数值
    "二进制": "binary", "补码": "two's complement", "浮点": "floating point",
    "溢出": "overflow", "布尔": "boolean", "逻辑门": "logic gate",
}

VEC_WEIGHT = 0.72      # 向量分权重（语义相近）
KW_WEIGHT = 0.28       # 关键词分权重（术语精确命中）
KW_CANDIDATES = 200    # 先按向量粗筛这么多，再算关键词分（避免对全库做字符串匹配）


def _keyword_tokens(question: str) -> set[str]:
    """把问题切成用于词面匹配的 token。

    只收有区分度的：英文 3 字母以上的词、短中文串（≤6 字，多半是术语）、
    以及 _TERM_MAP 补出的英文写法。

    **不再收中文 2-gram**：原来收了，一个中文问题能产出几十个「有哪 / 些冒」
    这类噪声 token，分母被稀释，真正的术语命中（hazard / pipeline）只值 0.05 分，
    关键词这一路几乎等于失效。
    """
    tokens = set(re.findall(r"[a-zA-Z]{3,}", question.lower()))
    for seg in re.findall(r"[\u4e00-\u9fff]+", question):
        if 2 <= len(seg) <= 6:          # 长中文串是自然语言句子，不是术语
            tokens.add(seg)
    for zh, en in _TERM_MAP.items():
        if zh in question:
            tokens.update(en.split())   # 一个中文词可对应多个英文同义词
    return tokens


def _expand_query(question: str) -> str:
    """检索 query 扩展：把中文术语对应的英文一并送进 embedding。

    实测：「流水线的 hazard 有哪些」这种中文提问，对英文教材的向量分只有
    0.24–0.35，落在噪声区 —— 命中的是「三态缓冲器」「浮点溢出」这种完全无关的段落，
    模型只能回答「资料里没找到」。补上 pipeline / hazard / stall 等英文术语后，
    向量才能落到真正讲它们的那些页上。
    """
    ens = sorted({en for zh, en in _TERM_MAP.items() if zh in question})
    if not ens:
        return question
    return question + "\n" + " ".join(ens)


_CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
           "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


def _material_hint(question: str, course_id: str) -> set:
    """认出问题里点名的资料（「讲 L01 的重点」「lab2 讲什么」）。

    为什么单独做这一步：`L01` 只是**文件名前缀**，正文里根本不存在这个字符串。
    语义检索会把它当噪声，命中一堆无关内容后判定「资料里没有」—— 而这是学生
    最自然的提问方式，实测这类问题全部被拒答。

    策略：从问题里抽出资料编号（L01 / Lab2 / Lesson 3 / 第三讲），再到文件名里
    找对应。命中资料 ≤2 份才限定范围（1 份是点名，2 份多半是 pdf+docx 同源）；
    超过 2 份视为泛指，退回普通检索，避免把范围搞错。
    """
    if not question:
        return set()

    # 「L01」和「Lab01」必须分开收：正则里 l|lab 会互相回溯，
    # 混在一起的结果是问 L01 也把 Lab01 那份资料匹配进来（实测踩到）。
    lecture_nums, lab_nums = set(), set()
    for m in re.finditer(r"(?<![a-z])lab\s*0*(\d{1,2})(?![0-9])", question, re.I):
        lab_nums.add(int(m.group(1)))
    for m in re.finditer(r"(?<![a-z])l\s*0*(\d{1,2})(?![0-9])", question, re.I):
        lecture_nums.add(int(m.group(1)))
    for m in re.finditer(r"\b(?:lesson|lecture)\s*0*(\d{1,2})(?![0-9])", question, re.I):
        lecture_nums.add(int(m.group(1)))
    # 中文序数：第一讲 / 第 3 节 / 第二课 → 归到 lecture 组。
    # 不处理「章」——那多半指教材章节，chunk 没有章节元数据，硬匹配会指错。
    for m in re.finditer(r"第\s*([一二三四五六七八九十]|\d{1,2})\s*(?:讲|节|课)", question):
        v = m.group(1)
        lecture_nums.add(int(v) if v.isdigit() else _CN_NUM.get(v, 0))
    lecture_nums.discard(0)
    lab_nums.discard(0)
    if not lecture_nums and not lab_nums:
        return set()

    hits = set()
    for m in store.list_materials(course_id):
        name = (m.get("orig_name") or "").lower()
        if any(re.search(rf"(?<![a-z])(?:l|lesson|lecture)\s*0*{n}(?![0-9])", name)
               for n in lecture_nums):
            hits.add(m["id"])
            continue
        if any(re.search(rf"(?<![a-z])lab\s*0*{n}(?![0-9])", name) for n in lab_nums):
            hits.add(m["id"])
    return hits if len(hits) <= 2 else set()


def _keyword_score(tokens: set[str], text: str) -> float:
    """词面重合度 0~1。向量检索对精确术语（FOREIGN KEY、3NF）不够敏感，由这块补。"""
    if not tokens:
        return 0.0
    low = text.lower()
    return sum(1 for t in tokens if t in low) / len(tokens)


def retrieve(course_id: str, question: str, cross_course: bool = False) -> list[dict]:
    """混合检索：向量语义相似度 + 词面重合度。

    - 向量分负责「换了说法也能找到」
    - 关键词分负责「术语精确命中」，中文提问靠 _TERM_MAP 补出英文写法

    cross_course=True 时跨全部课程检索（「允许外部资料」模式）。
    """
    cfg = load_config()
    qvec = embed_texts([_expand_query(question)])[0]
    rows = store.all_chunks_with_vectors("" if cross_course else course_id)
    if not rows:
        return []

    # 用户在问题里点名了某份资料（「讲 L01 的重点」）→ 直接把检索范围收到那份资料。
    # 「L01」在正文里不存在，不收范围的话语义检索命中不了它，只能拒答。
    # 该资料分块太少（<5）时不收，免得检索不到任何东西。
    if not cross_course:
        hint = _material_hint(question, course_id)
        if hint:
            scoped = [r for r in rows if r["material_id"] in hint]
            if len(scoped) >= 5:
                rows = scoped

    mat = np.array(
        [np.frombuffer(r["embedding"], dtype=np.float32) for r in rows]
    )
    sims = mat @ qvec

    # 先按向量粗筛，再对候选算关键词分 —— 避免对全库 13000+ 段做字符串匹配
    order = np.argsort(-sims)[:KW_CANDIDATES]
    tokens = _keyword_tokens(question)
    scored = []
    for idx in order:
        vs = float(sims[idx])
        kw = _keyword_score(tokens, rows[idx]["text"])
        scored.append((idx, vs * VEC_WEIGHT + kw * KW_WEIGHT, vs, kw))
    scored.sort(key=lambda x: -x[1])

    results = []
    seen_pages = set()
    for idx, score, vs, kw in scored:
        if score < cfg["threshold"]:
            continue
        r = rows[idx]
        # 同页只取最高分的一条。滑窗把一页切成多块、相邻块高度相似，
        # 不去重的话 top-k 会全落在同一页（实测出现过 5 条里 2 条同页），
        # 等于把检索名额浪费在重复内容上。
        page_key = (r["material_id"], r["page"])
        if page_key in seen_pages:
            continue
        seen_pages.add(page_key)
        results.append(
            {
                "material_id": r["material_id"],
                "orig_name": r["orig_name"],
                "page": r["page"],
                "ord": int(r.get("ord") or 0),
                "ext": r.get("ext") or "pdf",
                "course_code": r.get("course_code") or "",
                "text": r["text"],
                "score": round(score, 3),
                "vec_score": round(vs, 3),
                "kw_score": round(kw, 3),
            }
        )
        if len(results) >= cfg["top_k"] * 2:
            break
    # 多取一倍候选再扩展合并：合并相邻窗口后条目会变少，靠候选数补回来
    return _expand_context(results, limit=cfg["top_k"])


CONTEXT_NEIGHBORS = 1       # 命中块前后各带几块（1 → 约 3 块拼成完整一段）
CONTEXT_MAX_CHARS = 16000   # 扩展后总字数上限，防止把整章塞进上下文


def _stitch(texts: list) -> str:
    """把滑窗切出来的相邻块拼回去，**去掉重叠**。

    切块参数是 600 字 / 重叠 100 字，直接拼接会出现重复的 100 字。
    这里逐块找「上一段结尾 == 这一段开头」的最长重叠并裁掉。
    """
    if not texts:
        return ""
    out = texts[0]
    for t in texts[1:]:
        max_k = min(len(out), len(t), int(CHUNK_OVERLAP * 1.5))
        cut = 0
        for k in range(max_k, 0, -1):
            if out.endswith(t[:k]):
                cut = k
                break
        out += t[cut:]
    return out


def _expand_context(results: list, limit: int = 5) -> list:
    """把命中的「碎片」补成完整段落。

    实测问题：教材按 600 字滑窗切块，单块常从句子中间开始
    （如 "e of feed- ing instructions into the pip"）到句子中间结束。
    AI 收到的是一堆半句话，自然答不出教材里的详细解释 —— 用户会以为是
    「完全没检索到教材」，其实是「检索到了但读不懂」。

    做法：每个命中点把同资料内 ord 前后各 CONTEXT_NEIGHBORS 块一起取回、
    按 ord 拼成完整一段（裁掉滑窗重叠）。窗口**相邻或重叠**都合并 ——
    实测 ord 521 与 524 两个命中分属两段但同在一页，不合并会让同一页
    在结果里出现两次，既占名额又像重复。
    """
    if not results:
        return results

    # ① 合并同一资料内相邻 / 重叠的 ord 窗口
    windows: list[dict] = []
    for r in results:
        mid, o = r["material_id"], int(r.get("ord") or 0)
        lo, hi = max(0, o - CONTEXT_NEIGHBORS), o + CONTEXT_NEIGHBORS
        merged = False
        for w in windows:
            if w["material_id"] == mid and lo <= w["hi"] + 1 and hi >= w["lo"] - 1:
                w["lo"], w["hi"] = min(w["lo"], lo), max(w["hi"], hi)
                merged = True
                break
        if not merged:
            windows.append({"material_id": mid, "lo": lo, "hi": hi, "best": r})

    # ② 按「窗口里最好的那条命中分」排序，取前 limit 个
    windows.sort(key=lambda w: -w["best"]["score"])

    # ③ 取回窗口内全部块并拼成一段
    out, total = [], 0
    for w in windows[:limit]:
        chunks = store.chunks_by_ord_range(w["material_id"], w["lo"], w["hi"])
        if not chunks:
            continue
        text = _stitch([c["text"] for c in chunks])
        if not text:
            continue
        if total + len(text) > CONTEXT_MAX_CHARS and out:
            break                      # 超预算就停，保留已拿到的
        item = dict(w["best"])
        item["text"] = text
        item["page"] = chunks[0]["page"]
        item["page_to"] = chunks[-1]["page"]
        item["expanded"] = len(chunks)
        out.append(item)
        total += len(text)
    return out or results


# ---------- DeepSeek 生成 ----------

STRICT_SYSTEM = (
    "你是一位严谨的课程学习助手。规则：\n"
    "1. 只依据提供的【资料片段】回答问题，禁止使用资料之外的任何知识。\n"
    "2. 回答中引用资料时，必须在句子后面标注来源编号，格式如 [1]、[2]。\n"
    "3. **术语对应**：如果资料讲的是同一个概念，只是用的术语与提问不同"
    "（例如提问用「流水线 hazard」，而资料用的是 dependence / stall；"
    "或提问用中文译名，资料用英文原词），要按资料内容正常回答，"
    "并在开头用一句话点明术语对应关系，**不要因为字面上没有那个词就判定「没找到」**。\n"
    "4. 只有当资料确实**没有涉及这个主题**时，才回复一句话："
    "「资料库中未找到足够相关的内容，无法回答该问题。」并简短说明资料里大概涉及什么主题。"
    "不要猜测，不要编造。\n"
    "5. 用简体中文回答，条理清晰，适合学习复习场景。"
)

# 「允许外部资料」模式：可以结合自有知识，但必须与资料内容明确区分，且不得伪造引用编号
EXTERNAL_SYSTEM = (
    "你是一位严谨的课程学习助手。规则：\n"
    "1. 优先依据提供的【资料片段】回答，引用资料时在句后标注来源编号，格式如 [1]、[2]。\n"
    "2. 资料片段不足以回答时，可以结合你自己的知识补充，但必须让用户一眼看出哪些不是资料里的：\n"
    "   先用一句话说明「资料中没有相关内容」，再以「以下是资料之外的补充」起头。\n"
    "3. 补充内容严禁标注 [n] 来源编号，也不得声称它来自资料。\n"
    "4. 用简体中文回答，条理清晰，适合学习复习场景。"
)

GUIDE_PROMPT = (
    "请基于下面这门课程资料的片段，为我做一次「课程导学」，输出以下三部分：\n"
    "## 一、资料覆盖的主题\n列出资料中能看出的主题/知识点清单\n"
    "## 二、各主题重点\n每个主题用一两句话概括核心内容\n"
    "## 三、建议我先弄懂的问题\n给出 3 个适合我先问你的问题（附编号）\n"
    "只使用资料中的内容，引用时标注 [n]。"
)


def _build_context(results: list[dict]) -> str:
    parts = []
    for i, r in enumerate(results, 1):
        tag = f"{r['course_code']} · " if r.get("course_code") else ""
        parts.append(f"[{i}] {tag}{r['orig_name']} · 第{r['page']}页\n{r['text'][:800]}")
    return "\n\n".join(parts)


def _client():
    """构造 DeepSeek 客户端。

    timeout 必须显式调大：openai SDK 默认的 connect 超时只有 5 秒。
    在网络需要绕代理 / 跨境线路的情况下，DNS + TCP + TLS 握手很容易超过 5 秒，
    表现出来的就是 APIConnectionError: Connection error.（实测踩过这个坑）
    """
    cfg = load_config()
    if not cfg.get("api_key"):
        raise RuntimeError("尚未配置 DeepSeek API Key，请在右上角「设置」中填写")
    return OpenAI(
        api_key=cfg["api_key"],
        base_url=cfg["base_url"],
        timeout=httpx.Timeout(connect=20.0, read=300.0, write=60.0, pool=20.0),
        max_retries=2,
    )


def stream_chat(course_id: str, question: str, mode: str = "ask",
                allow_external: bool = False) -> Iterator[dict]:
    """流式生成回答。yield {"type": "citations"/"delta"/"done"/"error", ...}

    allow_external=True（「允许外部资料」）：检索范围扩到全部课程，
    且允许模型在资料不足时用自有知识补充，但必须在回答里把资料内外区分清楚。
    """
    try:
        if mode == "guide":
            results = _guide_context(course_id)
            user_content = GUIDE_PROMPT + "\n\n【资料片段】\n" + _build_context(results)
        else:
            results = retrieve(course_id, question, cross_course=allow_external)
            if not results:
                if not allow_external:
                    yield {
                        "type": "delta",
                        "text": "资料库中未找到足够相关的内容，无法回答该问题。\n\n"
                                "（已尝试在当前课程的所有资料中检索，没有片段达到相关度要求。"
                                "可以换个问法，或确认相关资料已上传到本课程；"
                                "也可以打开「允许外部资料」再问一次。）",
                    }
                    yield {"type": "done", "citations": []}
                    return
                # 外部资料模式：检索为空也继续，让模型用自有知识回答
                user_content = (
                    "【资料片段】\n（本次检索没有找到相关片段）\n\n"
                    f"【问题】\n{question}"
                )
            else:
                user_content = (
                    f"【资料片段】\n{_build_context(results)}\n\n【问题】\n{question}"
                )

        store.add_message(course_id, "user", question)
        messages = [
            {"role": "system", "content": EXTERNAL_SYSTEM if allow_external else STRICT_SYSTEM},
            {"role": "user", "content": user_content},
        ]
        cfg = load_config()
        client = _client()
        stream = client.chat.completions.create(
            model=cfg["model"], messages=messages, stream=True, temperature=0.3,
        )
        full = []
        for event in stream:
            delta = event.choices[0].delta.content or ""
            if delta:
                full.append(delta)
                yield {"type": "delta", "text": delta}
        text = "".join(full)
        store.add_message(course_id, "assistant", text)
        yield {"type": "done", "citations": [
            {"n": i + 1, "orig_name": r["orig_name"], "page": r["page"],
             "material_id": r["material_id"], "ext": r.get("ext") or "pdf"}
            for i, r in enumerate(results)
        ]}
    except Exception as e:  # noqa: BLE001
        yield {"type": "error", "message": str(e)}


# ---------- 出题 ----------

QUIZ_KIND_LABEL = {"choice": "四选一选择题", "short": "简答题", "mixed": "混合题型（选择+简答）"}


# ---------- 沉浸模式逐页注释 ----------

def generate_page_notes_batch(course_name: str, pages: list, lang: str = "zh") -> dict:
    """一次调用为多页生成注释，返回 {page_no: note}。

    lang: zh / en / es，默认中文（中文分支的提示词保持原样，
    已有上千条注释就是它生成的，不要动）。
    pages: [(page_no, page_text), ...]。模型输出按页标记分节解析，
    解析失败的页不会出现在返回值里（调用方下次会自动重试）。"""
    import re as _re
    page_list = "、".join(str(p[0]) for p in pages)
    body = "\n\n".join(
        f"【第 {pno} 页文字】\n{text[:2500]}" for pno, text in pages
    )
    if lang == "es":
        prompt = (
            f"Eres el asistente de la asignatura「{course_name}」。"
            f"Abajo están los textos extraídos de las páginas {page_list} de la misma presentación PDF"
            "（puede faltar texto por el formato; interpreta lo que haya）。\n"
            "Genera una nota de clase **en español** para cada página. "
            "Cada página debe seguir exactamente esta estructura:\n"
            "Primera línea, sola: [Página X]（X es el número de página）\n"
            "Luego: [Idea principal]\nUna o dos frases en español sobre de qué trata la página.\n"
            "[Puntos clave]\nDesarrolla los puntos en frases completas en español, numeradas 1. 2. 3.; "
            "si la página no tiene puntos de texto escribe: Esta página no tiene puntos de texto.\n"
            "[Términos]\nEnumera solo los términos en inglés que aparezcan realmente en el texto, "
            "uno por línea: • término en inglés: explicación en español; "
            "si no hay, escribe: Esta página no tiene términos en inglés.\n"
            "No pongas separadores entre páginas, encadena las páginas directamente, "
            "no escribas nada más.\n\n"
            f"{body}"
        )
    elif lang == "en":
        prompt = (
            f"You are the teaching assistant for「{course_name}」. "
            f"Below are the texts extracted from pages {page_list} of the same lecture PDF "
            "(text may be incomplete due to layout; work with what is there).\n"
            "Write a lecture note **in English** for each page. "
            "Every page must follow exactly this structure:\n"
            "First line, alone: [Page X] (X is the page number)\n"
            "Then: [Main idea]\nOne or two sentences in English on what the page is about.\n"
            "[Key points]\nExpand the points into complete English sentences, numbered 1. 2. 3.; "
            "if the page has no text points write: This page has no text points.\n"
            "[Terms]\nList only the English terms that actually appear in the text, "
            "one per line: • term: explanation in English; "
            "if none, write: This page has no terms.\n"
            "No separators between pages, keep the pages consecutive, output nothing else.\n\n"
            f"{body}"
        )
    else:
        prompt = (
            f"你是课程「{course_name}」的助教。下面是同一份上课课件 PDF 中第 {page_list} 页提取出的文字"
            "（可能因排版提取不完整，按能提取的内容理解）。\n"
            "请为其中每一页分别生成上课注释。每一页都必须严格按以下结构输出：\n"
            "第一行单独写：【第 X 页】（X 为该页页码）\n"
            "然后：【本页主旨】\n用一两句中文说明这页在讲什么。\n"
            "【要点展开】\n把该页要点展开成完整、能听懂的中文句子，用 1. 2. 3. 编号；"
            "该页没有文字要点就写：本页无文字要点（可能是图表页）。\n"
            "【英文名词解释】\n只列该页文字中实际出现的英文术语，每条一行：• 英文原词：中文解释；"
            "没有就写：本页无英文术语。\n"
            "页与页之间不要加分隔符，直接连续输出，不要输出任何其他内容。\n\n"
            f"{body}"
        )
    cfg = load_config()
    client = _client()
    # 输出预算：每页注释约 900 token，再加余量。原来固定 2400 在 8 页批次会被截断，
    # 最后一页就存成半截内容；这里按实际页数给足，上限 8000。
    out_tokens = min(8000, max(1200, len(pages) * 900 + 400))
    resp = client.chat.completions.create(
        model=cfg["model"],
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
        max_tokens=out_tokens,
    )
    choice = resp.choices[0]
    content = choice.message.content or ""
    truncated = getattr(choice, "finish_reason", "") == "length"
    # 按页标记切分解析。标记随语言变化：中文【第 X 页】/ 英文 [Page X] / 西语 [Página X]
    out = {}
    matches = list(_re.finditer(
        r"【第\s*(\d+)\s*页】|\[\s*Page\s*(\d+)\s*\]|\[\s*Página\s*(\d+)\s*\]",
        content, _re.I))

    def _mark_no(m):
        return int(next(g for g in m.groups() if g))

    # 被截断时最后一段大概率是半截的，丢掉它，让调用方下一轮重新生成
    if truncated and matches:
        print(f"[notes] 输出触顶被截断，丢弃最后一段 p{_mark_no(matches[-1])}")
        matches = matches[:-1]
    for k, m in enumerate(matches):
        pno = _mark_no(m)
        seg_end = matches[k + 1].start() if k + 1 < len(matches) else len(content)
        seg = content[m.end():seg_end].strip()
        if seg and pno in {p[0] for p in pages}:
            out[pno] = seg
    return out


# ---------- HandBook 扫描 ----------

def docx_to_html_cached(path: str) -> str:
    """docx 转 HTML，带磁盘缓存（mammoth 转换不便宜，同一份文档只转一次）。

    缓存失效条件：源文件 mtime 或大小变化（重传 HandBook 会自动重建）。
    """
    import mammoth
    cache_dir = os.path.join(os.path.dirname(path), ".htmlcache")
    os.makedirs(cache_dir, exist_ok=True)
    st = os.stat(path)
    key = f"{os.path.basename(path)}.{int(st.st_mtime)}.{st.st_size}.html"
    cache_path = os.path.join(cache_dir, key)
    if os.path.exists(cache_path):
        with open(cache_path, "r", encoding="utf-8") as f:
            return f.read()
    with open(path, "rb") as f:
        html = mammoth.convert_to_html(f).value
    with open(cache_path, "w", encoding="utf-8") as f:
        f.write(html)
    # 清掉该文件的旧缓存版本，避免堆积
    for old_file in os.listdir(cache_dir):
        if old_file.startswith(os.path.basename(path) + ".") and old_file != key:
            try:
                os.remove(os.path.join(cache_dir, old_file))
            except OSError:
                pass
    return html


# ---------- HandBook 日期解析 ----------
# HandBook 里的日期写法杂（13/Dec/2026、13/12/2026、2026-12-13、Dec 13, 2026），
# 且常带时刻（13/Dec/2026 23:59）。**换算一律在 Python 侧做，不交给模型**——
# 让模型自行换算是日期写错的直接来源（实测编出过原文根本不存在的年份）。

_MONTH_NAMES = {
    m: i for i, m in enumerate(
        ["jan", "feb", "mar", "apr", "may", "jun",
         "jul", "aug", "sep", "oct", "nov", "dec"], 1)
}


def _month_num(token: str):
    """'Dec' / 'December' / '12' → 12；认不出返回 None。"""
    t = (token or "").strip().lower().rstrip(".")
    if t[:3] in _MONTH_NAMES:
        return _MONTH_NAMES[t[:3]]
    if t.isdigit() and 1 <= int(t) <= 12:
        return int(t)
    return None


def parse_date_text(raw: str):
    """日期文字 → 'YYYY-MM-DD' 或 'YYYY-MM-DDTHH:MM'；认不出返回 None。

    刻意只认「明确的年月日」，不做任何推算（比如"只在手册里出现过的年份"这种）。
    认不出就让调用方丢弃这条，而不是猜一个日期出来。
    """
    if not raw:
        return None
    s = str(raw).strip()
    day = mon = year = None

    m = re.search(r"\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b", s)          # 2026-12-13
    if m:
        year, mon, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
    else:
        m = re.search(r"\b(\d{1,2})[-/.](\d{1,2}|[A-Za-z]{3,9})[-/.](\d{4})\b",
                      s)                                                   # 13/Dec/2026、13/12/2026
        if m:
            day, year, mon = int(m.group(1)), int(m.group(3)), _month_num(m.group(2))
        else:
            m = re.search(r"\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b",
                          s)                                               # Dec 13, 2026
            if m:
                mon, day, year = _month_num(m.group(1)), int(m.group(2)), int(m.group(3))
            else:
                m = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b",
                              s)                                           # 13 December 2026
                if m:
                    day, mon, year = int(m.group(1)), _month_num(m.group(2)), int(m.group(3))

    if not (day and mon and year):
        return None
    if not (1 <= day <= 31 and 1 <= mon <= 12 and 1990 <= year <= 2100):
        return None

    hh = mm = None
    t = re.search(r"\b(\d{1,2}):(\d{2})\b", s)
    if t and int(t.group(1)) <= 23 and int(t.group(2)) <= 59:
        hh, mm = int(t.group(1)), int(t.group(2))

    base = f"{year:04d}-{mon:02d}-{day:02d}"
    return f"{base}T{hh:02d}:{mm:02d}" if hh is not None else base


# 扫原文日期用的模式（覆盖 parse_date_text 支持的全部写法）
_DATE_SCAN_RE = re.compile(
    r"\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b"
    r"|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\b"
    r"|\b\d{1,2}[-/.][A-Za-z]{3,9}[-/.]\d{4}\b"
    r"|\b[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b"
    r"|\b\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4}\b"
)


def collect_dates(text: str) -> set:
    """扫出原文里**真实存在**的日期（YYYY-MM-DD）集合，用作防幻觉白名单。"""
    out = set()
    for m in _DATE_SCAN_RE.finditer(text or ""):
        iso = parse_date_text(m.group(0))
        if iso:
            out.add(iso[:10])
    return out


def _irrelevant_spans(text: str) -> list:
    """原文里「不是课程 DDL」的字符区间：Cut-off Date 行、Resit Assessment 区块。

    注意这里返回的是**区间**而不是日期值 —— 同一个日期可能既出现在补考区块里，
    又（作为真正的 Due Date）出现在主考核表格里（ISA104 的 09/Oct/2026 就是如此）。
    按日期值剔除会连带把合法的那次也删掉，所以必须按位置判断。
    """
    spans = []
    for m in re.finditer(r"Cut-?off\s*Date[^\n]{0,120}", text or "", re.I):
        spans.append((m.start(), m.end()))
    for m in re.finditer(r"Resit\s+Assessment", text or "", re.I):
        end = m.end() + 1200
        stop = re.search(r"SECTION\s+[A-Z]", text[m.end():end], re.I)
        if stop:
            end = m.end() + stop.start()
        spans.append((m.start(), end))
    return spans


def usable_dates(text: str) -> set:
    """可作为 DDL 的日期集合：原文里真实存在，且**至少有一次合法出现**。

    作为防幻觉白名单用 —— 模型给的日期必须在这里面，否则判定为编造。
    """
    spans = _irrelevant_spans(text)
    out = set()
    for m in _DATE_SCAN_RE.finditer(text or ""):
        iso = parse_date_text(m.group(0))
        if not iso:
            continue
        if any(s <= m.start() < e for s, e in spans):
            continue                       # 落在无关区块内的这一次出现，忽略
        out.add(iso[:10])
    return out


def scan_handbook(path: str, ext: str = "pdf") -> dict:
    """AI 扫描 HandBook，一次调用同时提取两类信息：

    - components：考核构成（名称 + 权重%）
    - ddls：重要时间节点（事项 + 截止时间，取自表格的 Due Date 列；
      无时刻为 YYYY-MM-DD，有时刻为 YYYY-MM-DDTHH:MM）
    - skipped：被判为不可用而丢弃的条目（补考区块 / 日期编造 / 无法解析），供排查

    一次调用拿两份结果，避免为了扫 DDL 再花一次额度。
    只做预填，用户可完全手工修改。
    返回 {"components": [...], "ddls": [...], "skipped": [...]}
    """
    if ext == "docx":
        text = "\n".join(parse_docx(path))
    else:
        text = "\n".join(t for _, t in parse_pdf(path))
    text = text[:15000]
    if len(text.strip()) < 50:
        raise ValueError("HandBook 中没有可提取的文字")

    prompt = (
        "下面是一份大学课程/项目手册（HandBook）的文本。请提取两类信息：\n"
        "A. 考核构成：找到 Assessment / Marking Scheme 部分，提取每个组成部分的 "
        "name（名称，保留英文原名）和 weight（占总分的百分比数字）。\n"
        "B. 重要时间节点（DDL）：只从**考核表格**里取，不要从规章制度段落里取。"
        "这类表格的表头通常是 Assessment Task / Weighting / Release Date / Due Date，"
        "**只取 Due Date 列（截止日），绝对不要用 Release Date（发布日）**。\n"
        "   · 每条提取 title（事项名称）与 due_raw（**原样照抄手册中的日期文字**，"
        '例如 "13/Dec/2026 23:59"；**不要换算成 YYYY-MM-DD、不要补全、不要推算**）。\n'
        "   · 每条还要标 section：位于主考核表格内填 \"main\"；位于 Resit Assessment"
        "（补考）区块内填 \"resit\"；其他位置填 \"other\"。\n"
        "   · 表格里日期写成 \"/\" 或留空的行表示没有日期，请直接跳过。\n"
        "   · 重要规律：表格文本里每行日期的排列是「先 Release Date、后 Due Date」，"
        "同一行出现两个日期时**后一个才是 Due Date**，取它；只出现一个日期时就用它。\n"
        "   · 忽略 Cut-off Date（选课/退课截止日）。\n"
        "要求：\n"
        "1. 忽略得分、等级说明等其他信息；某一类找不到就返回空数组。\n"
        "2. weight 是 0-100 的数字（不带百分号）。\n"
        "3. 各考核项的权重之和应当等于 100%。表格里若有 Total / Overall / 合计 / 总计 "
        "这类**汇总行**，请忽略它，不要当成考核项。\n"
        '4. 只输出 JSON：{"components":[{"name":"Coursework 1","weight":30}],'
        '"ddls":[{"title":"Final Group Project","due_raw":"13/Dec/2026 23:59","section":"main"}]}\n\n'
        f"【手册文本】\n{text}"
    )
    import json as _json
    cfg = load_config()
    client = _client()
    resp = client.chat.completions.create(
        model=cfg["model"],
        messages=[{"role": "user", "content": prompt}],
        temperature=0.1,
        response_format={"type": "json_object"},
    )
    data = _json.loads(resp.choices[0].message.content)

    out = []
    for comp in data.get("components", [])[:12]:
        try:
            w = float(comp.get("weight"))
        except (TypeError, ValueError):
            continue
        if w <= 0:
            continue
        out.append({"name": str(comp.get("name") or "Component"), "weight": w})

    # 汇总行兜底：HandBook 的表格常有一行「Total / Overall 100%」，模型偶尔会给它
    # 编个名字（实测出现过叫 "Exam" 的）混进考核项，表现是合计正好变成 200%，
    # 且其中恰有一条正好 100%。出现这种情况就剔除那一条。
    if len(out) > 1 and abs(sum(c["weight"] for c in out) - 200) < 0.5:
        hundred = [c for c in out if abs(c["weight"] - 100) < 0.5]
        if len(hundred) == 1:
            out.remove(hundred[0])

    # DDL：模型只负责「挑出哪条、原样引用日期文字」，换算与校验全部在代码里做。
    # 三道门：① 补考区块剔除；② 日期用 parse_date_text 解析（模型不参与换算）；
    #         ③ 解析结果必须出现在原文日期白名单里，否则判定为编造并丢弃。
    known = usable_dates(text)
    ddls, skipped = [], []
    for d in data.get("ddls", [])[:30]:
        title = str(d.get("title") or "").strip()
        raw = str(d.get("due_raw") or d.get("due") or "").strip()
        section = str(d.get("section") or "main").strip().lower()
        if not title or not raw:
            continue
        if section == "resit":
            skipped.append(f"{title}｜补考区块，已跳过")
            continue
        iso = parse_date_text(raw)
        if not iso:
            skipped.append(f"{title}｜日期无法解析：{raw}")
            continue
        if iso[:10] not in known:
            skipped.append(f"{title}｜日期不在手册原文中：{raw}")
            continue
        ddls.append({"title": title, "due": iso, "due_raw": raw})

    return {"components": out, "ddls": ddls, "skipped": skipped}


# ---------- 知识点单元 ----------
# chunk 是检索单位，不是知识单位：滑窗切块为保证召回而设置重叠，相邻块往往是
# 同一段内容的延续。以 chunk 为出题单位会产出大量语义重复的碎片题，
# 也无法回答「这门课覆盖了多少」——因为 chunk 数量会随切块参数变化。
#
# 本项目资料是 PPT 导出的 PDF，**一页就是一个知识主题**，页是天然且稳定的边界。
# 于是按页聚合、超长页再按字数拆分。unit_key 只依赖「资料 + 页 + 段号」，
# 资料内容不变它就永远不变，覆盖率台账才能跨次累积。

MAX_UNIT_CHARS = 1500        # 单个知识点单元的字数上限（超长页按此拆分）
BATCH_MAX_UNITS = 6          # 全面覆盖时每批最多处理几个知识点
BATCH_CHAR_BUDGET = 7000     # 每批原文总量上限，控制单次请求的输入规模


def _unit_keys(material_id: str, page: int, chars: int) -> list:
    """一页拆成几个知识点单元、各自 key 是什么。

    这是 unit_key 的**唯一定义处** —— chrome 别处不要另写一份，
    覆盖率分子分母对不上就会显示成「练过却说没覆盖」。
    """
    if chars <= 0:
        return []                                   # 空页不成单元
    n = max(1, -(-chars // MAX_UNIT_CHARS))         # 向上取整
    if n == 1:
        return [f"{material_id}#p{page}"]
    return [f"{material_id}#p{page}#{k}" for k in range(n)]


def unit_keys_for(material_ids: list) -> list:
    """范围内全部知识点单元的 key。不读正文，覆盖率统计走这条轻量路径。"""
    keys = []
    for material_id, page, chars in store.chunk_sizes_for_materials(material_ids):
        keys.extend(_unit_keys(material_id, page, chars))
    return keys


def build_knowledge_units(material_ids: list) -> list:
    """把 chunk 按页聚合成知识点单元（出题的基本单位）。"""
    rows = store.chunks_for_materials(material_ids)
    if not rows:
        return []
    by_page, order = {}, []
    for r in rows:
        k = (r["material_id"], int(r["page"]))
        if k not in by_page:
            by_page[k] = []
            order.append(k)
        by_page[k].append(r)

    units = []
    for mid, page in order:
        chunks = sorted(by_page[(mid, page)], key=lambda x: int(x.get("ord") or 0))
        total = sum(len(c.get("text") or "") for c in chunks)
        keys = _unit_keys(mid, page, total)
        if not keys:
            continue
        text = "\n".join(c.get("text") or "" for c in chunks).strip()
        if not text:
            continue
        if len(keys) == 1:
            segs = [text]
        else:
            size = -(-total // len(keys))
            # 按 keys 的数量切，**不过滤空段** —— 段数必须与 unit_keys_for 完全一致
            segs = [text[i * size:(i + 1) * size] for i in range(len(keys))]
        head = chunks[0]
        for key, seg in zip(keys, segs):
            units.append({
                "unit_key": key,
                "material_id": mid,
                "orig_name": head.get("orig_name") or "",
                "ext": head.get("ext") or "pdf",
                "page": page,
                "text": seg,
            })
    return units


def _pack_units(units: list, max_units: int, char_budget: int) -> list:
    """按字数预算打包：短知识点多装、长的少装，避免一批里塞进整节内容。"""
    out, batch, used = [], [], 0
    for u in units:
        if batch and (len(batch) >= max_units or used + len(u["text"]) > char_budget):
            out.append(batch)
            batch, used = [], 0
        batch.append(u)
        used += len(u["text"])
    if batch:
        out.append(batch)
    return out


def _quiz_from_units(units: list, kind: str = "choice", temperature: float = 0.7) -> list:
    """给一批知识点单元，一次调用生成题目。

    单元直接作为 context 条目 —— refs 的编号就是单元编号，每道题据此回填
    unit_key，覆盖率才有依据。
    """
    if not units:
        return []
    parts = [f"[{i}] {u['orig_name']} · 第{u['page']}页\n{u['text']}"
             for i, u in enumerate(units, 1)]
    context = "\n\n".join(parts)
    prompt = (
        f"请严格基于下面的课程资料片段，**为每一个编号的片段各出 1 道题**"
        f"（共 {len(units)} 个片段，就出 {len(units)} 道题；"
        f"题型：{QUIZ_KIND_LABEL.get(kind, '选择题')}），用于帮助我复习。要求：\n"
        "1. 只能使用资料中出现过的知识点，禁止引入资料外的内容。\n"
        "2. 选择题给 4 个选项（A/B/C/D）；简答题 options 为空数组。\n"
        "3. answer 填正确选项字母（如 A）或简答参考答案；explanation 简要说明。\n"
        "4. **每道题都必须填 refs**，写它依据的片段编号，如 [2]（必填）。\n"
        '5. 只输出 JSON，格式：{"questions":[{"question":"...","options":["A...","B...","C...","D..."],'
        '"answer":"A","explanation":"...","refs":[1]}]}\n\n'
        f"【资料片段】\n{context}"
    )
    cfg = load_config()
    client = _client()
    resp = client.chat.completions.create(
        model=cfg["model"],
        messages=[{"role": "user", "content": prompt}],
        temperature=temperature,
        response_format={"type": "json_object"},
    )
    import json as _json
    data = _json.loads(resp.choices[0].message.content)
    qs = data.get("questions", [])
    out = []
    for idx, q in enumerate(qs[:len(units)]):
        refs = []
        for n in (q.get("refs") or []):
            if isinstance(n, int) and 1 <= n <= len(units):
                u = units[n - 1]
                refs.append({"n": n, "material_id": u["material_id"],
                             "orig_name": u["orig_name"], "page": u["page"],
                             "ext": u.get("ext") or "pdf"})
        # 归属知识点：取它引用的第一个片段；模型漏填 refs 时退回「按出题顺序对齐」
        if refs:
            owner = units[refs[0]["n"] - 1]
        elif len(qs) == len(units):
            owner = units[idx]
        else:
            owner = None
        out.append({
            "question": q.get("question", ""),
            "options": q.get("options") or [],
            "answer": q.get("answer", ""),
            "explanation": q.get("explanation", ""),
            "refs": refs,
            "unit_key": owner["unit_key"] if owner else "",
            "material_id": owner["material_id"] if owner else "",
            "page": owner["page"] if owner else 0,
        })
    return out


def generate_quiz(course_id: str, material_ids: list, num: int = 5, kind: str = "choice") -> dict:
    """练习模式出题：按知识点单元抽样，**优先抽还没出过题的**。

    这样日常练习本身就在推进覆盖率，而不是反复考同一批内容。
    返回 {questions, units_total, units_fresh}。
    """
    units = build_knowledge_units(material_ids)
    if not units:
        raise ValueError("所选范围内没有已解析成功的资料内容")
    import random
    covered = store.covered_unit_keys(course_id)
    fresh = [u for u in units if u["unit_key"] not in covered]
    picked = random.sample(fresh, min(num, len(fresh))) if fresh else []
    if len(picked) < num:                       # 新的不够，从已覆盖里补齐题量
        rest = [u for u in units if u["unit_key"] in covered]
        picked += random.sample(rest, min(num - len(picked), len(rest)))
    if not picked:
        picked = random.sample(units, min(num, len(units)))
    random.shuffle(picked)
    return {
        "questions": _quiz_from_units(picked, kind),
        "units_total": len(units),
        "units_fresh": len(fresh),
    }


def generate_quiz_full(course_id: str, material_ids: list, kind: str = "choice",
                       on_progress=None, max_batches: int = 40) -> dict:
    """全面覆盖出题：遍历范围内**所有未出过题**的知识点，分批生成。

    分批是这里的关键——一次调用处理一批知识点，调用次数从「单元数」压到
    「单元数 ÷ 每批个数」；否则一门课几百个知识点就是几百次请求。
    """
    units = build_knowledge_units(material_ids)
    if not units:
        raise ValueError("所选范围内没有已解析成功的资料内容")
    covered = store.covered_unit_keys(course_id)
    todo = [u for u in units if u["unit_key"] not in covered]
    batches = _pack_units(todo, BATCH_MAX_UNITS, BATCH_CHAR_BUDGET)
    run = batches[:max_batches]
    added = 0
    for i, batch in enumerate(run, 1):
        qs = _quiz_from_units(batch, kind)
        store.save_quiz_questions(course_id, qs)
        added += len(qs)
        if on_progress:
            on_progress(i, len(run), added)
    return {
        "total_units": len(units),
        "pending_units": len(todo),
        "batches": len(run),
        "truncated": len(batches) > len(run),
        "added": added,
    }


def coverage_report(course_id: str, material_ids: list = None,
                    batch_limit: int = 40, sec_per_batch: float = 12.0) -> dict:
    """覆盖率报告：总体进度 + 按资料明细 + 剩余工作量预估。

    material_ids 为空时按该课程全部「已解析成功」的资料统计。

    为什么要给工作量预估：一轮全面覆盖的规模可能差两个数量级 —— 几份课件
    约 200 个知识点（十几批就完事），而范围里混进一本千页教材就是几千个
    知识点、几百批、几小时。**在启动前把代价摊给用户看**，比让他点下去干等强。
    """
    if not material_ids:
        material_ids = [m["id"] for m in store.list_materials(course_id)
                        if m["status"] == "ready"]
    if not material_ids:
        return {"total": 0, "covered": 0, "pending": 0, "percent": 0.0,
                "batches": 0, "this_run_batches": 0, "eta_seconds": 0,
                "truncated": False, "by_material": []}

    per_mat_total: dict[str, int] = {}
    total = 0
    for mid, page, chars in store.chunk_sizes_for_materials(material_ids):
        n = len(_unit_keys(mid, page, chars))
        if not n:
            continue
        per_mat_total[mid] = per_mat_total.get(mid, 0) + n
        total += n

    covered_map = store.coverage_by_material(course_id)
    covered = sum(min(per_mat_total.get(mid, 0), n)
                  for mid, n in covered_map.items() if mid in per_mat_total)
    pending = max(0, total - covered)
    batches = -(-pending // BATCH_MAX_UNITS) if pending else 0     # 向上取整（下界估算）
    this_run = min(batches, batch_limit)

    names = {m["id"]: m["orig_name"] for m in store.list_materials(course_id)}
    by_material = [
        {"material_id": mid, "orig_name": names.get(mid, ""),
         "total": n, "covered": min(n, covered_map.get(mid, 0))}
        for mid, n in sorted(per_mat_total.items(), key=lambda x: -x[1])
    ]
    return {
        "total": total,
        "covered": covered,
        "pending": pending,
        "percent": round(covered * 100 / total, 1) if total else 0.0,
        "batches": batches,
        "this_run_batches": this_run,
        "eta_seconds": int(this_run * sec_per_batch),
        "truncated": batches > this_run,
        "by_material": by_material,
    }


def _guide_context(course_id: str, per_material: int = 6, max_chars: int = 12000) -> list[dict]:
    """导学模式：从每份资料取开头几块，拼出课程全貌。"""
    mats = store.list_materials(course_id)
    results = []
    total = 0
    for m in mats:
        rows = [r for r in store.all_chunks_with_vectors(course_id)
                if r["material_id"] == m["id"]]
        rows.sort(key=lambda r: (r["page"], 0))
        for r in rows[:per_material]:
            total += len(r["text"])
            results.append({
                "material_id": r["material_id"], "orig_name": r["orig_name"], "ext": r.get("ext") or "pdf",
                "page": r["page"], "text": r["text"], "score": 0,
            })
            if total > max_chars:
                return results
    return results
