// Cookie / 会话持久化 + 应用设置持久化：JSON 落地到 userData
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const SESSION_FILE = 'netease-session.json';
const SETTINGS_FILE = 'bcsmusic-settings.json';
const PLAYER_STATE_FILE = 'bcsmusic-player.json';

function sessionPath() {
  return path.join(app.getPath('userData'), SESSION_FILE);
}
function settingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}
function playerStatePath() {
  return path.join(app.getPath('userData'), PLAYER_STATE_FILE);
}

// ---------- 网易云会话 ----------
function loadSession() {
  try {
    const raw = fs.readFileSync(sessionPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { cookie: '', userId: null, nickname: null, avatarUrl: null };
  }
}

function saveSession(session) {
  try {
    fs.writeFileSync(sessionPath(), JSON.stringify(session, null, 2), 'utf8');
  } catch (err) {
    console.error('[store] 保存会话失败:', err);
  }
}

function clearSession() {
  try {
    fs.unlinkSync(sessionPath());
  } catch {
    // 不存在即视为已清空
  }
}

// ---------- 应用设置 ----------
const DEFAULT_SETTINGS = {
  // 全局快捷键（Electron accelerator 格式）：唤出/隐藏窗口
  hotkey: 'Shift+Alt+A',
  // 播放控制快捷键
  hotkeyPlay: 'Ctrl+Alt+P',
  hotkeyPrev: 'Ctrl+Alt+Left',
  hotkeyNext: 'Ctrl+Alt+Right',
  hotkeyVolUp: 'Ctrl+Alt+Up',
  hotkeyVolDown: 'Ctrl+Alt+Down',
  // 是否启用「最小化到托盘」（关闭窗口不退出，留在托盘）
  minimizeToTray: true,
  // 启动时是否显示主窗口
  showOnLaunch: true,
  // 开机自启动
  launchAtLogin: false,
  // 自定义背景图：空字符串=默认渐变；dataURL=本地上传的图；http(s)://=网络图
  backgroundImage: '',
  // 背景图透明度 0-1（精度 0.01）
  backgroundOpacity: 0.4,
  // 背景图模糊度 0-20（px）
  backgroundBlur: 0,
  // 背景图填充模式：cover | contain | center
  backgroundFit: 'cover',
  // 自定义 UI 字体（dataURL）；为空则使用默认字体
  customFont: '',
  customFontName: '',
  // 动画速度倍率（数字填写）：1.0 = 默认，0.5 = 2 倍速，2 = 半速
  animationSpeed: 1.0,
  // 逐字动画速度倍率（数字填写）：0.6 = 默认，0.3 = 更快，2 = 更慢
  textAnimSpeed: 0.6,
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    // 合并默认值，避免新版本新增字段时为 undefined
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    const merged = { ...loadSettings(), ...settings };
    fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch (err) {
    console.error('[store] 保存设置失败:', err);
    return null;
  }
}

// ---------- 播放器状态（队列 + 当前曲目 + 模式 + 位置）----------
// 仅保存最小必要字段（不含 url：网易云 URL 会过期，恢复时由 ensureUrl 重新拉取）
function loadPlayerState() {
  try {
    const raw = fs.readFileSync(playerStatePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.queue)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function savePlayerState(state) {
  try {
    fs.writeFileSync(playerStatePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('[store] 保存播放状态失败:', err);
  }
}

module.exports = {
  loadSession, saveSession, clearSession,
  loadSettings, saveSettings, DEFAULT_SETTINGS,
  loadPlayerState, savePlayerState,
};
