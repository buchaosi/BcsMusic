// Electron 主进程入口
const { app, BrowserWindow, shell, ipcMain, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { registerIpc } = require('./ipc');
const { loadSettings, saveSettings, DEFAULT_SETTINGS, loadPlayerState, savePlayerState } = require('./store');
const { SmtcBridge } = require('./smtc');

// 原生 SMTC 桥（Windows）：替代 Chromium 的 MediaSession→SMTC，封面无尺寸限制
const smtc = new SmtcBridge();

// 软件 logo 图标：用于窗口图标 + 托盘图标（运行时，随 main/ 打包进 asar）
// 用 fs.readFileSync + createFromBuffer，兼容 asar 内路径（createFromPath 对 asar 不稳定）
const fs = require('fs');
let APP_ICON = nativeImage.createEmpty();
try {
  APP_ICON = nativeImage.createFromBuffer(fs.readFileSync(path.join(__dirname, 'icon.png')));
} catch (err) {
  console.warn('[main] logo 图标加载失败，使用空图标:', err.message);
}

// 窗口控制 IPC（顶栏右上角的最小化/最大化/关闭）
function registerWindowIpc(getWin, getTray) {
  ipcMain.on('win:minimize', () => { const w = getWin(); if (w) w.minimize(); });
  ipcMain.on('win:maximize', () => {
    const w = getWin();
    if (!w) return;
    w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  // 切换全屏（用于播放页全屏按钮）
  ipcMain.on('win:toggleFullscreen', () => {
    const w = getWin();
    if (!w) return;
    w.setFullScreen(!w.isFullScreen());
  });
  // 同步查询当前是否全屏：渲染进程的「最大化按钮」在全屏态下需要走退出全屏分支
  ipcMain.on('win:isFullScreen', (e) => {
    const w = getWin();
    e.returnValue = !!(w && !w.isDestroyed() && w.isFullScreen());
  });
  // 关闭按钮：若启用「最小化到托盘」则隐藏窗口而不是退出
  ipcMain.on('win:close', () => {
    const w = getWin();
    if (!w) return;
    const settings = loadSettings();
    if (settings.minimizeToTray) {
      w.hide();
      if (getTray()) {
        getTray().displayBalloon ? null : null;
      }
    } else {
      w.close();
    }
  });
}

const DEV_PORT = process.env.BCS_DEV_PORT;
const IS_DEV = !!process.env.BCS_DEV || !!DEV_PORT;

let mainWindow = null;
let splashWindow = null;
let tray = null;

function createWindow() {
  const settings = loadSettings();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'BcsMusic',
    backgroundColor: '#ffffff',
    icon: APP_ICON,
    // 无系统标题栏：去掉外框、Windows 的最小化/最大化/关闭三按钮和"BcsMusic"标题
    // 我们用 HTML 顶栏里的自定义控件替代
    frame: false,
    autoHideMenuBar: true,
    // 启动时先隐藏，由 splash 淡出后再淡入，避免白屏闪烁
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 需引入 electron 模块
      // 允许播放受保护媒体（网易云部分歌曲走 mpeg，无 DRM）
      backgroundThrottling: false, // 防止后台节流影响 SMTC
      defaultFontFamily: { standard: 'DM Sans' },
    },
  });

  // 外链在系统默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  if (IS_DEV && DEV_PORT) {
    mainWindow.loadURL(DEV_PORT);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  // 渲染进程加载完成后：淡出 splash + 淡入主窗口
  mainWindow.webContents.once('did-finish-load', () => {
    // 主窗口从透明渐显
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setOpacity(0);
      mainWindow.show();
      // 逐帧提升 opacity 实现淡入（兼容性好于 CSS transition）
      let op = 0;
      const fadeIn = setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(fadeIn); return; }
        op += 0.1;
        if (op >= 1) { mainWindow.setOpacity(1); clearInterval(fadeIn); }
        else mainWindow.setOpacity(op);
      }, 24);
    }
    // splash 淡出后销毁
    if (splashWindow && !splashWindow.isDestroyed()) {
      try { splashWindow.webContents.executeJavaScript('document.getElementById("splash").classList.add("fade-out");'); } catch {}
      setTimeout(() => {
        if (splashWindow && !splashWindow.isDestroyed()) {
          splashWindow.close();
          splashWindow = null;
        }
      }, 420);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // ===== 全屏状态变化事件：通知渲染进程刷新「最大化/全屏」按钮图标 =====
  // 用户在播放页点全屏后，可以从右上角窗口控件或顶栏拖动退出（Windows 原生行为），
  // 此时主进程主动通知渲染进程，让按钮图标同步成「退出全屏」态。
  const notifyFs = (isFull) => {
    try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('win:fullscreen-change', isFull); } catch {}
  };
  mainWindow.on('enter-full-screen', () => notifyFs(true));
  mainWindow.on('leave-full-screen', () => notifyFs(false));
}

