"""SQLite 存储：课程 / 资料 / 分块 / 聊天记录。全部数据都在 data/ 目录下。"""
import json
import os
import re
import sqlite3
import time
import unicodedata
import uuid

from .config import DATA_DIR

DB_PATH = os.path.join(DATA_DIR, "study.db")


def fix_zip_name(name: str) -> str:
    """还原 zipfile 用 CP437 误解码出来的文件名。

    zip 条目没有 UTF-8 标志位时，Python 的 zipfile 按 CP437 解码文件名。
    macOS 的文件名是 NFD 形式（ó 存成 o + 组合音符），它的 UTF-8 字节 0xCC 0x81
    在 CP437 下正好是「╠ü」—— 于是 "Sesión" 变成 "Sesio╠ün" 一路存进库里，
    显示、搜索、导出拿到的都是乱码名。

    做法：把 str 编回 CP437 拿到原始字节，再按 UTF-8 解一次。两种情况原样返回，
    免得把本来正常的名字改坏：
      - CP437 编不出来（含中文等 CP437 之外的字符）→ 说明本来就是好的
      - 解出来不是合法 UTF-8 → 同上
    """
    if not name:
        return name
    try:
        raw = name.encode("cp437")
    except UnicodeEncodeError:
        return name
    try:
        fixed = raw.decode("utf-8")
    except UnicodeDecodeError:
        return name
    return unicodedata.normalize("NFC", fixed) if fixed != name else name


