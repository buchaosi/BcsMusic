@echo off
REM BcsMusic Windows 安装脚本：解决 Electron 下载证书问题
REM 用法：在项目根目录（含 package.json 的那层）双击或 cmd 运行 install-windows.bat

REM 设置环境变量（仅对本次 cmd 会话有效，不会污染你的系统）
set ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
REM 关掉 Node 的 TLS 严格校验——企业代理做 TLS 拦截时必需
set NODE_TLS_REJECT_UNAUTHORIZED=0
REM 让 got 库（Electron 安装脚本内部用的）也跳过证书校验
set NODE_TLS_REJECT_UNAUTHORIZED=0
set STRICT_SSL=false

echo === BcsMusic 安装中（已配置 Electron 镜像 + 跳过证书校验）===
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo 安装失败。可以手动重试：
  echo   set ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
  echo   set NODE_TLS_REJECT_UNAUTHORIZED=0
  echo   npm install
  pause
  exit /b 1
)

echo.
echo === 安装完成，运行 npm start 启动应用 ===
pause