// ---------- 启动 Splash ----------
// 启动动画：大 logo 居中显示，主窗口加载完成后 logo 淡出 + 主窗口淡入
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 360,
    height: 360,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'));
  splashWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
  });
  splashWindow.on('closed', () => { splashWindow = null; });
}

// ---------- 托盘 ----------
// 托盘图标使用软件 logo（main/icon.png 随主进程打包）
function createTray() {
  tray = new Tray(APP_ICON.isEmpty() ? nativeImage.createEmpty() : APP_ICON);
  tray.setToolTip('BcsMusic');
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { label: '隐藏到托盘', click: () => { if (mainWindow) mainWindow.hide(); } },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  // 单击托盘图标：切换显示/隐藏
  tray.on('click', () => {
    if (!mainWindow) { createWindow(); return; }
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      showMainWindow();
    }
  });
}

function showMainWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function hideMainWindow() {
  if (mainWindow) mainWindow.hide();
}

// ---------- 全局快捷键 ----------
// 默认唤出/隐藏 Shift+Alt+A；可在设置页改
function registerHotkey(accelerator) {
  if (!accelerator) return;
  try {
    const ok = globalShortcut.register(accelerator, () => {
      if (!mainWindow) { createWindow(); return; }
      if (mainWindow.isVisible() && mainWindow.isFocused()) {
        hideMainWindow();
      } else {
        showMainWindow();
      }
    });
    if (!ok) console.warn('[main] 注册快捷键失败:', accelerator);
  } catch (err) {
    console.error('[main] 注册快捷键异常:', err);
  }
}

// 一次性注册所有全局快捷键：唤出/隐藏 + 播放控制
// 触发后通过 IPC 通知渲染进程，由 player 模块执行实际控制
function registerAllHotkeys(settings) {
  try { globalShortcut.unregisterAll(); } catch {}
  if (!settings) return;
  if (settings.hotkey) registerHotkey(settings.hotkey);
  // 播放暂停
  const mediaActions = [
    { key: 'hotkeyPlay', accel: 'Ctrl+Alt+P', action: 'play-pause' },
    { key: 'hotkeyPrev', accel: 'Ctrl+Alt+Left', action: 'prev' },
    { key: 'hotkeyNext', accel: 'Ctrl+Alt+Right', action: 'next' },
    { key: 'hotkeyVolUp', accel: 'Ctrl+Alt+Up', action: 'vol-up' },
    { key: 'hotkeyVolDown', accel: 'Ctrl+Alt+Down', action: 'vol-down' },
  ];
  for (const m of mediaActions) {
    const accel = settings[m.key] || m.accel;
    try {
      globalShortcut.register(accel, () => {
        if (mainWindow) mainWindow.webContents.send('media:action', m.action);
      });
    } catch (err) {
      console.warn(`[main] 注册 ${m.action} 快捷键失败:`, err);
    }
  }
}

