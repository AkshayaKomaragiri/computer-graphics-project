@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel% equ 0 (
  py -3 start.py
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Mars Atlas needs Python 3. Install it from https://www.python.org/downloads/
    pause
    exit /b 1
  )
  python start.py
)
if errorlevel 1 pause
