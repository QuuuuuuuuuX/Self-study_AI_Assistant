"""问答与出题（流式 SSE）。"""
import json
import re
import threading

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from .. import core, store
from ..deps import course_or_404

router = APIRouter()

@router.post("/api/courses/{cid}/chat")
async def api_chat(cid: str, body: dict):
    course_or_404(cid)
    question = (body.get("question") or "").strip()
    mode = body.get("mode", "ask")
    # 「允许外部资料」开关：开启后检索范围扩到全部课程，且允许模型用自有知识补充
    allow_external = bool(body.get("allow_external"))
    if mode == "ask" and not question:
        raise HTTPException(400, "问题不能为空")

    def gen():
        for event in core.stream_chat(cid, question, mode, allow_external=allow_external):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.post("/api/courses/{cid}/quiz")
def api_quiz(cid: str, body: dict):
    course_or_404(cid)
    material_ids = [m for m in (body.get("material_ids") or []) if isinstance(m, str)]
    if not material_ids:
        raise HTTPException(400, "请至少选择一份资料作为出题范围")
    try:
        num = min(max(int(body.get("num", 5)), 1), 20)
    except (TypeError, ValueError):
        num = 5
    kind = body.get("kind", "choice")
    try:
        r = core.generate_quiz(cid, material_ids, num=num, kind=kind)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:  # 未配置 API Key 等
        raise HTTPException(400, str(e))
    # 落库后再返回：题目带 id，前端才能提交作答、后续才能统计薄弱点与重练。
    # 落库时同步写覆盖率台账（同一事务），所以这里能立刻拿到最新覆盖情况。
    r["questions"] = store.save_quiz_questions(cid, r.get("questions") or [])
    r["stats"] = store.quiz_stats(cid)
    r["coverage"] = core.coverage_report(cid, material_ids)
    return r


# ---------- 全面覆盖出题（后台任务）----------
# 一轮覆盖可能是几十批、十几分钟，远超普通请求的容忍范围，所以放后台跑，
# 前端轮询进度。每个课程同时只允许一个任务（用 cid 做 key）。

FULL_JOBS: dict[str, dict] = {}


@router.get("/api/courses/{cid}/quiz/coverage")
def api_coverage(cid: str, material_ids: str = ""):
    """覆盖率报告：总体进度、按资料明细、剩余批次与耗时预估。"""
    course_or_404(cid)
    ids = [x for x in (material_ids or "").split(",") if x]
    return core.coverage_report(cid, ids or None)


@router.post("/api/courses/{cid}/quiz/full")
def api_quiz_full(cid: str, body: dict):
    """启动全面覆盖：遍历范围内所有未出过题的知识点。

    一次运行有批次上限（默认 40 批），跑完会告诉用户还剩多少 —— 上千页的教材
    不可能一轮跑完，宁可让用户分几次推进，也不要他对着进度条干等一小时。
    """
    course_or_404(cid)
    material_ids = [m for m in (body.get("material_ids") or []) if isinstance(m, str)]
    if not material_ids:
        raise HTTPException(400, "请至少选择一份资料作为出题范围")
    cur = FULL_JOBS.get(cid)
    if cur and cur.get("status") == "running":
        raise HTTPException(400, "这门课已有一轮全面覆盖在进行中")
    try:
        limit = min(max(int(body.get("max_batches", 40)), 1), 200)
    except (TypeError, ValueError):
        limit = 40
    kind = body.get("kind", "choice")
    report = core.coverage_report(cid, material_ids, batch_limit=limit)
    if not report["pending"]:
        return {"started": False, "reason": "范围内所有知识点都已出过题",
                "coverage": report}

    state = {"status": "running", "done": 0, "total": report["this_run_batches"],
             "added": 0, "error": None, "note": None}
    FULL_JOBS[cid] = state

    def run():
        def on_progress(done, total, added):
            state.update(status="running", done=done, total=total, added=added)

        try:
            res = core.generate_quiz_full(cid, material_ids, kind=kind,
                                          on_progress=on_progress, max_batches=limit)
            left = max(0, res["pending_units"] - res["added"])
            state.update(
                status="ok", added=res["added"], pending_left=left,
                note=(f"本轮覆盖 {res['added']} 个知识点，还剩约 {left} 个，可再点一次继续"
                      if left else "全部知识点已覆盖"),
            )
        except Exception as e:  # noqa: BLE001
            state.update(status="failed", error=str(e)[:300])

    threading.Thread(target=run, daemon=True).start()
    return {"started": True, "coverage": report, "max_batches": limit}


@router.get("/api/courses/{cid}/quiz/full")
def api_quiz_full_status(cid: str, material_ids: str = ""):
    """全面覆盖的进度 + 最新覆盖率（前端一次轮询拿两样）。"""
    course_or_404(cid)
    ids = [x for x in (material_ids or "").split(",") if x]
    return {
        "job": FULL_JOBS.get(cid),
        "coverage": core.coverage_report(cid, ids or None),
        "stats": store.quiz_stats(cid),
    }


def _pick_letter(s: str) -> str:
    """从「A」「A.」「a、」「(B)」里取出选项字母。"""
    m = re.match(r"^\s*[（(]?\s*([A-Za-z])", s or "")
    return m.group(1).upper() if m else ""


def _judge(q: dict, pick: str) -> bool:
    """判断题干对错。只认选项字母，且忽略大小写与前缀格式差异。

    服务端重新判定一次：前端只是为了即时反馈，落库的对错必须由服务端说了算，
    否则前端一改就能把错的记成对的，薄弱点统计立刻失去意义。
    """
    ans, pick = _pick_letter(q.get("answer") or ""), _pick_letter(pick)
    return bool(pick) and pick == ans


@router.post("/api/quiz/questions/{qid}/attempt")
def api_attempt(qid: int, body: dict):
    q = store.get_quiz_question(qid)
    if not q:
        raise HTTPException(404, "题目不存在")
    if not (q.get("options") or []):
        raise HTTPException(400, "该题不是选择题，暂不支持自动判分")
    pick = str(body.get("answer") or "").strip()
    correct = _judge(q, pick)
    store.record_attempt(qid, pick, correct)
    st = store.quiz_stats(q["course_id"])
    return {
        "correct": correct,
        "answer": q.get("answer"),
        "explanation": q.get("explanation"),
        "stats": st,
    }


@router.get("/api/courses/{cid}/quiz/wrong")
def api_wrong(cid: str):
    """薄弱点列表：最近一次作答仍是错的题。也是「重练错题」的数据源。"""
    course_or_404(cid)
    return {"questions": store.list_wrong_questions(cid), "stats": store.quiz_stats(cid)}


@router.get("/api/courses/{cid}/quiz/stats")
def api_quiz_stats(cid: str):
    course_or_404(cid)
    return store.quiz_stats(cid)
