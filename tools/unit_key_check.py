"""知识点单元的两条路径必须产出一致的 key（覆盖率正确性的地基）。

- unit_keys_for()      只读字数，用于覆盖率统计（快）
- build_knowledge_units() 读正文，用于出题（慢）

两者只要有一个 key 对不上，界面就会出现「明明练过却说自己没覆盖」。
"""
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import core, store

print("== 1. 单元 key 一致性（逐课程核对）==")
total_units = 0
for c in store.list_courses():
    mats = [m["id"] for m in store.list_materials(c["id"]) if m["status"] == "ready"]
    if not mats:
        continue
    fast = core.unit_keys_for(mats)
    units = core.build_knowledge_units(mats)
    full = [u["unit_key"] for u in units]
    same = fast == full
    total_units += len(full)
    mark = "OK " if same else "BAD"
    print(f"  {mark} {c['code']:8s} 轻量 {len(fast):>4} / 完整 {len(full):>4}  "
          f"{'一致' if same else '不一致 ✗'}")
    if not same:
        only_fast = set(fast) - set(full)
        only_full = set(full) - set(fast)
        print(f"       仅轻量路径有 {len(only_fast)} 个: {list(only_fast)[:3]}")
        print(f"       仅完整路径有 {len(only_full)} 个: {list(only_full)[:3]}")
print(f"  全库知识点单元合计: {total_units}")

print("\n== 2. 单元粒度分布（抽一门课看）==")
c = next((x for x in store.list_courses() if x["code"] == "SOE101"), None)
mats = [m["id"] for m in store.list_materials(c["id"]) if m["status"] == "ready"]
units = core.build_knowledge_units(mats)
lens = [len(u["text"]) for u in units]
print(f"  {c['code']}: {len(units)} 个单元 / {len(mats)} 份资料")
if lens:
    print(f"  单元字数: 最小 {min(lens)} / 中位 {sorted(lens)[len(lens)//2]} / 最大 {max(lens)}")
big = [u for u in units if "#" in u["unit_key"].split("#p")[1]]
print(f"  拆分的单元（超长页）: {len(big)} 个")
print(f"  key 样例: {[u['unit_key'] for u in units[:4]]}")

print("\n== 3. 分批打包（全面覆盖的调用次数预估）==")
todo = units
batches = core._pack_units(todo, core.BATCH_MAX_UNITS, core.BATCH_CHAR_BUDGET)
sizes = [sum(len(u["text"]) for u in b) for b in batches]
print(f"  {len(units)} 个单元 -> {len(batches)} 批（每批 ≤{core.BATCH_MAX_UNITS} 个 / ≤{core.BATCH_CHAR_BUDGET} 字）")
print(f"  每批字数: 最小 {min(sizes)} / 中位 {sorted(sizes)[len(sizes)//2]} / 最大 {max(sizes)}")
print(f"  即：全面覆盖这门课需要 {len(batches)} 次模型调用")

print("\n== 4. key 稳定性（重复调用必须完全相同）==")
k1, k2 = core.unit_keys_for(mats), core.unit_keys_for(mats)
print(f"  两次 unit_keys_for 完全相同: {k1 == k2}")

print("\n== 5. 覆盖率报告（各课程的规模真相）==")
print(f"  {'课程':<9}{'知识点':>7}{'已覆盖':>7}{'待覆盖':>7}{'完成度':>8}{'批次':>6}")
for c2 in store.list_courses():
    if c2["code"] == "UNFILED":
        continue
    m2 = [m["id"] for m in store.list_materials(c2["id"]) if m["status"] == "ready"]
    if not m2:
        continue
    r = core.coverage_report(c2["id"], m2)
    print(f"  {c2['code']:<9}{r['total']:>7}{r['covered']:>7}{r['pending']:>7}"
          f"{r['percent']:>7}%{r['batches']:>6}")
