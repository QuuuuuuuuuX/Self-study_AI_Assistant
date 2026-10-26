"""离线校验：日期解析 + 防幻觉白名单（不调用任何 API）。

这是「DDL 日期写错」的防线测试。要点：
- 日期换算在 Python 侧做，所以各种写法都必须解析正确；
- 白名单按「出现位置」而非「日期值」判断，因为同一日期可能既在补考区块、
  又在主表格里合法出现（ISA104 的 09/Oct/2026 就是这种情况）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import core, store
from backend.config import handbook_path
from backend.deps import ALLOWED_EXTS

print("== 1. 日期解析（各种写法）==")
CASES = [
    ("13/Dec/2026 23:59", "2026-12-13T23:59"),
    ("13/Dec/2026", "2026-12-13"),
    ("08/Jan/2027 23:59", "2027-01-08T23:59"),
    ("2026-12-13", "2026-12-13"),
    ("2026/12/13", "2026-12-13"),
    ("13/12/2026", "2026-12-13"),
    ("Dec 13, 2026", "2026-12-13"),
    ("13 December 2026", "2026-12-13"),
    ("1st Nov 2026", "2026-11-01"),
    ("/", None),
    ("TBC", None),
    ("Week 13", None),
    ("99/99/9999", None),
]
bad = 0
for raw, want in CASES:
    got = core.parse_date_text(raw)
    if got != want:
        bad += 1
        print(f"  FAIL {raw!r} -> {got!r}（期望 {want!r}）")
print(f"  {len(CASES) - bad}/{len(CASES)} 通过"
      + (f"，{bad} 个失败" if bad else "，全部通过"))

print("\n== 2. 白名单（可用日期 vs 被排除）==")
for c in store.list_courses():
    p = ext = None
    for e in ALLOWED_EXTS:
        cand = handbook_path(c["id"], e)
        if os.path.exists(cand):
            p, ext = cand, e
            break
    if not p:
        continue
    text = ("\n".join(t for _, t in core.parse_pdf(p)) if ext == "pdf"
            else "\n".join(core.parse_docx(p)))
    all_d = core.collect_dates(text)
    keep = core.usable_dates(text)
    print(f"  {c['code']:8s} 可用 {sorted(keep)}")
    gone = sorted(all_d - keep)
    if gone:
        print(f"           排除 {gone}")

print("\n== 3. 防幻觉：编造的日期必须被拦下 ==")
text_hint = {
    "ADS102": ["2026-10-23", "2026-12-11"],
    "SOE104": ["2026-11-02", "2026-12-13", "2026-12-28", "2027-01-08"],
}
for code, expect in text_hint.items():
    c = next((x for x in store.list_courses() if x["code"] == code), None)
    if not c:
        continue
    for e in ALLOWED_EXTS:
        cand = handbook_path(c["id"], e)
        if os.path.exists(cand):
            p = cand
            break
    known = core.usable_dates("\n".join(t for _, t in core.parse_pdf(p)))
    print(f"  {code}: 应保留 {[d for d in expect if d in known]}"
          f"｜误留 {[d for d in expect if d not in known]}")
    for fake in ["2027-01-15", "2026-06-01"]:
        assert fake not in known, f"{code} 白名单竟然放行了 {fake}"
    print(f"          编造日期 2027-01-15 / 2026-06-01 → 均拦截 OK")
