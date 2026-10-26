# Changes from upstream

Baseline: upstream `main` as copied on 2026-10-26 (see ATTRIBUTION.md).

## 2026-10-26
- Repository created as a copy of upstream, with attribution kept in README/ATTRIBUTION.md/LICENSE.
- No functional changes yet.

## 2026-10-26 (local launcher)
- Added `run.sh` (idempotent start: health probe → launch → wait for `/api/health`) and `launch.bat`
  for a Windows desktop shortcut, plus `assets/icon.ico` (7 sizes, 16–256 px).
- Paths in `run.sh` / `launch.bat` are absolute (`/mnt/a/...`, `A:\...`) — adjust if the repo moves.

## 2026-10-26 (bulk import of 7 courses, 89 files)
Two upstream bugs surfaced while importing 89 files at once; both are fixed here.

1. **`database is locked` on parallel ingestion.** Every upload spawned its own
   thread, all writing SQLite with the default 5 s wait. Fix: `busy_timeout=30000`
   plus `timeout=30` on connect (`backend/store.py`), and ingestion now runs through
   a single worker queue instead of one thread per file (`backend/core.py`).
2. **`No module named 'docx'`.** `requirements.txt` never listed `python-docx`, so every
   Word upload failed on a clean install. Added to requirements.

Also added:
- `import_courses.py` — bulk import of `/mnt/a/Robin/XJTLU/<CODE>_<NAME>` folders
  (PDF/DOCX, skips drafts and lock files, de-duplicates by filename).
- `repair_import.py` — re-queues records stuck in `failed` after a partial import.
