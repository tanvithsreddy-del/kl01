@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo KL01 requires Node.js 20 or 22.
  echo Install Node.js, then run KL01.bat again.
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node"') do set NODE_MAJOR=%%V
if not "%NODE_MAJOR%"=="20" if not "%NODE_MAJOR%"=="22" (
  echo KL01 requires Node.js 20 or 22. Found:
  node --version
  pause
  exit /b 1
)
if "%KL01_DATA_DIR%"=="" (
  if "%LOCALAPPDATA%"=="" (
    set "KL01_DATA_DIR=%USERPROFILE%\AppData\Local\KL01"
  ) else (
    set "KL01_DATA_DIR=%LOCALAPPDATA%\KL01"
  )
)
if not exist "%KL01_DATA_DIR%" mkdir "%KL01_DATA_DIR%"
node start.js
if errorlevel 1 (
  echo.
  echo KL01 stopped before it could open.
  echo Read the message above, then run KL01.bat again.
  pause
)
endlocal
