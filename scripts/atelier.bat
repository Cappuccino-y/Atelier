@echo off
chcp 65001 >nul 2>nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0atelier.ps1" %*