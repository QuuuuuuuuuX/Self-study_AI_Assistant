"""共享依赖与常量。

各路由模块从这里导入，避免相互依赖 / 循环导入。
资料标签在这里定义（唯一权威来源），前端启动时通过 GET /api/meta 拉取，
不再在 HTML / JS 里各自硬编码一份。
"""
import re

from fastapi import HTTPException

from . import store

TAGS = ["讲义", "习题", "往年卷", "文献", "课程具体要求", "其他"]

UNFILED_CODE = "UNFILED"
# 课程代码：2-4 个大写字母 + 3-4 位数字，允许中间有 -/_/空格，允许尾字母（如 CPT203A）
# 后面不能再跟数字（避免 5 位数字误判）；紧跟小写字母的情况在取用时再裁掉（如 CPT203Lecture）
COURSE_CODE_RE = re.compile(r"\b([A-Z]{2,4})[-_ ]?(\d{3,4})([A-Z])?(?![0-9])")
GROUPS = {"major": "专业课", "easy": "水课", "elective": "额外选修课"}
ALLOWED_EXTS = {"pdf", "docx"}


def course_or_404(cid: str):
    course = store.get_course(cid)
    if not course:
        raise HTTPException(404, "课程不存在")
    return course
