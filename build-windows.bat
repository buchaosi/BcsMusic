@echo off
REM BcsMusic 一键打包为 Windows 安装程序
REM 产出 dist/BcsMusic-0.1.0-x64.exe（NSIS 安装包）
REM 用法：双击或 cmd 运行 build-windows.bat

set ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
set NODE_TLS_REJECT_UNAUTHORIZED=0

echo === 0. 检查 Rust toolchain（用于编译原生 SMTC 子进程） ===
where cargo >nul 2>&1
if errorlevel 1 (
  echo.
  echo [错误] 未找到 cargo。请先安装 Rust 工具链：
  echo   1. 访问 https://rustup.rs/ 下载 rustup-init.exe
  echo   2. 选择 stable-x86_64-pc-windows-msvc 默认安装
  echo   3. 同时需要 Visual Studio Build Tools（含 MSVC + Windows SDK）
  echo.
  pause
  exit /b 1
)

echo.
echo === 1. 安装依赖（含 electron-builder） ===
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo 依赖安装失败
  pause
  exit /b 1
)

echo.
echo === 2. 编译 Rust 原生 SMTC 子进程 + 打包 Windows NSIS 安装程序 ===
call npm run build
if errorlevel 1 (
  echo 打包失败
  pause
  exit /b 1
)

echo.
echo === 完成！安装包在 dist\ 目录 ===
dir /b dist\*.exe 2>nul
echo.
pause
