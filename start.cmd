@echo off
rem Serve Taste Duel on http://127.0.0.1:4611 and open it in the browser.
cd /d "%~dp0"
start "" http://127.0.0.1:4611/
python -m http.server 4611 --bind 127.0.0.1
