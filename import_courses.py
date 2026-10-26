"""Bulk-import the XJTLU course folders into the local study assistant.

Usage:  .venv/bin/python import_courses.py [--dry-run]

Rules:
  - one app course per folder under /mnt/a/Robin/XJTLU/<CODE>_<NAME>
  - uploads PDF and DOCX only
  - skips: word lock files (~$*), personal drafts (草稿/修订稿/骨架/副本),
            and folders that are not current courses (00_课表, 大一_*, SURF_*)
  - ADS106TC is already imported; uploaded files are de-duplicated by name
"""
import os
import re
import sys
import time
import json
import httpx

ROOT = "/mnt/a/Robin/XJTLU"
API = "http://127.0.0.1:8765"
SKIP_DIRS = {"00_课表_2026秋季", "大一_2025-2026", "SURF_2026科研项目"}
SKIP_PAT = re.compile(r"草稿|修订稿|骨架|副本|~\$")
EXTS = (".pdf", ".docx")

COURSE_NAMES = {
    "ADS106TC": "Mathematics for AI and Data Science",
    "CCT009": "Comparing Chinese and Western Cultures",
    "ENT111TC": "AI Ideation and Strategy",
    "INF101TC": "Syntegrative Education in Deep Practice",
    "ISA101TC": "Technology Fundamentals and Perspectives",
    "SOE108": "Python for AI",
    "SOE109TC": "Object-Oriented Programming",
}


def discover():
    out = []
    for name in sorted(os.listdir(ROOT)):
        path = os.path.join(ROOT, name)
        if not os.path.isdir(path) or name in SKIP_DIRS:
            continue
        m = re.match(r"^([A-Z]{3}\d{3}[A-Z]*)_(.*)$", name)
        if not m:
            continue
        files = []
        for dirpath, _dirnames, filenames in os.walk(path):
            if ".trash" in dirpath:
                continue
            for fn in filenames:
                if not fn.lower().endswith(EXTS):
                    continue
                if SKIP_PAT.search(fn):
                    continue
                files.append(os.path.join(dirpath, fn))
        out.append((m.group(1), m.group(2), path, sorted(files)))
    return out


def main():
    dry = "--dry-run" in sys.argv
    courses = discover()
    c = httpx.Client(base_url=API, timeout=120)
    existing = {x["code"]: x for x in c.get("/api/courses").json()}

    for code, cname, path, files in courses:
        label = COURSE_NAMES.get(code, cname)
        if code in existing:
            cid = existing[code]["id"]
            have = {m["orig_name"] for m in c.get(f"/api/courses/{cid}/materials").json()}
            print(f"[skip course] {code} exists ({cid}), {len(have)} materials", flush=True)
        else:
            if dry:
                print(f"[would create] {code} {label} ({len(files)} files)", flush=True)
                continue
            r = c.post("/api/courses", data={"code": code, "name": label})
            r.raise_for_status()
            cid = r.json()["id"]
            have = set()
            print(f"[create] {code} {label} -> {cid}", flush=True)

        todo = [f for f in files if os.path.basename(f) not in have]
        if dry:
            print(f"   would upload {len(todo)} files", flush=True)
            continue
        for f in todo:
            try:
                with open(f, "rb") as fh:
                    r = c.post(f"/api/courses/{cid}/materials",
                               files={"file": (os.path.basename(f), fh,
                                               "application/pdf" if f.lower().endswith(".pdf")
                                               else "application/vnd.openxmlformats-officedocument.wordprocessingml.document")})
                r.raise_for_status()
                print(f"   + {os.path.basename(f)}", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"   ! {os.path.basename(f)}: {type(e).__name__} {e}", flush=True)
    print("DONE-UPLOAD", flush=True)


if __name__ == "__main__":
    main()
