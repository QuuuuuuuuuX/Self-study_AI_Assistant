"""沉浸模式逐页注释：批量预生成 + 手工编辑（edited=1 永不被覆盖）。"""
import threading
import time

from fastapi import APIRouter, HTTPException

from .. import core, store
from ..config import material_file_path
router = APIRouter()

NOTE_STATUS: dict[str, dict] = {}

BATCH = 8               # 一次调用打包几页
RETRY_PER_BATCH = 3     # 单个批次最多尝试几次
RETRY_ROUNDS = 2        # 整轮跑完后仍有失败页时，再补跑几轮
RETRY_BASE_DELAY = 1.5  # 退避基数（秒）：1.5s → 3s
ROUND_DELAY = 5         # 补跑轮之间的等待（秒），给网络恢复的时间


def _log(msg: str):
    """带时间戳 + flush 的日志。

    - flush：stdout 重定向到文件时是块缓冲，不加 flush 的打印根本不会落盘
    - 时间戳：日志是跨进程追加的，没有时间戳就无法区分「刚发生的」和「几天前的」
    """
    print(f"[{time.strftime('%m-%d %H:%M:%S')}] {msg}", flush=True)


def _is_retryable(e: Exception) -> bool:
    """只对网络/限流类异常重试；配置类错误（key 无效、模型名错）重试也是白等。"""
    return type(e).__name__ in (
        "APIConnectionError", "APITimeoutError", "RateLimitError",
        "InternalServerError", "APIStatusError", "ConnectError", "ReadTimeout",
    )


def _why(e: Exception) -> str:
    """带出底层原因（httpx 的 ConnectError / ConnectTimeout / ReadTimeout 等）。

    只有一句 "Connection error." 是没法定位的——到底是 DNS 失败、连接被拒、
    还是 TLS 握手超时，全靠这一层。
    """
    c = e.__cause__ or e.__context__
    return f"{type(c).__name__}: {str(c)[:140]}" if c else "无"


NOTE_LANGS = ("zh", "en", "es")


def _norm_lang(lang: str) -> str:
    """归一到支持的语言码；不认识的按中文处理（默认值永远是中文）。"""
    lang = (lang or "zh").strip().lower()
    return lang if lang in NOTE_LANGS else "zh"


def _status_key(mid: str, lang: str) -> str:
    """任务状态按「资料 + 语言」分开存 —— 中文和西语两轮生成不能互相顶掉。"""
    return f"{mid}:{lang}"


def _fetch_batch(course_name: str, batch: list, lang: str = "zh"):
    """调一次批量生成，网络类失败按指数退避重试。返回 (result, err)。"""
    last = None
    for i in range(RETRY_PER_BATCH):
        try:
            return core.generate_page_notes_batch(course_name, batch, lang=lang), None
        except Exception as e:  # noqa: BLE001
            last = e
            if not _is_retryable(e):
                _log(f"[notes] 不可重试的错误（{type(e).__name__}）：{e}")
                break
            if i < RETRY_PER_BATCH - 1:
                delay = RETRY_BASE_DELAY * (2 ** i)
                _log(f"[notes] 调用失败（{type(e).__name__}：{e}｜底层 {_why(e)}），{delay:.1f}s 后重试 {i + 2}/{RETRY_PER_BATCH}")
                time.sleep(delay)
    return {}, last


def _note_job(mid: str, course_name: str, lang: str = "zh"):
    key = _status_key(mid, lang)

    def run():
        st = NOTE_STATUS[key]
        try:
            path = material_file_path(mid, "pdf")
            pages = core.parse_pdf(path)
            st["total"] = len(pages)
            have = {n["page"] for n in store.get_notes(mid, lang)}
            st["done"] = len(have)
            todo = [(pno, text) for pno, text in pages if pno not in have]
            st["failed"] = len(todo)

            for rnd in range(RETRY_ROUNDS):
                if not todo:
                    break
                if rnd:
                    _log(f"[notes:{lang}] {mid} 第 {rnd + 1} 轮补跑 {len(todo)} 页：{[p for p, _ in todo][:12]}")
                    time.sleep(ROUND_DELAY)
                pending = []
                for k in range(0, len(todo), BATCH):
                    batch = todo[k:k + BATCH]
                    span = f"p{batch[0][0]}-{batch[-1][0]}"
                    result, err = _fetch_batch(course_name, batch, lang)
                    if err is not None:
                        st["last_error"] = f"批次 {span} 调用失败：{err}"
                        pending.extend(batch)
                        # 不能拿「累计失败数」当打印条件：第一批失败后它就已超过阈值，之后会全部静默
                        _log(f"[notes:{lang}] {mid} 批次 {span} 生成失败：{err}")
                        continue
                    for pno, note in result.items():
                        store.upsert_note(mid, pno, note, edited=0, lang=lang)
                        st["done"] += 1
                    got = set(result)
                    miss = [(p, t) for p, t in batch if p not in got]
                    if miss:
                        pending.extend(miss)
                        st["last_error"] = f"批次 {span} 有 {len(miss)} 页未解析出内容"
                        _log(f"[notes:{lang}] {mid} 批次 {span} 少 {len(miss)} 页（输出被截断或格式不符）：{[p for p, _ in miss]}")
                todo = pending
                st["failed"] = len(todo)

            st["failed"] = len(todo)
            if todo:
                _log(f"[notes:{lang}] {mid} 结束：仍有 {len(todo)} 页未完成 {[p for p, _ in todo][:12]}")
            else:
                _log(f"[notes:{lang}] {mid} 完成：{st['total']} 页全部有注释")
            st["running"] = False
        except Exception as e:  # noqa: BLE001
            st["running"] = False
            st["error"] = str(e)[:200]
            _log(f"[notes:{lang}] {mid} 任务异常：{e}")

    threading.Thread(target=run, daemon=True).start()


