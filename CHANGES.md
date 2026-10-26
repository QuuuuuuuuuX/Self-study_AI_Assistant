# Changes from upstream

Baseline: upstream `main` as copied on 2026-10-26 (see ATTRIBUTION.md).

## 2026-10-26
- Repository created as a copy of upstream, with attribution kept in README/ATTRIBUTION.md/LICENSE.
- No functional changes yet.

## 2026-10-26 (local launcher)
- Added `run.sh` (idempotent start: health probe → launch → wait for `/api/health`) and `launch.bat`
  for a Windows desktop shortcut, plus `assets/icon.ico` (7 sizes, 16–256 px).
- Paths in `run.sh` / `launch.bat` are absolute (`/mnt/a/...`, `A:\...`) — adjust if the repo moves.
