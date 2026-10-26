#!/usr/bin/env bash
# Start the local study assistant if it is not already running.
# Called by launch.bat (desktop shortcut). Safe to run repeatedly.
set -u

APP_DIR="/mnt/a/Robin/self-study-assistant"
PORT=8765
URL="http://127.0.0.1:${PORT}/api/health"
LOG="/tmp/study-assistant.log"

cd "$APP_DIR" || exit 1

if curl -s -m 2 -o /dev/null "$URL"; then
  echo "already running"
  exit 0
fi

# Refuse to start twice if a stale pid file says otherwise
if [ -f /tmp/study-assistant.pid ]; then
  if kill -0 "$(cat /tmp/study-assistant.pid)" 2>/dev/null; then
    echo "pid file alive, waiting"
  fi
fi

setsid nohup .venv/bin/python -m uvicorn backend.app:app \
  --host 127.0.0.1 --port "$PORT" --log-level warning > "$LOG" 2>&1 &
echo $! > /tmp/study-assistant.pid

# Cold start needs ~12 s (imports + model); allow 60 s.
for i in $(seq 1 60); do
  if curl -s -m 2 -o /dev/null "$URL"; then
    echo "started in ${i}s"
    exit 0
  fi
  sleep 1
done

echo "failed to start; see $LOG"
exit 1
