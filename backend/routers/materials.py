"""资料域路由：上传 / 阅读 / 导出 / 回收区 / 跨课程总库 / 批量导入。"""
import io
import os
import threading
import zipfile

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from .. import core, store
from ..config import material_file_path
from ..deps import ALLOWED_EXTS, COURSE_CODE_RE, TAGS, UNFILED_CODE

router = APIRouter()

@router.get("/api/materials/{mid}/pdf")
def api_material_pdf(mid: str):
    mat = store.get_material(mid)
    if not mat or mat["deleted"]:
        raise HTTPException(404, "资料不存在")
    ext = (mat.get("ext") or "pdf").lower()
    return FileResponse(material_file_path(mid, ext), filename=mat["orig_name"])


@router.get("/api/materials/{mid}/docx-html")
def api_material_docx_html(mid: str):
    """docx 转 HTML，供内置阅读器展示。"""
    mat = store.get_material(mid)
    if not mat or mat["deleted"]:
        raise HTTPException(404, "资料不存在")
    if (mat.get("ext") or "pdf").lower() != "docx":
        raise HTTPException(400, "该资料不是 Word 文档")
    return {"html": core.docx_to_html_cached(material_file_path(mid, "docx"))}


@router.patch("/api/materials/{mid}")
def api_update_material(mid: str, body: dict):
    mat = store.get_material(mid)
    if not mat:
        raise HTTPException(404, "资料不存在")
    if "tag" in body:
        if body["tag"] not in TAGS:
            raise HTTPException(400, "无效的标签")
        # tag_locked：人工定过的标签，后续 AI 分析不再覆盖
        store.update_material(mid, tag=body["tag"], tag_locked=1)
    return {"ok": True}


@router.get("/api/materials/{mid}/download")
def api_download_material(mid: str):
    mat = store.get_material(mid)
    if not mat or mat["deleted"]:
        raise HTTPException(404, "资料不存在")
    ext = (mat.get("ext") or "pdf").lower()
    return FileResponse(
        material_file_path(mid, ext), filename=mat["orig_name"],
        media_type="application/octet-stream",
    )


@router.post("/api/materials/export")
def api_export_materials(body: dict):
    """多选导出：打包为 zip（单个文件走 /download 直接下载）。"""
    import io as _io
    import zipfile as _zipfile

    ids = [i for i in (body.get("ids") or []) if isinstance(i, str)]
    if not ids:
        raise HTTPException(400, "请先选择要导出的资料")
    mats = []
    for mid in ids[:200]:
        m = store.get_material(mid)
        if m and not m["deleted"]:
            mats.append(m)
    if not mats:
        raise HTTPException(404, "没有可导出的资料")

    buf = _io.BytesIO()
    used_names = set()
    with _zipfile.ZipFile(buf, "w", _zipfile.ZIP_DEFLATED) as z:
        for m in mats:
            ext = (m.get("ext") or "pdf").lower()
            path = material_file_path(m["id"], ext)
            if not os.path.exists(path):
                continue
            arc = store.fix_zip_name(m["orig_name"])   # 库里若存了 CP437 乱码名，导出时还原
            if arc in used_names:  # 重名去重：加序号前缀
                arc = f"{len(used_names) + 1}_{arc}"
            used_names.add(arc)
            z.write(path, arc)
    buf.seek(0)
    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="materials_export.zip"'},
    )


@router.post("/api/materials/{mid}/delete")
def api_delete_material(mid: str):
    mat = store.get_material(mid)
    if not mat:
        raise HTTPException(404, "资料不存在")
    store.soft_delete_material(mid)
    return {"ok": True}


@router.post("/api/materials/{mid}/restore")
def api_restore_material(mid: str):
    mat = store.get_material(mid)
    if mat:
        # 若原课程已被删除，恢复到「未分类」，保证资料永不丢失
        if not store.get_course(mat["course_id"]):
            unfiled = store.get_or_create_course(UNFILED_CODE, name="未分类")
            store.move_material(mid, unfiled["id"])
        store.restore_material(mid)
    return {"ok": True}


@router.post("/api/materials/{mid}/purge")
def api_purge_material(mid: str):
    mat = store.purge_material(mid)
    if mat:
        for ext in ALLOWED_EXTS:
            try:
                os.remove(material_file_path(mid, ext))
            except OSError:
                pass
    return {"ok": True}


@router.get("/api/recycle")
def api_recycle():
    """回收区：所有被软删除的资料（含课程已被删除的孤儿资料）。"""
    rows = store.materials_with_course(deleted=1)
    out = []
    for r in rows:
        m = dict(r)
        m["course_code"] = m["course_code"] or "（课程已删除）"
        out.append(m)
    return out


# ---------- 阅读进度（续读记忆）与文件笔记 ----------

@router.get("/api/progress/latest")
def api_latest_progress():
    """最近读过的那份资料，供主页「继续上次」使用。"""
    return store.latest_progress() or {}


@router.get("/api/materials/{mid}/progress")
def api_get_progress(mid: str):
    if not store.get_material(mid):
        raise HTTPException(404, "资料不存在")
    return {"page": store.get_progress(mid)}


