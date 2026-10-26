"""设置、前端元数据与健康检查。"""
from fastapi import APIRouter

from ..config import load_config, save_config
from ..deps import TAGS

router = APIRouter()


@router.get("/api/meta")
def api_meta():
    """前端需要的静态元数据（标签清单等）：单一来源，避免前后端各写一份。"""
    return {"tags": TAGS}


@router.get("/api/settings")
def api_get_settings():
    cfg = load_config()
    return {k: cfg[k] for k in ("model", "threshold", "top_k")} | {
        "has_key": bool(cfg.get("api_key")),
    }


@router.post("/api/settings")
def api_set_settings(body: dict):
    patch = {}
    if "api_key" in body:
        patch["api_key"] = body["api_key"].strip()
    for k in ("model", "threshold", "top_k"):
        if k in body:
            patch[k] = body[k]
    save_config(patch)
    return {"ok": True}


@router.get("/api/health")
def api_health():
    return {"ok": True}