@router.post("/api/materials/{mid}/notes/generate")
def api_notes_generate(mid: str, lang: str = "zh"):
    mat = store.get_material(mid)
    if not mat or mat["deleted"]:
        raise HTTPException(404, "资料不存在")
    if (mat.get("ext") or "pdf") != "pdf":
        raise HTTPException(400, "沉浸模式只支持 PDF 课件")
    lang = _norm_lang(lang)
    key = _status_key(mid, lang)
    st = NOTE_STATUS.get(key)
    if st and st.get("running"):
        return {"started": False, "status": st}
    course = store.get_course(mat["course_id"])
    NOTE_STATUS[key] = {"running": True, "total": 0, "done": 0, "failed": 0, "lang": lang}
    _note_job(mid, course["name"] or course["code"] if course else "", lang)
    return {"started": True, "lang": lang}


@router.post("/api/materials/{mid}/notes/{page}/generate")
def api_note_generate_one(mid: str, page: int, lang: str = "zh"):
    """只生成**某一页**的注释（阅读界面里「生成本页注释」用）。

    和 `notes/generate` 的分工：列表页的「注释」按钮走全量补齐，
    这个只补当前页 —— 两个入口用途不同，别混。
    同步返回：单页通常几秒，没必要再搞一套轮询。
    """
    mat = _material_or_404(mid)
    _check_page(page)
    if (mat.get("ext") or "pdf") != "pdf":
        raise HTTPException(400, "仅 PDF 支持生成注释")
    lang = _norm_lang(lang)
    st = NOTE_STATUS.get(_status_key(mid, lang))
    if st and st.get("running"):
        raise HTTPException(409, "该资料正在批量生成注释，等它跑完再单独补页")
    pages = core.parse_pdf(material_file_path(mid, "pdf"))
    hit = [(p, t) for p, t in pages if p == page]
    if not hit:
        raise HTTPException(400, "这一页没有可提取的文字（纯图片页）")
    course = store.get_course(mat["course_id"])
    result, err = _fetch_batch(course["name"] or course["code"] if course else "", hit, lang)
    if err is not None:
        raise HTTPException(502, f"生成失败：{err}")
    note = result.get(page)
    if not note:
        raise HTTPException(502, "模型没有返回这一页的内容，可稍后重试")
    store.upsert_note(mid, page, note, edited=0, lang=lang)
    return {"ok": True, "page": page, "note": note, "lang": lang}


@router.get("/api/materials/{mid}/notes")
def api_notes_get(mid: str, lang: str = "zh"):
    """取注释。lang=zh（默认）/ en / es；返回里带 status，
    前端据此知道「这个语言还没生成过」还是「正在生成」。"""
    mat = store.get_material(mid)
    if not mat or mat["deleted"]:
        raise HTTPException(404, "资料不存在")
    lang = _norm_lang(lang)
    return {
        "notes": store.get_notes(mid, lang),
        "lang": lang,
        "status": NOTE_STATUS.get(_status_key(mid, lang)) or {"running": False},
    }


@router.put("/api/materials/{mid}/notes/{page}")
def api_note_put(mid: str, page: int, body: dict):
    mat = store.get_material(mid)
    if not mat or mat["deleted"]:
        raise HTTPException(404, "资料不存在")
    content = (body.get("content") or "").strip()
    if not content:
        raise HTTPException(400, "注释内容不能为空")
    store.upsert_note(mid, page, content, edited=1, lang=_norm_lang(body.get("lang", "zh")))
    return {"ok": True}


# ---------- 页面圈画 ----------

INK_MAX_CHARS = 800_000      # 单页笔画数据上限，防止异常数据撑爆存储


def _material_or_404(mid: str):
    mat = store.get_material(mid)
    if not mat or mat["deleted"]:
        raise HTTPException(404, "资料不存在")
    return mat


def _check_page(page: int):
    if page < 1:
        raise HTTPException(400, "页码不合法")


@router.get("/api/materials/{mid}/ink/{page}")
def api_ink_get(mid: str, page: int):
    _material_or_404(mid)
    _check_page(page)
    return {"data": store.get_ink(mid, page)}


@router.put("/api/materials/{mid}/ink/{page}")
def api_ink_put(mid: str, page: int, body: dict):
    _material_or_404(mid)
    _check_page(page)
    data = body.get("data")
    if not isinstance(data, str) or len(data) > INK_MAX_CHARS:
        raise HTTPException(400, "标注数据不合法")
    store.set_ink(mid, page, data)
    return {"ok": True}


@router.get("/api/materials/{mid}/outline")
def api_outline(mid: str):
    """PDF 内嵌目录（书签）。返回 [{level, title, page}]，没有目录则空列表。

    在后端一次性解析：教材动辄几百上千个书签，前端逐项解析会卡好几秒。
    """
    mat = _material_or_404(mid)
    if (mat.get("ext") or "pdf") != "pdf":
        return {"items": []}
    try:
        import fitz
        d = fitz.open(material_file_path(mid, "pdf"))
        toc = d.get_toc(simple=True)
        d.close()
        return {"items": [{"level": lv, "title": t, "page": pg} for lv, t, pg in toc]}
    except Exception as e:  # noqa: BLE001
        return {"items": [], "error": str(e)[:120]}


@router.get("/api/materials/{mid}/marked-pages")
def api_marked_pages(mid: str):
    """哪些页有圈画，供页面标记用。"""
    _material_or_404(mid)
    return store.marked_pages(mid)
