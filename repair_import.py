"""Re-import materials that failed during the bulk import (SQLite lock).

Purges each failed record, then re-uploads its file once the queue is serialised.

Usage:  .venv/bin/python repair_import.py
"""
import os
import time
import httpx

ROOT = "/mnt/a/Robin/XJTLU"
API = "http://127.0.0.1:8765"
CODE_DIRS = {}


def index_files():
    """basename -> full path, so a failed record can find its source file again."""
    idx = {}
    for dirpath, _dirs, files in os.walk(ROOT):
        if ".trash" in dirpath:
            continue
        for fn in files:
            if fn.lower().endswith((".pdf", ".docx")):
                idx.setdefault(fn, os.path.join(dirpath, fn))
    return idx


def main():
    c = httpx.Client(base_url=API, timeout=300)
    idx = index_files()
    failed = []
    for co in c.get("/api/courses").json():
        for m in c.get(f"/api/courses/{co['id']}/materials").json():
            if m.get("status") == "failed":
                failed.append((co, m))
    print(f"failed records: {len(failed)}", flush=True)

    requeued = 0
    for co, m in failed:
        name = m["orig_name"]
        path = idx.get(name)
        if not path:
            print(f"  ? no source file for {name}", flush=True)
            continue
        c.post(f"/api/materials/{m['id']}/purge")
        with open(path, "rb") as fh:
            r = c.post(f"/api/courses/{co['id']}/materials",
                       files={"file": (name, fh, "application/pdf")})
        if r.status_code == 200:
            requeued += 1
            print(f"  + {co['code']:9} {name[:60]}", flush=True)
        else:
            print(f"  ! {name}: HTTP {r.status_code}", flush=True)
        time.sleep(1.0)

    print(f"requeued {requeued}", flush=True)

    # wait for the serialised worker to drain
    for _ in range(240):
        stats = {}
        for co in c.get("/api/courses").json():
            for m in c.get(f"/api/courses/{co['id']}/materials").json():
                stats[m.get("status")] = stats.get(m.get("status"), 0) + 1
        print("status:", stats, flush=True)
        if stats.get("processing", 0) == 0:
            break
        time.sleep(10)
    print("DONE-REPAIR", flush=True)


if __name__ == "__main__":
    main()