// ---------- 设置 IPC ----------
function registerSettingsIpc(getWin) {
  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:save', (_e, partial) => {
    const merged = saveSettings(partial || {});
    // 快捷键变了要重新注册
    if (partial) {
      if (partial.hotkey !== undefined
        || partial.hotkeyPlay !== undefined
        || partial.hotkeyPrev !== undefined
        || partial.hotkeyNext !== undefined
        || partial.hotkeyVolUp !== undefined
        || partial.hotkeyVolDown !== undefined
      ) {
        registerAllHotkeys(merged);
      }
      // 开机自启动切换
      if (partial.launchAtLogin !== undefined) {
        try {
          app.setLoginItemSettings({ openAtLogin: !!partial.launchAtLogin });
        } catch (err) {
          console.warn('[main] 设置开机自启动失败:', err);
        }
      }
    }
    return merged;
  });
  // Electron 窗口全屏（MV 播放器用）
  ipcMain.handle('window:enterFullscreen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFullScreen(true);
    return true;
  });
  ipcMain.handle('window:exitFullscreen', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFullScreen(false);
    return true;
  });
  ipcMain.handle('window:isFullscreen', () => {
    return !!(mainWindow && mainWindow.isFullScreen());
  });

  // 选择本地图片：弹出系统文件对话框，读到 dataURL 返回
  ipcMain.handle('settings:pickImage', async () => {
    const { dialog, nativeImage } = require('electron');
    const win = getWin ? getWin() : null;
    const res = await dialog.showOpenDialog(win, {
      title: '选择背景图',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const filePath = res.filePaths[0];
    try {
      // 用 nativeImage 读为 PNG dataURL（统一编码、避免路径中文/权限问题）
      const img = nativeImage.createFromPath(filePath);
      if (img.isEmpty()) return { error: '无法读取图片' };
      const dataUrl = img.toDataURL();
      return { dataUrl };
    } catch (err) {
      return { error: err.message };
    }
  });
  // 字体选择：弹出系统文件对话框，读取 ttf/otf/ttc/woff
  ipcMain.handle('settings:pickFont', async () => {
    const { dialog } = require('electron');
    const win = getWin ? getWin() : null;
    const res = await dialog.showOpenDialog(win, {
      title: '选择 UI 字体',
      filters: [
        { name: '字体文件', extensions: ['ttf', 'otf', 'ttc', 'woff', 'woff2'] },
      ],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const filePath = res.filePaths[0];
    try {
      const fs = require('fs');
      const buffer = fs.readFileSync(filePath);
      // 转成 base64 dataURL，渲染进程用 @font-face 注入
      const ext = filePath.split('.').pop().toLowerCase();
      const mimeMap = { ttf: 'font/ttf', otf: 'font/otf', ttc: 'font/ttc', woff: 'font/woff', woff2: 'font/woff2' };
      const mime = mimeMap[ext] || 'font/ttf';
      const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
      return { dataUrl, name: filePath.split(/[\\/]/).pop() };
    } catch (err) {
      return { error: err.message };
    }
  });
}

// ---------- 播放器状态 IPC ----------
// 渲染进程把当前播放队列/曲目/模式/位置发来持久化，下次启动时恢复
function registerPlayerStateIpc() {
  ipcMain.handle('player:loadState', () => loadPlayerState());
  ipcMain.handle('player:saveState', (_e, state) => { savePlayerState(state || {}); return true; });
}

// ---------- 原生 SMTC IPC ----------
// 渲染进程的 player.js 通过这些通道把 metadata/playback/position 推给 SMTC 子进程；
// SMTC 按钮回调则反向通过 media:action 通道通知渲染进程（与全局快捷键复用同一通道）
function registerSmtcIpc(getWin) {
  ipcMain.handle('smtc:setMetadata', async (_e, payload) => {
    if (!payload) return;
    await smtc.setMetadata(payload || {});
    return true;
  });
  ipcMain.handle('smtc:setPlayback', async (_e, state) => {
    smtc.setPlaybackState(state);
    return true;
  });
  ipcMain.handle('smtc:setPosition', async (_e, durationMs, positionMs) => {
    smtc.setPositionState(durationMs, positionMs);
    return true;
  });
  // SMTC 按钮回调 → 渲染进程（与全局快捷键共用 media:action 通道）
  smtc.onAction = (action) => {
    const w = getWin && getWin();
    if (w && !w.isDestroyed()) {
      try { w.webContents.send('media:action', action); } catch {}
    }
  };
}

// 关键：禁用 Chromium 内置的 MediaSession 服务
//   原因：<audio>/<video> 播放时 Chromium 会自动注册一个 SMTC 实例（"未知应用"，
//   只有应用名、无歌曲信息），和我们 Rust 子进程注册的 SMTC 重复。
//   禁用后只保留 Rust 子进程的 SMTC（有完整 metadata + 封面 + 按钮控制）。
//   必须在 app.whenReady 之前调用。
app.commandLine.appendSwitch('disable-features', 'HardwareMediaSessionService,MediaSessionService');

app.whenReady().then(() => {
  // 设置 AppUserModelID：与 Rust SMTC 子进程的 AUMID 一致，
  // 让 SMTC 从开始菜单快捷方式查到「BcsMusic」应用名，而不是显示「未知应用」
  try { app.setAppUserModelId('com.bcsmusic.app'); } catch {}

  registerIpc();
  registerSettingsIpc(() => mainWindow);
  registerWindowIpc(() => mainWindow, () => tray);
  registerPlayerStateIpc();
  registerSmtcIpc(() => mainWindow);
  // 启动原生 SMTC 子进程（找不到 exe 会安静失败，渲染进程的 SMTC 调用变成 no-op）
  smtc.start();
  // 允许渲染进程请求麦克风权限（听歌识曲需要 getUserMedia）
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => {
    if (perm === 'media') return cb(true);
    cb(false);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => {
    return perm === 'media';
  });
  // 先显示启动 splash（大 logo 居中），主窗口加载完成后淡出
  createSplash();
  createWindow();
  createTray();
  const settings = loadSettings();
  registerAllHotkeys(settings);
});

app.on('window-all-closed', (e) => {
  // 启用「最小化到托盘」时，关闭窗口不退出应用（留在托盘）
  const settings = loadSettings();
  if (settings.minimizeToTray) {
    e.preventDefault();
  } else {
    app.quit();
  }
});

app.on('before-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
  // 退出前让 SMTC 子进程优雅关闭，避免 SMTC 卡在「播放中」状态
  try { smtc.stop(); } catch {}
});

// 捕获未处理的 Promise 拒绝，便于调试
process.on('unhandledRejection', (reason) => {
  console.error('[main] 未处理 Promise 拒绝:', reason);
});
