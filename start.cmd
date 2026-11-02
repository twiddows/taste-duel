@echo off
rem Serve Taste Duel on http://127.0.0.1:4611 and open it in the browser.
rem With Node, tools\serve.mjs also gives the results page its save button; without it, Python serves the files.
cd /d "%~dp0"
start "" http://127.0.0.1:4611/
where node >nul 2>nul
if %errorlevel%==0 (node tools\serve.mjs) else (python -m http.server 4611 --bind 127.0.0.1)