def _conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    with _conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS courses(
                id TEXT PRIMARY KEY,
                code TEXT NOT NULL,
                name TEXT NOT NULL DEFAULT '',
                semester TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS materials(
                id TEXT PRIMARY KEY,
                course_id TEXT NOT NULL,
                orig_name TEXT NOT NULL,
                tag TEXT NOT NULL DEFAULT '其他',
                pages INTEGER DEFAULT 0,
                size INTEGER DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                error TEXT DEFAULT '',
                created_at REAL NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0,
                deleted_at REAL
            );
            CREATE TABLE IF NOT EXISTS chunks(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                material_id TEXT NOT NULL,
                course_id TEXT NOT NULL,
                page INTEGER NOT NULL,
                ord INTEGER NOT NULL,
                text TEXT NOT NULL,
                embedding BLOB
            );
            CREATE INDEX IF NOT EXISTS idx_chunks_course ON chunks(course_id);
            CREATE INDEX IF NOT EXISTS idx_chunks_material ON chunks(material_id);
            CREATE TABLE IF NOT EXISTS messages(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                course_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                citations TEXT NOT NULL DEFAULT '[]',
                created_at REAL NOT NULL
            );
            """
        )
        # 迁移：课程分组（major=专业课 / easy=水课 / elective=额外选修课）
        cols = [r["name"] for r in c.execute("PRAGMA table_info(courses)").fetchall()]
        if "course_group" not in cols:
            c.execute(
                "ALTER TABLE courses ADD COLUMN course_group TEXT NOT NULL DEFAULT 'major'"
            )
        # 迁移：资料文件类型（pdf / docx）
        cols = [r["name"] for r in c.execute("PRAGMA table_info(materials)").fetchall()]
        if "ext" not in cols:
            c.execute("ALTER TABLE materials ADD COLUMN ext TEXT NOT NULL DEFAULT 'pdf'")
        # 迁移：AI 入库分析结果（摘要 / 关键词 / 建议课程 / 是否已分析 / 标签是否人工锁定）
        cols = [r["name"] for r in c.execute("PRAGMA table_info(materials)").fetchall()]
        for col, ddl in (
            ("summary", "TEXT NOT NULL DEFAULT ''"),
            ("keywords", "TEXT NOT NULL DEFAULT ''"),
            ("ai_course", "TEXT NOT NULL DEFAULT ''"),
            ("ai_analyzed", "INTEGER NOT NULL DEFAULT 0"),
            ("tag_locked", "INTEGER NOT NULL DEFAULT 0"),
        ):
            if col not in cols:
                c.execute(f"ALTER TABLE materials ADD COLUMN {col} {ddl}")
        # 迁移：专业课学分（决定均分权重）
        cols = [r["name"] for r in c.execute("PRAGMA table_info(courses)").fetchall()]
        if "credits" not in cols:
            c.execute("ALTER TABLE courses ADD COLUMN credits REAL NOT NULL DEFAULT 0")
        # 成绩构成（Assessment Component）
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS assessments(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                course_id TEXT NOT NULL,
                name TEXT NOT NULL DEFAULT '',
                weight REAL NOT NULL DEFAULT 0,
                score REAL,
                ord INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_assessments_course ON assessments(course_id);
            """
        )
        # 沉浸模式逐页注释（一页可有多个语言版本，主键带上 lang）
        c.execute(
            """CREATE TABLE IF NOT EXISTS page_notes(
                material_id TEXT NOT NULL,
                page INTEGER NOT NULL,
                lang TEXT NOT NULL DEFAULT 'zh',
                content TEXT NOT NULL,
                edited INTEGER NOT NULL DEFAULT 0,
                updated_at REAL NOT NULL,
                PRIMARY KEY(material_id, page, lang)
            )"""
        )
        # 待办事项（DDL + 具体事项；ord 为手动排序位；course_id 关联来源课程）
        c.execute(
            """CREATE TABLE IF NOT EXISTS todos(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                due TEXT NOT NULL DEFAULT '',
                done INTEGER NOT NULL DEFAULT 0,
                ord INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL,
                course_id TEXT NOT NULL DEFAULT ''
            )"""
        )
        # 练习题库：出过的题落库。题目有 id 才能记录作答、统计薄弱点、重练错题；
        # 不落库的话每次出题都是一次性消费，学习闭环就断在「答完即弃」。
        c.execute(
            """CREATE TABLE IF NOT EXISTS quiz_questions(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                course_id TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'choice',
                question TEXT NOT NULL,
                options TEXT NOT NULL DEFAULT '[]',
                answer TEXT NOT NULL DEFAULT '',
                explanation TEXT NOT NULL DEFAULT '',
                refs TEXT NOT NULL DEFAULT '[]',
                unit_key TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL
            )"""
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_quiz_course ON quiz_questions(course_id)")
        # 作答记录：每次作答都留痕（保留全部历史；薄弱点按「最近一次」判断）
        c.execute(
            """CREATE TABLE IF NOT EXISTS quiz_attempts(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                question_id INTEGER NOT NULL,
                user_answer TEXT NOT NULL DEFAULT '',
                correct INTEGER NOT NULL DEFAULT 0,
                answered_at REAL NOT NULL
            )"""
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_attempt_q ON quiz_attempts(question_id)")
        # 覆盖率台账：记录每个知识点单元是否出过题。
        # unit_key 由「资料 + 页 + 段号」拼成（见 core.build_knowledge_units）——
        # 只要资料内容不变，同一页永远算出同一个 key，覆盖率才能跨次累积。
        c.execute(
            """CREATE TABLE IF NOT EXISTS quiz_coverage(
                unit_key TEXT PRIMARY KEY,
                course_id TEXT NOT NULL,
                material_id TEXT NOT NULL,
                page INTEGER NOT NULL DEFAULT 0,
                question_cnt INTEGER NOT NULL DEFAULT 0,
                updated_at REAL NOT NULL
            )"""
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_coverage_course ON quiz_coverage(course_id)")
        # 阅读进度（每份资料读到第几页）
        c.execute(
            """CREATE TABLE IF NOT EXISTS material_progress(
                material_id TEXT PRIMARY KEY,
                page INTEGER NOT NULL DEFAULT 1,
                updated_at REAL NOT NULL
            )"""
        )
        # 文件笔记（学生在阅读时自己写的笔记）
        c.execute(
            """CREATE TABLE IF NOT EXISTS material_my_notes(
                material_id TEXT PRIMARY KEY,
                content TEXT NOT NULL DEFAULT '',
                updated_at REAL NOT NULL
            )"""
        )
        # 页面圈画：每页一组笔画（坐标按页面宽高归一化，缩放/适应宽度都不错位）
        c.execute(
            """CREATE TABLE IF NOT EXISTS page_ink(
                material_id TEXT NOT NULL,
                page INTEGER NOT NULL,
                data TEXT NOT NULL DEFAULT '[]',
                updated_at REAL NOT NULL,
                PRIMARY KEY(material_id, page)
            )"""
        )
        # 本页批注：每页一组文本块（标题 / 正文两种样式）
        c.execute(
            """CREATE TABLE IF NOT EXISTS page_mynotes(
                material_id TEXT NOT NULL,
                page INTEGER NOT NULL,
                blocks TEXT NOT NULL DEFAULT '[]',
                updated_at REAL NOT NULL,
                PRIMARY KEY(material_id, page)
            )"""
        )
    _migrate()

    # ---------- 老库迁移：补列 / 补默认值 ----------

def _migrate():
    with _conn() as c:
        cols = {r["name"] for r in c.execute("PRAGMA table_info(todos)").fetchall()}
        if "ord" not in cols:                      # 老库补 ord，按 id 顺序初始化
            c.execute("ALTER TABLE todos ADD COLUMN ord INTEGER NOT NULL DEFAULT 0")
            c.execute("UPDATE todos SET ord = id")
        if "course_id" not in cols:                # 老库补课程归属（'' = 不属于任何课程）
            c.execute("ALTER TABLE todos ADD COLUMN course_id TEXT NOT NULL DEFAULT ''")
        # 老库补台账关联列（'' = 这道题没记知识点，不计入覆盖率）
        qcols = {r["name"] for r in c.execute("PRAGMA table_info(quiz_questions)").fetchall()}
        if qcols and "unit_key" not in qcols:
            c.execute("ALTER TABLE quiz_questions ADD COLUMN unit_key TEXT NOT NULL DEFAULT ''")
        # 从未排过序（全为 0）时按 id 初始化一次
        if c.execute("SELECT COUNT(*) AS n FROM todos WHERE ord != 0").fetchone()["n"] == 0:
            c.execute("UPDATE todos SET ord = id")

        # page_notes 老库没有 lang 列 → 重建表（SQLite 改不了主键）。
        # 已有注释全部认定为中文 —— 这几百上千条是用户看着读过的，一条都不能丢。
        pncols = {r["name"] for r in c.execute("PRAGMA table_info(page_notes)").fetchall()}
        if pncols and "lang" not in pncols:
            c.execute(
                """CREATE TABLE page_notes_v2(
                    material_id TEXT NOT NULL,
                    page INTEGER NOT NULL,
                    lang TEXT NOT NULL DEFAULT 'zh',
                    content TEXT NOT NULL,
                    edited INTEGER NOT NULL DEFAULT 0,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY(material_id, page, lang)
                )"""
            )
            c.execute(
                "INSERT INTO page_notes_v2(material_id, page, lang, content, edited, updated_at)"
                " SELECT material_id, page, 'zh', content, edited, updated_at FROM page_notes"
            )
            c.execute("DROP TABLE page_notes")
            c.execute("ALTER TABLE page_notes_v2 RENAME TO page_notes")


# 合法列名：小写字母或下划线开头，只含小写字母 / 数字 / 下划线
_SAFE_COL = re.compile(r"^[a-z_][a-z0-9_]*$")


def _check_fields(fields: dict, allowed: set, table: str):
    """更新列名的双重校验：非法字段直接报错，而不是拼进 SQL。

    第一道：白名单 —— 只允许代码里写死的列名（防的是调用方传错/传恶意字段）。
    第二道：格式 —— 即使将来白名单被误改宽，也能挡住 `a; DROP TABLE` 这类列名。
    值本身始终走参数绑定，这里只管列名。
    """
    bad = set(fields) - allowed
    if bad:
        raise ValueError(f"{table} 不允许更新字段：{sorted(bad)}")
    for k in fields:
        if not _SAFE_COL.match(str(k)):
            raise ValueError(f"{table} 非法字段名：{k!r}")


def now() -> float:
    return time.time()


def new_id() -> str:
    return uuid.uuid4().hex[:12]


# ---------- courses ----------

def list_courses():
    with _conn() as c:
        rows = c.execute(
            """SELECT co.*, (SELECT COUNT(*) FROM materials m
                             WHERE m.course_id=co.id AND m.deleted=0) AS material_count
               FROM courses co ORDER BY co.created_at"""
        ).fetchall()
        return [dict(r) for r in rows]


def create_course(code: str, name: str, semester: str, group: str = "major"):
    cid = new_id()
    with _conn() as c:
        c.execute(
            "INSERT INTO courses(id, code, name, semester, course_group, created_at) VALUES(?,?,?,?,?,?)",
            (cid, code.strip(), name.strip(), semester.strip(), group, now()),
        )
    return cid


# 各表允许更新的列（白名单）。防止把用户输入当成列名拼进 SQL：
# 值走参数绑定是安全的，但列名只能来自代码里写死的集合。
COURSE_FIELDS = {"name", "semester", "course_group", "credits", "code"}


def update_course(cid: str, **fields):
    _check_fields(fields, COURSE_FIELDS, "courses")
    keys = ",".join(f"{k}=?" for k in fields)
    with _conn() as c:
        c.execute(f"UPDATE courses SET {keys} WHERE id=?", (*fields.values(), cid))


def get_course(cid: str):
    with _conn() as c:
        r = c.execute("SELECT * FROM courses WHERE id=?", (cid,)).fetchone()
        return dict(r) if r else None


def find_course_by_code(code: str):
    with _conn() as c:
        r = c.execute("SELECT * FROM courses WHERE code=?", (code.strip(),)).fetchone()
        return dict(r) if r else None


def get_or_create_course(code: str, name: str = "", semester: str = ""):
    course = find_course_by_code(code)
    if course:
        return course
    cid = create_course(code, name, semester)
    return get_course(cid)


def delete_course(cid: str):
    """删除课程：资料进回收区，聊天记录清除。"""
    ts = now()
    with _conn() as c:
        c.execute(
            "UPDATE materials SET deleted=1, deleted_at=? WHERE course_id=? AND deleted=0",
            (ts, cid),
        )
        c.execute("DELETE FROM messages WHERE course_id=?", (cid,))
        c.execute("DELETE FROM courses WHERE id=?", (cid,))


# ---------- materials ----------

def add_material(course_id: str, orig_name: str, tag: str, size: int, ext: str = "pdf") -> str:
    mid = new_id()
    with _conn() as c:
        c.execute(
            "INSERT INTO materials(id, course_id, orig_name, tag, size, ext, created_at) VALUES(?,?,?,?,?,?,?)",
            (mid, course_id, orig_name, tag, size, ext, now()),
        )
    return mid


MATERIAL_FIELDS = {"tag", "status", "error", "pages", "course_id", "deleted", "deleted_at",
                   "summary", "keywords", "ai_course", "ai_analyzed", "tag_locked"}


def update_material(mid: str, **fields):
    _check_fields(fields, MATERIAL_FIELDS, "materials")
    keys = ",".join(f"{k}=?" for k in fields)
    with _conn() as c:
        c.execute(f"UPDATE materials SET {keys} WHERE id=?", (*fields.values(), mid))


def get_material(mid: str):
    with _conn() as c:
        r = c.execute("SELECT * FROM materials WHERE id=?", (mid,)).fetchone()
        return dict(r) if r else None


def list_materials(course_id: str, query: str = "", deleted: int = 0):
    sql = """SELECT m.*, (SELECT COUNT(DISTINCT pn.page) FROM page_notes pn WHERE pn.material_id=m.id) AS notes_count
             FROM materials m WHERE m.course_id=? AND deleted=?"""
    args = [course_id, deleted]
    if query:
        sql += " AND orig_name LIKE ?"
        args.append(f"%{query}%")
    sql += " ORDER BY created_at DESC"
    with _conn() as c:
        rows = c.execute(sql, args).fetchall()
        return [dict(r) for r in rows]


def pending_analysis(course_id: str = ""):
    """还没做过入库 AI 分析的资料（只算解析成功的，避免对失败资料白调 AI）。"""
    sql = """SELECT id, orig_name FROM materials
             WHERE deleted=0 AND ai_analyzed=0 AND status='ready'"""
    args: list = []
    if course_id:
        sql += " AND course_id=?"
        args.append(course_id)
    sql += " ORDER BY created_at"
    with _conn() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def soft_delete_material(mid: str):
    with _conn() as c:
        c.execute(
            "UPDATE materials SET deleted=1, deleted_at=? WHERE id=?", (now(), mid)
        )


def restore_material(mid: str):
    with _conn() as c:
        c.execute("UPDATE materials SET deleted=0, deleted_at=NULL WHERE id=?", (mid,))


def move_material(mid: str, course_id: str):
    with _conn() as c:
        c.execute("UPDATE materials SET course_id=? WHERE id=?", (course_id, mid))
        c.execute("UPDATE chunks SET course_id=? WHERE material_id=?", (course_id, mid))


# ---------- 待办事项 ----------

def list_todos():
    """按手动顺序（ord）返回；未排序过的按 id。未完成/已完成的分组交给前端。

    同时带出 course_code / course_name —— 待办列表要能一眼看出「这条属于哪门课」，
    否则从 HandBook 扫进来的 DDL 会分不清是哪一科。
    """
    with _conn() as c:
        rows = c.execute(
            "SELECT t.*, COALESCE(c.code,'') AS course_code, COALESCE(c.name,'') AS course_name"
            " FROM todos t LEFT JOIN courses c ON c.id = t.course_id"
            " ORDER BY CASE WHEN t.ord=0 THEN t.id ELSE t.ord END ASC, t.id ASC"
        ).fetchall()
        return [dict(r) for r in rows]


def reorder_todos(ids: list):
    """按传入顺序写入 ord（一次提交，避免 N 次往返）。"""
    with _conn() as c:
        c.executemany("UPDATE todos SET ord=? WHERE id=?",
                      [(i, int(tid)) for i, tid in enumerate(ids, start=1)])


def add_todo(content: str, due: str, course_id: str = ""):
    with _conn() as c:
        c.execute(
            "INSERT INTO todos(content, due, course_id, created_at) VALUES(?,?,?,?)",
            (content.strip(), due or "", course_id or "", now()),
        )


TODO_FIELDS = {"content", "due", "done", "ord", "course_id"}


def update_todo(todo_id: int, **fields):
    _check_fields(fields, TODO_FIELDS, "todos")
    keys = ",".join(f"{k}=?" for k in fields)
    with _conn() as c:
        c.execute(f"UPDATE todos SET {keys} WHERE id=?", (*fields.values(), todo_id))


# ---------- 阅读进度 ----------

def get_progress(material_id: str) -> int:
    with _conn() as c:
        row = c.execute(
            "SELECT page FROM material_progress WHERE material_id=?", (material_id,)
        ).fetchone()
        return int(row["page"]) if row else 0


def set_progress(material_id: str, page: int):
    with _conn() as c:
        c.execute(
            """INSERT INTO material_progress(material_id, page, updated_at) VALUES(?,?,?)
               ON CONFLICT(material_id) DO UPDATE SET page=excluded.page, updated_at=excluded.updated_at""",
            (material_id, int(page), now()),
        )


def latest_progress() -> dict | None:
    """最近读过的那份资料（供主页「继续上次」用）。"""
    with _conn() as c:
        row = c.execute(
            """SELECT p.material_id, p.page, p.updated_at, m.orig_name, m.ext,
                      m.course_id, co.code AS course_code
               FROM material_progress p
               JOIN materials m ON m.id = p.material_id
               LEFT JOIN courses co ON co.id = m.course_id
               WHERE m.deleted = 0
               ORDER BY p.updated_at DESC LIMIT 1"""
        ).fetchone()
        return dict(row) if row else None


# ---------- 文件笔记（自己写的） ----------

def get_my_note(material_id: str) -> str:
    with _conn() as c:
        row = c.execute(
            "SELECT content FROM material_my_notes WHERE material_id=?", (material_id,)
        ).fetchone()
        return row["content"] if row else ""


def set_my_note(material_id: str, content: str):
    with _conn() as c:
        c.execute(
            """INSERT INTO material_my_notes(material_id, content, updated_at) VALUES(?,?,?)
               ON CONFLICT(material_id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at""",
            (material_id, content, now()),
        )


# ---------- 页面圈画 ----------

def get_ink(material_id: str, page: int) -> str:
    """该页笔画的 JSON 字符串（没有则返回空数组）。"""
    with _conn() as c:
        row = c.execute(
            "SELECT data FROM page_ink WHERE material_id=? AND page=?",
            (material_id, int(page)),
        ).fetchone()
        return row["data"] if row else "[]"


def set_ink(material_id: str, page: int, data: str):
    with _conn() as c:
        c.execute(
            """INSERT INTO page_ink(material_id, page, data, updated_at) VALUES(?,?,?,?)
               ON CONFLICT(material_id, page) DO UPDATE SET
                 data=excluded.data, updated_at=excluded.updated_at""",
            (material_id, int(page), data, now()),
        )


def marked_pages(material_id: str) -> dict:
    """哪些页有圈画，供页面标记使用。"""
    with _conn() as c:
        ink = [r["page"] for r in c.execute(
            "SELECT page FROM page_ink WHERE material_id=? AND data NOT IN ('[]', '')",
            (material_id,)).fetchall()]
    return {"ink": sorted(ink)}


# ---------- 沉浸模式逐页注释 ----------

def get_notes(material_id: str, lang: str = "zh"):
    """取某份资料某语言的逐页注释（默认中文）。"""
    with _conn() as c:
        rows = c.execute(
            "SELECT page, content, edited FROM page_notes"
            " WHERE material_id=? AND lang=? ORDER BY page",
            (material_id, lang),
        ).fetchall()
        return [dict(r) for r in rows]


def upsert_note(material_id: str, page: int, content: str,
                edited: int = 0, lang: str = "zh"):
    with _conn() as c:
        c.execute(
            """INSERT INTO page_notes(material_id, page, lang, content, edited, updated_at)
               VALUES(?,?,?,?,?,?)
               ON CONFLICT(material_id, page, lang) DO UPDATE SET
                 content=excluded.content, edited=excluded.edited, updated_at=excluded.updated_at""",
            (material_id, page, lang, content, edited, now()),
        )


def materials_with_course(query: str = "", tag: str = "", deleted: int = 0):
    """跨课程查询资料（回收区 / 资料总库共用），SQL 收口在数据层。"""
    sql = """SELECT m.*, co.code AS course_code, co.name AS course_name,
                    (SELECT COUNT(DISTINCT pn.page) FROM page_notes pn WHERE pn.material_id=m.id) AS notes_count
             FROM materials m LEFT JOIN courses co ON co.id = m.course_id
             WHERE m.deleted=?"""
    args = [deleted]
    if query.strip():
        sql += " AND m.orig_name LIKE ?"
        args.append(f"%{query.strip()}%")
    if tag.strip():
        sql += " AND m.tag = ?"
        args.append(tag.strip())
    sql += " ORDER BY m.created_at DESC" if not deleted else " ORDER BY m.deleted_at DESC"
    with _conn() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def delete_todo(todo_id: int):
    with _conn() as c:
        c.execute("DELETE FROM todos WHERE id=?", (todo_id,))


# ---------- 练习：题库 / 作答 / 薄弱点 ----------
# 这一层是学习闭环的后半段：出题 → 作答 → 判分 → 累积薄弱点 → 只重练错过的。

def _quiz_row(r) -> dict:
    """把库里的行转成题目对象（options / refs 是 JSON 文本，这里还原）。"""
    d = dict(r)
    for k in ("options", "refs"):
        try:
            d[k] = json.loads(d.get(k) or "[]")
        except (TypeError, ValueError):
            d[k] = []
    return d


def save_quiz_questions(course_id: str, questions: list) -> list:
    """一次出题的题目全部落库，返回带 id 的题目列表（前端靠 id 提交作答）。

    题目与覆盖率台账**写在同一个事务里** —— 题存了但台账漏记，覆盖率就会偏低，
    而这种偏差在界面上是「明明练过却说自己没覆盖」，很难被发现。
    """
    out = []
    with _conn() as c:
        for q in questions or []:
            opts = q.get("options") or []
            # 出题侧不返回 kind，这里按有无选项判定（选择题才有选项）
            kind = str(q.get("kind") or ("choice" if opts else "short"))
            unit_key = str(q.get("unit_key") or "")
            cur = c.execute(
                "INSERT INTO quiz_questions(course_id, kind, question, options, answer,"
                " explanation, refs, unit_key, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    course_id,
                    kind,
                    str(q.get("question") or ""),
                    json.dumps(opts, ensure_ascii=False),
                    str(q.get("answer") or ""),
                    str(q.get("explanation") or ""),
                    json.dumps(q.get("refs") or [], ensure_ascii=False),
                    unit_key,
                    now(),
                ),
            )
            item = dict(q)
            item["id"] = cur.lastrowid
            item["kind"] = kind
            out.append(item)

        for q in questions or []:
            uk = str(q.get("unit_key") or "")
            if not uk:
                continue                      # 没有知识点归属的题（如纯抽题）不计入覆盖率
            c.execute(
                "INSERT INTO quiz_coverage(unit_key, course_id, material_id, page,"
                " question_cnt, updated_at) VALUES(?,?,?,?,1,?)"
                " ON CONFLICT(unit_key) DO UPDATE SET"
                " question_cnt = question_cnt + 1, updated_at = excluded.updated_at",
                (uk, course_id, str(q.get("material_id") or ""),
                 int(q.get("page") or 0), now()),
            )
    return out


def covered_unit_keys(course_id: str) -> set:
    """该课程已出过题的知识点单元集合（覆盖率分子）。"""
    with _conn() as c:
        rows = c.execute(
            "SELECT unit_key FROM quiz_coverage WHERE course_id=? AND question_cnt>0",
            (course_id,),
        ).fetchall()
        return {r["unit_key"] for r in rows}


def coverage_stats(course_id: str) -> dict:
    with _conn() as c:
        row = c.execute(
            "SELECT COUNT(*) AS n, COALESCE(SUM(question_cnt),0) AS q FROM quiz_coverage"
            " WHERE course_id=? AND question_cnt>0",
            (course_id,),
        ).fetchone()
    return {"covered": row["n"], "covered_questions": int(row["q"] or 0)}


def coverage_by_material(course_id: str) -> dict:
    """按资料聚合已覆盖的单元数（总数由调用方按 chunk 字数算）。"""
    with _conn() as c:
        rows = c.execute(
            "SELECT material_id, COUNT(*) AS n FROM quiz_coverage"
            " WHERE course_id=? AND question_cnt>0 GROUP BY material_id",
            (course_id,),
        ).fetchall()
        return {r["material_id"]: int(r["n"]) for r in rows}


def get_quiz_question(qid: int):
    with _conn() as c:
        r = c.execute("SELECT * FROM quiz_questions WHERE id=?", (int(qid),)).fetchone()
        return _quiz_row(r) if r else None


def record_attempt(question_id: int, user_answer: str, correct: bool):
    """记录一次作答。历史全留（同一题多次作答都存），薄弱点按最近一次判断。"""
    with _conn() as c:
        c.execute(
            "INSERT INTO quiz_attempts(question_id, user_answer, correct, answered_at)"
            " VALUES(?,?,?,?)",
            (int(question_id), str(user_answer or ""), 1 if correct else 0, now()),
        )


def _latest_attempt_join():
    """只取每题「最近一次」作答的 JOIN 片段（用 MAX(id) 定位，比时间戳稳）。"""
    return (
        " JOIN quiz_attempts a ON a.id ="
        " (SELECT id FROM quiz_attempts WHERE question_id=q.id ORDER BY id DESC LIMIT 1)"
    )


def list_wrong_questions(course_id: str, limit: int = 50) -> list:
    """薄弱点：最近一次作答是错的题（后续答对了就不再出现）。"""
    with _conn() as c:
        rows = c.execute(
            "SELECT q.*, a.user_answer, a.answered_at,"
            " (SELECT COUNT(*) FROM quiz_attempts x WHERE x.question_id=q.id) AS attempts"
            " FROM quiz_questions q" + _latest_attempt_join() +
            " WHERE q.course_id=? AND a.correct=0"
            " ORDER BY a.id DESC LIMIT ?",
            (course_id, int(limit)),
        ).fetchall()
        return [_quiz_row(r) for r in rows]


def quiz_stats(course_id: str) -> dict:
    """练习统计：出题数、已答数、答对率、待重练数。"""
    with _conn() as c:
        total_q = c.execute(
            "SELECT COUNT(*) AS n FROM quiz_questions WHERE course_id=?", (course_id,)
        ).fetchone()["n"]
        row = c.execute(
            "SELECT COUNT(*) AS n, COALESCE(SUM(a.correct),0) AS ok FROM quiz_questions q"
            + _latest_attempt_join() +
            " WHERE q.course_id=?", (course_id,)
        ).fetchone()
        answered, ok = row["n"], int(row["ok"] or 0)
        wrong = c.execute(
            "SELECT COUNT(*) AS n FROM quiz_questions q" + _latest_attempt_join() +
            " WHERE q.course_id=? AND a.correct=0", (course_id,)
        ).fetchone()["n"]
    return {
        "questions": total_q,
        "answered": answered,
        "correct": ok,
        "accuracy": round(ok * 100 / answered, 1) if answered else None,
        "wrong": wrong,
    }


# ---------- 成绩构成 ----------

def list_assessments(course_id: str):
    with _conn() as c:
        rows = c.execute(
            "SELECT id, name, weight, score FROM assessments WHERE course_id=? ORDER BY ord",
            (course_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def replace_assessments(course_id: str, items: list[dict]):
    """items: [{name, weight, score}]，score 可为 None。"""
    with _conn() as c:
        c.execute("DELETE FROM assessments WHERE course_id=?", (course_id,))
        c.executemany(
            "INSERT INTO assessments(course_id, name, weight, score, ord) VALUES(?,?,?,?,?)",
            [
                (
                    course_id,
                    str(it.get("name") or f"Component {i + 1}"),
                    float(it.get("weight") or 0),
                    float(it["score"]) if it.get("score") is not None else None,
                    i,
                )
                for i, it in enumerate(items)
            ],
        )


def purge_material(mid: str) -> dict | None:
    """彻底删除：返回资料信息供调用方清理文件与分块。"""
    mat = get_material(mid)
    if not mat:
        return None
    with _conn() as c:
        c.execute("DELETE FROM chunks WHERE material_id=?", (mid,))
        c.execute("DELETE FROM materials WHERE id=?", (mid,))
        c.execute("DELETE FROM page_notes WHERE material_id=?", (mid,))
        c.execute("DELETE FROM material_progress WHERE material_id=?", (mid,))
        c.execute("DELETE FROM material_my_notes WHERE material_id=?", (mid,))
        c.execute("DELETE FROM page_ink WHERE material_id=?", (mid,))
        c.execute("DELETE FROM page_mynotes WHERE material_id=?", (mid,))
    return mat


# ---------- chunks / retrieval ----------

def add_chunks(course_id: str, material_id: str, chunks: list[tuple[int, int, str, bytes]]):
    """chunks: [(page, ord, text, embedding_bytes)]"""
    with _conn() as c:
        c.executemany(
            "INSERT INTO chunks(material_id, course_id, page, ord, text, embedding) VALUES(?,?,?,?,?,?)",
            [(material_id, course_id, p, o, t, e) for p, o, t, e in chunks],
        )


def material_sample_texts(material_id: str) -> list[str]:
    """取该资料「首 / 中 / 尾」三块文本，用于入库后的内容判定。

    只查 3 行，不把整本资料拉进内存（长文档可能是几 MB 文本）。
    """
    with _conn() as c:
        n = c.execute(
            "SELECT COUNT(*) AS n FROM chunks WHERE material_id=?", (material_id,)
        ).fetchone()["n"]
        if not n:
            return []
        picks, seen = [], set()
        for off in (0, n // 2, n - 1):
            if off in seen or off < 0:
                continue
            seen.add(off)
            r = c.execute(
                "SELECT text FROM chunks WHERE material_id=? ORDER BY id LIMIT 1 OFFSET ?",
                (material_id, off),
            ).fetchone()
            if r:
                picks.append(r["text"])
        return picks


def all_chunks_with_vectors(course_id: str = ""):
    """取分块与向量。course_id 为空串时跨全部课程（含未分类）——外部资料模式用。

    ord 必须带出来：检索命中一个碎片后要按 ord 把前后相邻块取回来，
    才能拼成完整段落（教材是 600 字滑窗切的，单块常从句子中间断开）。
    """
    sql = """SELECT ch.id, ch.material_id, ch.page, ch.ord, ch.text, ch.embedding,
                    m.orig_name, m.ext, co.code AS course_code
             FROM chunks ch
             JOIN materials m ON m.id = ch.material_id
             LEFT JOIN courses co ON co.id = ch.course_id
             WHERE m.deleted=0 AND ch.embedding IS NOT NULL"""
    args: list = []
    if course_id:
        sql += " AND ch.course_id=?"
        args.append(course_id)
    with _conn() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def chunks_by_ord_range(material_id: str, lo: int, hi: int):
    """取某资料内 ord 落在 [lo, hi] 的块，按 ord 升序。

    用途：检索命中一个碎片，把它的前后邻块一起取回拼成完整段落。
    """
    with _conn() as c:
        rows = c.execute(
            "SELECT id, material_id, page, ord, text FROM chunks"
            " WHERE material_id=? AND ord BETWEEN ? AND ? ORDER BY ord",
            (material_id, int(lo), int(hi)),
        ).fetchall()
        return [dict(r) for r in rows]


def chunks_for_materials(material_ids: list[str]):
    """按资料 ID 取分块（用于出题），按资料 / 页 / 块序排序。

    带上 ord 是必需的：同一页的多个块要按 ord 拼回原文顺序，
    顺序错了合并出来的「知识点」就是乱的。
    """
    if not material_ids:
        return []
    marks = ",".join("?" * len(material_ids))
    with _conn() as c:
        rows = c.execute(
            f"""SELECT ch.material_id, ch.page, ch.ord, ch.text, m.orig_name, m.ext
                FROM chunks ch JOIN materials m ON m.id = ch.material_id
                WHERE ch.material_id IN ({marks}) AND m.deleted=0
                ORDER BY ch.material_id, ch.page, ch.ord""",
            material_ids,
        ).fetchall()
        return [dict(r) for r in rows]


def chunk_sizes_for_materials(material_ids: list[str]):
    """按 (资料, 页) 聚合出字数，**不读正文**。

    覆盖率统计只需要知道每页多大（据此算拆成几个知识点），不需要正文，
    所以走这条轻量查询 —— 全库上万块时，读不回文本的差别很明显。
    返回 [(material_id, page, chars), ...]
    """
    ids = [m for m in (material_ids or []) if isinstance(m, str)]
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    with _conn() as c:
        rows = c.execute(
            f"""SELECT ch.material_id, ch.page, COALESCE(SUM(LENGTH(ch.text)),0) AS chars
                FROM chunks ch JOIN materials m ON m.id = ch.material_id
                WHERE ch.material_id IN ({marks}) AND m.deleted=0
                GROUP BY ch.material_id, ch.page
                ORDER BY ch.material_id, ch.page""",
            ids,
        ).fetchall()
        return [(r["material_id"], int(r["page"]), int(r["chars"])) for r in rows]


# ---------- messages ----------

def add_message(course_id: str, role: str, content: str, citations: list | None = None):
    with _conn() as c:
        c.execute(
            "INSERT INTO messages(course_id, role, content, citations, created_at) VALUES(?,?,?,?,?)",
            (course_id, role, content, json.dumps(citations or [], ensure_ascii=False), now()),
        )


def list_messages(course_id: str, limit: int = 200):
    with _conn() as c:
        rows = c.execute(
            "SELECT * FROM messages WHERE course_id=? ORDER BY id DESC LIMIT ?",
            (course_id, limit),
        ).fetchall()
        out = [dict(r) for r in rows]
        for m in out:
            m["citations"] = json.loads(m["citations"])
        out.reverse()
        return out


def clear_messages(course_id: str):
    with _conn() as c:
        c.execute("DELETE FROM messages WHERE course_id=?", (course_id,))
