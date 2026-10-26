"""练习闭环的离线验证：判分正确性 + 作答记录 + 薄弱点统计。

全程走真实 HTTP 接口，最后精确清理测试数据（只删本脚本插入的题）。
"""
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import store
from backend.routers.chat import _judge, _pick_letter

BASE = "http://127.0.0.1:8765"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
MARK = "ZZ_TEST_练习闭环"


def post(path, payload):
    req = urllib.request.Request(
        BASE + path, method="POST",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with OPENER.open(req, timeout=15) as r:
        return json.load(r)


def get(path):
    with OPENER.open(BASE + path, timeout=15) as r:
        return json.load(r)


print("== 1. 选项字母提取 ==")
for s, want in [("A", "A"), ("a", "A"), ("A. 选项文字", "A"), ("(B)", "B"), ("（c）", "C"),
                ("", ""), ("无", "")]:
    got = _pick_letter(s)
    print(f"  {'OK ' if got == want else 'BAD'}  {s!r:16s} -> {got!r}")

print("\n== 2. 判分（服务端口径）==")
cases = [
    ({"answer": "A"}, "A", True),
    ({"answer": "A"}, "a", True),
    ({"answer": "A"}, "A. 随便什么文字", True),
    ({"answer": "B"}, "(b)", True),
    ({"answer": "A"}, "C", False),
    ({"answer": "A"}, "", False),
    ({"answer": ""}, "A", False),
]
bad = 0
for q, pick, want in cases:
    got = _judge(q, pick)
    if got != want:
        bad += 1
    print(f"  {'OK ' if got == want else 'BAD'}  答案={q['answer']!r:5s} 作答={pick!r:18s} -> {got}")
print(f"  → 失败 {bad} 个")

# ---------- 3. 造题 → 作答 → 查薄弱点 ----------
c = next((x for x in store.list_courses() if x["code"] != "UNFILED"), None)
cid = c["id"]
print(f"\n== 3. 端到端（课程 {c['code']}）==")

qs = store.save_quiz_questions(cid, [
    {"question": f"{MARK} 第1题", "options": ["A. 甲", "B. 乙", "C. 丙", "D. 丁"],
     "answer": "B", "explanation": "测试用", "refs": []},
    {"question": f"{MARK} 第2题", "options": ["A. 甲", "B. 乙", "C. 丙", "D. 丁"],
     "answer": "C", "explanation": "测试用", "refs": []},
    {"question": f"{MARK} 第3题", "options": ["A. 甲", "B. 乙", "C. 丙", "D. 丁"],
     "answer": "A", "explanation": "测试用", "refs": []},
])
ids = [q["id"] for q in qs]
print(f"  已插入测试题 id={ids}，落库类型={[q['kind'] for q in qs]}")

r1 = post(f"/api/quiz/questions/{ids[0]}/attempt", {"answer": "B"})   # 对
r2 = post(f"/api/quiz/questions/{ids[1]}/attempt", {"answer": "A"})   # 错（正解 C）
r3 = post(f"/api/quiz/questions/{ids[2]}/attempt", {"answer": "A"})   # 对
print(f"  第1题答 B(正解 B) -> correct={r1['correct']}  （期望 True）")
print(f"  第2题答 A(正解 C) -> correct={r2['correct']}  （期望 False）")
print(f"  第3题答 A(正解 A) -> correct={r3['correct']}  （期望 True）")
assert r1["correct"] is True and r2["correct"] is False and r3["correct"] is True

print("\n== 4. 薄弱点（错题）==")
w = get(f"/api/courses/{cid}/quiz/wrong")
print(f"  错题数: {len(w['questions'])}（期望 1）")
for q in w["questions"]:
    print(f"    id={q['id']} 答了 {q['user_answer']!r}，正解 {q['answer']!r}｜{q['question'][:22]}")
assert len(w["questions"]) == 1 and w["questions"][0]["id"] == ids[1]

print("\n== 5. 重练：答对后应从错题里消失 ==")
r4 = post(f"/api/quiz/questions/{ids[1]}/attempt", {"answer": "C"})   # 重做答对
print(f"  重做第2题答 C -> correct={r4['correct']}")
w2 = get(f"/api/courses/{cid}/quiz/wrong")
print(f"  错题数: {len(w2['questions'])}（期望 0 = 环闭上了）")
assert len(w2["questions"]) == 0

st = get(f"/api/courses/{cid}/quiz/stats")
print(f"\n== 6. 统计 ==\n  {st}")

# ---------- 7. 精确清理 ----------
print("\n== 7. 清理测试数据 ==")
from backend.store import _conn
with _conn() as conn:
    for qid in ids:
        conn.execute("DELETE FROM quiz_attempts WHERE question_id=?", (qid,))
        conn.execute("DELETE FROM quiz_questions WHERE id=?", (qid,))
left = store.quiz_stats(cid)
print(f"  已删除测试题 {ids}；课程统计回到 {left}")
print(f"  残留测试题: {len([q for q in store.list_wrong_questions(cid) if MARK in q['question']])}")
