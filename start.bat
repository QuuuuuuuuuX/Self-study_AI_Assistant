@echo off
REM Run in browser mode on Windows.
REM NOTE: keep this file ASCII-only -- .bat is read with the system codepage (GBK/CP936
REM on Chinese Windows), so non-ASCII comments would show up as mojibake.
cd /d "%~dp0"

set "PY=python"
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"

chcp 65001 >nul 2>&1
"%PY%" -m uvicorn backend.app:app --host 127.0.0.1 --port 8765

REM Keep the window open so startup errors stay visible.
pause