@router.put("/api/materials/{mid}/progress")
def api_set_progress(mid: str, body: dict):
    if not store.get_material(mid):
        raise HTTPException(404, "资料不存在")
    try:
        page = max(1, int(body.get("page") or 1))
    except (TypeError, ValueError):
        raise HTTPException(400, "页码不合法")
    store.set_progress(mid, page)
    return {"ok": True}


@router.get("/api/materials/{mid}/mynote")
def api_get_mynote(mid: str):
    """文件笔记（自己写的，与 AI 逐页注释分开存）。"""
    if not store.get_material(mid):
        raise HTTPException(404, "资料不存在")
    return {"content": store.get_my_note(mid)}


@router.put("/api/materials/{mid}/mynote")
def api_set_mynote(mid: str, body: dict):
    if not store.get_material(mid):
        raise HTTPException(404, "资料不存在")
    store.set_my_note(mid, str(body.get("content") or "")[:20000])
    return {"ok": True}


@router.get("/api/materials/all")
def api_all_materials(q: str = "", tag: str = ""):
    """跨课程的全库资料视图（不含回收区）。"""
    return store.materials_with_course(query=q, tag=tag)


def _ingest_file_bytes(course_id: str, filename: str, raw: bytes) -> str:
    ext = filename.lower().rsplit(".", 1)[-1]
    mid = store.add_material(course_id, filename, core.guess_tag(filename), len(raw), ext)
    with open(material_file_path(mid, ext), "wb") as f:
        f.write(raw)
    core.process_material_async(mid)
    return mid


def _extract_course_code(filename: str) -> str | None:
    """从文件名提取课程代码。

    支持 CPT203-Lecture1 / CPT203Lecture1 / cpt203a / BUS102_习题 等写法：
    尾字母只有在不是单词开头时才并入代码（CPT203A 保留，CPT203Lecture 裁掉）。
    """
    s = os.path.basename(filename).upper()
    m = COURSE_CODE_RE.search(s)
    if not m:
        return None
    code = f"{m.group(1)}{m.group(2)}"
    suffix = m.group(3)
    if suffix and m.end() < len(s) and s[m.end()].isalpha():
        suffix = ""
    return code + (suffix or "")


# HandBook 后台扫描状态（内存）：cid -> {"status": "scanning"/"ok"/"failed", "note": str}


HB_SCAN_STATUS: dict[str, dict] = {}


def apply_handbook_scan(cid: str, path: str, ext: str) -> dict:
    """扫描 HandBook 并落库：考核构成 → assessments，DDL → 待办。

    上传时和「手动重扫」共用这一条路径，避免两处各写一遍后逻辑漂移。
    返回 {"components", "ddls", "skipped", "added_todos", "note"}
    """
    res = core.scan_handbook(path, ext)
    comps, ddls = res["components"], res["ddls"]

    store.replace_assessments(
        cid, [{"name": c["name"], "weight": c["weight"], "score": None} for c in comps])
    total = sum(c["weight"] for c in comps)
    note = None if abs(total - 100) < 0.5 else f"权重合计 {total:g}%，请核对"

    # DDL 落到待办，并记下来源课程（待办列表要靠它区分是哪一科）。
    # 按「课程 + 名称 + 日期」去重：重扫同一份手册不该刷出一堆重复待办
    existing = {(t.get("course_id", ""), t["content"], t["due"]) for t in store.list_todos()}
    added = 0
    for d in ddls:
        key = (cid, d["title"], d["due"])
        if key in existing:
            continue
        store.add_todo(d["title"], d["due"], cid)
        existing.add(key)
        added += 1

    return {"components": comps, "ddls": ddls, "skipped": res.get("skipped", []),
            "added_todos": added, "note": note}


def find_handbook(cid: str):
    """返回 (路径, 扩展名)；该课程没有 HandBook 时返回 None。"""
    from ..config import handbook_path
    from ..deps import ALLOWED_EXTS   # 注意：ALLOWED_EXTS 定义在 deps，不在 config
    for e in ALLOWED_EXTS:
        p = handbook_path(cid, e)
        if os.path.exists(p):
            return p, e
    return None


def _scan_handbook_job(cid: str, path: str, ext: str):
    def run():
        try:
            r = apply_handbook_scan(cid, path, ext)
            HB_SCAN_STATUS[cid] = {"status": "ok", "note": r["note"],
                                   "count": len(r["components"]), "ddls": r["added_todos"]}
        except Exception as e:  # noqa: BLE001
            HB_SCAN_STATUS[cid] = {"status": "failed", "note": str(e)[:200]}
    threading.Thread(target=run, daemon=True).start()


@router.post("/api/courses/{cid}/handbook/scan")
def api_handbook_rescan(cid: str):
    """对**已上传**的 HandBook 重新扫描，不需要重新上传文件。

    提取考核构成（写入 assessment）与 DDL（写入待办），同步返回结果。
    """
    if not store.get_course(cid):
        raise HTTPException(404, "课程不存在")
    got = find_handbook(cid)
    if not got:
        raise HTTPException(404, "这门课还没有上传 HandBook")
    path, ext = got
    try:
        r = apply_handbook_scan(cid, path, ext)
    except RuntimeError as e:      # 未配置 API Key
        raise HTTPException(400, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, **r}


