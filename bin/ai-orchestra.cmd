@echo off
setlocal
rem ai-orchestra — Windows launcher. Runs the same engine with the caller's arguments.
rem Uses the node on PATH; the installer writes an absolute node path when it
rem installs a bundled runtime. No shell quoting is involved: %* is forwarded.
"node.exe" "%~dp0ai-orchestra" %*
exit /b %ERRORLEVEL%
