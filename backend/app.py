"""应用装配层：中间件 + 路由注册 + 前端静态资源托管。

业务路由按领域拆分在 backend/routers/ 下：
    courses   课程 CRUD / 考核构成 / HandBook
    materials 资料上传阅读导出 / 回收区 / 跨课程总库 / 批量导入
    notes     沉浸模式逐页注释
    chat      问答与出题（流式）
    todos     待办事项
    settings  设置与健康检查
"""
import os

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import store
from .routers import chat, courses, materials, notes, settings, todos

app = FastAPI(title="Self-Learning Space")
store.init_db()


@app.middleware("http")
async def no_cache_frontend(request, call_next):
    """前端 js/css/html 禁止缓存，保证改版即时生效。"""
    resp = await call_next(request)
    path = request.url.path
    if path in ("/", "/index.html") or path.endswith(".js") or path.endswith(".css"):
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


for _router in (courses.router, materials.router, notes.router,
                chat.router, todos.router, settings.router):
    app.include_router(_router)


# ---------- 前端静态资源（必须最后挂载，避免吞掉 /api 路由）----------

frontend_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend")
app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