@router.post("/api/batch-import")
async def api_batch_import(file: UploadFile = File(...)):
    name = file.filename or ""
    if not name.lower().endswith(".zip"):
        raise HTTPException(400, "请上传 .zip 压缩包")
    data = await file.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HTTPException(400, "压缩包无法读取，请确认是有效的 zip 文件")

    matched, unmatched, codes = [], [], set()
    handbooks, hb_skipped = [], []
    skipped_count = 0
    with zf:
        for info in zf.infolist():
            # zip 里没有 UTF-8 标志位时，zipfile 按 CP437 解码文件名，
            # macOS 的 NFD 名字会变成「Sesio╠ün」这种乱码 —— 必须在入库前还原
            base = os.path.basename(store.fix_zip_name(info.filename))
            if info.is_dir() or not base or "__MACOSX" in info.filename:
                continue
            ext = base.lower().rsplit(".", 1)[-1] if "." in base else ""
            if ext not in ALLOWED_EXTS or base.startswith("."):
                skipped_count += 1
                continue
            try:
                raw = zf.read(info)
            except Exception:
                continue
            if not raw:
                continue
            code = _extract_course_code(base)
            # HandBook：文件名含 handbook 的，归到对应课程并后台 AI 扫描
            if "handbook" in base.lower():
                if not code:
                    hb_skipped.append(base)
                    skipped_count += 1
                    continue
                course = store.get_or_create_course(code)
                codes.add(course["code"])
                from ..config import handbook_path
                hpath = handbook_path(course["id"], ext)
                with open(hpath, "wb") as f:
                    f.write(raw)
                for e in ALLOWED_EXTS - {ext}:
                    try:
                        os.remove(handbook_path(course["id"], e))
                    except OSError:
                        pass
                HB_SCAN_STATUS[course["id"]] = {"status": "scanning", "note": None}
                _scan_handbook_job(course["id"], hpath, ext)
                handbooks.append({"file": base, "course": course["code"]})
                continue
            if code:
                course = store.get_or_create_course(code)
                codes.add(course["code"])
                mid = _ingest_file_bytes(course["id"], base, raw)
                matched.append({"file": base, "course": course["code"], "id": mid})
            else:
                course = store.get_or_create_course(UNFILED_CODE, name="未分类")
                codes.add(course["code"])
                mid = _ingest_file_bytes(course["id"], base, raw)
                unmatched.append({"file": base, "id": mid})
    return {
        "matched": matched,
        "unmatched": unmatched,
        "handbooks": handbooks,
        "hb_skipped": hb_skipped,
        "skipped_note": f"已跳过 {skipped_count} 个不支持的文件" if skipped_count else "",
        "courses_touched": sorted(codes),
    }


# ---------- 入库 AI 分析的补跑（给升级前入库的老资料用） ----------

ANALYZE_PROGRESS = {"on": False, "done": 0, "total": 0}


@router.get("/api/materials/analyze-status")
def api_analyze_status(course_id: str = ""):
    return {"pending": len(store.pending_analysis(course_id)), **ANALYZE_PROGRESS}


@router.post("/api/materials/analyze")
def api_analyze_pending(body: dict | None = None):
    """给还没分析的资料补跑一次入库分析。每份资料一次 AI 调用，前台可见进度。"""
    course_id = (body or {}).get("course_id") or ""
    pending = store.pending_analysis(course_id)
    if not pending or ANALYZE_PROGRESS["on"]:
        return {"started": 0, "pending": len(pending)}

    def run():
        ANALYZE_PROGRESS.update(on=True, done=0, total=len(pending))
        try:
            for i, m in enumerate(pending, 1):
                core.analyze_material(m["id"])
                ANALYZE_PROGRESS["done"] = i
        finally:
            ANALYZE_PROGRESS["on"] = False

    threading.Thread(target=run, daemon=True).start()
    return {"started": len(pending), "pending": len(pending)}


@router.post("/api/materials/{mid}/adopt-course")
def api_adopt_course(mid: str):
    """按 AI 判定的课程代码把资料归入对应课程（课程不存在则新建）。"""
    mat = store.get_material(mid)
    if not mat:
        raise HTTPException(404, "资料不存在")
    code = (mat.get("ai_course") or "").strip().upper()
    if not code:
        raise HTTPException(400, "这份资料没有可用的课程识别结果")
    course = store.get_or_create_course(code)
    store.move_material(mid, course["id"])
    return {"ok": True, "course_id": course["id"], "course_code": course["code"]}


@router.post("/api/materials/{mid}/move")
def api_move_material(mid: str, body: dict):
    mat = store.get_material(mid)
    if not mat:
        raise HTTPException(404, "资料不存在")
    target = body.get("course_id", "")
    if not store.get_course(target):
        raise HTTPException(404, "目标课程不存在")
    store.move_material(mid, target)
    return {"ok": True}
