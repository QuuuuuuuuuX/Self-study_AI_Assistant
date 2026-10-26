"""课程域路由：课程 CRUD、对话记录、考核构成、HandBook。"""
import os

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import core, store
from ..config import material_file_path
from ..deps import ALLOWED_EXTS, GROUPS, TAGS, course_or_404

router = APIRouter()

@router.get("/api/courses")
def api_courses():
    return store.list_courses()


@router.post("/api/courses")
def api_create_course(code: str = Form(...), name: str = Form(""),
                      semester: str = Form(""), group: str = Form("major"),
                      credits: str = Form("0")):
    if not code.strip():
        raise HTTPException(400, "课程代码不能为空")
    if group not in GROUPS:
        group = "major"
    cid = store.create_course(code, name, semester, group)
    try:
        store.update_course(cid, credits=max(0.0, float(credits or 0)))
    except ValueError:
        pass
    return {"id": cid}


@router.patch("/api/courses/{cid}")
def api_update_course(cid: str, body: dict):
    course_or_404(cid)
    fields = {}
    if "name" in body:
        fields["name"] = str(body["name"]).strip()
    if "semester" in body:
        fields["semester"] = str(body["semester"]).strip()
    if "group" in body:
        if body["group"] not in GROUPS:
            raise HTTPException(400, "无效的分组")
        fields["course_group"] = body["group"]
    if "credits" in body:
        try:
            fields["credits"] = max(0.0, float(body["credits"]))
        except (TypeError, ValueError):
            raise HTTPException(400, "学分必须是数字")
    if fields:
        store.update_course(cid, **fields)
    return {"ok": True}


@router.delete("/api/courses/{cid}")
def api_delete_course(cid: str):
    course_or_404(cid)
    store.delete_course(cid)
    return {"ok": True}


@router.get("/api/courses/{cid}/messages")
def api_messages(cid: str):
    course_or_404(cid)
    return store.list_messages(cid)


@router.delete("/api/courses/{cid}/messages")
def api_clear_messages(cid: str):
    course_or_404(cid)
    store.clear_messages(cid)
    return {"ok": True}


@router.post("/api/courses/{cid}/materials")
def api_upload(cid: str, file: UploadFile = File(...), tag: str = Form("")):
    course_or_404(cid)
    ext = (file.filename or "").lower().rsplit(".", 1)[-1]
    if ext not in ALLOWED_EXTS:
        raise HTTPException(400, "目前支持 PDF 和 Word (.docx) 文件")
    data = file.file.read()
    if not data:
        raise HTTPException(400, "文件为空")
    if tag not in TAGS:
        tag = core.guess_tag(file.filename or "")  # 自动判定资料性质
    mid = store.add_material(cid, file.filename, tag, len(data), ext)
    with open(material_file_path(mid, ext), "wb") as f:
        f.write(data)
    core.process_material_async(mid)
    return {"id": mid, "tag": tag}


@router.get("/api/courses/{cid}/materials")
def api_materials(cid: str, q: str = ""):
    course_or_404(cid)
    return store.list_materials(cid, query=q.strip())


@router.get("/api/courses/{cid}/assessments")
def api_list_assessments(cid: str):
    course_or_404(cid)
    return store.list_assessments(cid)


@router.put("/api/courses/{cid}/assessments")
def api_put_assessments(cid: str, body: dict):
    course_or_404(cid)
    items = body.get("items") or []
    if not isinstance(items, list) or len(items) > 20:
        raise HTTPException(400, "考核构成不合法")
    clean = []
    for it in items:
        score = it.get("score")
        clean.append({
            "name": it.get("name"),
            "weight": it.get("weight"),
            "score": float(score) if score not in (None, "") else None,
        })
    store.replace_assessments(cid, clean)
    return {"ok": True}


@router.post("/api/courses/{cid}/handbook")
async def api_upload_handbook(cid: str, file: UploadFile = File(...)):
    """上传 HandBook 并 AI 扫描考核构成（预填，可手工改）。"""
    course = course_or_404(cid)
    filename = file.filename or ""
    ext = filename.lower().rsplit(".", 1)[-1]
    if ext not in ALLOWED_EXTS:
        raise HTTPException(400, "HandBook 支持 PDF / Word 文件")
    data = await file.read()
    if not data:
        raise HTTPException(400, "文件为空")
    from ..config import handbook_path
    hpath = handbook_path(cid, ext)
    with open(hpath, "wb") as f:
        f.write(data)
    # 删除另一种扩展名的旧文件
    for e in ALLOWED_EXTS - {ext}:
        try:
            os.remove(handbook_path(cid, e))
        except OSError:
            pass
    # 复用 handbook 的扫描落库逻辑（考核构成 → assessment，DDL → 待办），
    # 与「手动重扫」走同一条路径；函数内 import 避免与 materials 模块循环依赖
    from .materials import apply_handbook_scan
    try:
        r = apply_handbook_scan(cid, hpath, ext)
    except RuntimeError as e:  # 未配置 Key
        raise HTTPException(400, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {
        "components": r["components"],
        "ddls": r["ddls"],
        "added_todos": r["added_todos"],
        "weight_total": sum(c["weight"] for c in r["components"]),
        "note": r["note"],
    }


@router.get("/api/courses/{cid}/handbook/info")
def api_handbook_info(cid: str):
    course_or_404(cid)
    from ..config import handbook_path
    for ext in ("pdf", "docx"):
        if os.path.exists(handbook_path(cid, ext)):
            return {"has": True, "ext": ext}
    return {"has": False, "ext": None}


@router.get("/api/courses/{cid}/handbook/file")
def api_handbook_file(cid: str):
    course_or_404(cid)
    from ..config import handbook_path
    for ext in ("pdf", "docx"):
        path = handbook_path(cid, ext)
        if os.path.exists(path):
            return FileResponse(path, filename=f"HandBook.{ext}")
    raise HTTPException(404, "尚未上传 HandBook")


@router.get("/api/courses/{cid}/handbook/html")
def api_handbook_html(cid: str):
    from ..config import handbook_path
    course_or_404(cid)
    path = handbook_path(cid, "docx")
    if not os.path.exists(path):
        raise HTTPException(404, "尚未上传 HandBook")
    return {"html": core.docx_to_html_cached(path)}
