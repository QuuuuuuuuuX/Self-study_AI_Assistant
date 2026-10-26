@echo off
rem Quick launcher for the local Self-Study Space (study assistant).
rem Starts the WSL server if needed, then opens the browser.
title Self-Study Space
wsl.exe -d Ubuntu -e bash -lc "cd /mnt/a/Robin/self-study-assistant && bash run.sh"
start "" "http://127.0.0.1:8765/"
exit
