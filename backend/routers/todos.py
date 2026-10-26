"""待办事项（DDL 清单）。"""
from fastapi import APIRouter, HTTPException

from .. import store

router = APIRouter()

@router.get("/api/todos")
def api_todos():
    return store.list_todos()


@router.post("/api/todos")
def api_add_todo(body: dict):
    content = (body.get("content") or "").strip()
    if not content:
        raise HTTPException(400, "事项内容不能为空")
    store.add_todo(content, str(body.get("due") or ""), str(body.get("course_id") or ""))
    return {"ok": True}


@router.post("/api/todos/reorder")
def api_reorder_todos(body: dict):
    """按传入的 id 顺序重排（拖拽排序用）。"""
    ids = body.get("ids") or []
    if not isinstance(ids, list) or not ids:
        raise HTTPException(400, "缺少排序列表")
    store.reorder_todos(ids[:500])
    return {"ok": True}


@router.patch("/api/todos/{tid}")
def api_update_todo(tid: int, body: dict):
    fields = {}
    if "done" in body:
        fields["done"] = 1 if body["done"] else 0
    if "content" in body:
        fields["content"] = str(body["content"]).strip()
    if "due" in body:
        fields["due"] = str(body["due"] or "")
    if "course_id" in body:
        fields["course_id"] = str(body["course_id"] or "")
    if fields:
        store.update_todo(tid, **fields)
    return {"ok": True}


@router.delete("/api/todos/{tid}")
def api_delete_todo(tid: int):
    store.delete_todo(tid)
    return {"ok": True}
