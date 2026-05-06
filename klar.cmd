@echo off
REM Klar dev shell launcher.
REM Double-click this file (or run "klar" from cmd) to open a PowerShell
REM window with the Klar shell loaded.
REM
REM From an existing PowerShell session, you can also dot-source the module
REM directly without opening a new window:
REM     . .\shell.ps1
start "Klar" powershell.exe -NoExit -ExecutionPolicy Bypass -Command ". '%~dp0shell.ps1'"
