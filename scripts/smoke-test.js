// 烟雾测试：mock electron 模块后加载 main/* 模块，验证不报错
// 注意：不会真正连网，只验证模块结构和导出
const Module = require('module');
const path = require('path');
const fs = require('fs');

// Mock electron 模块
const electronMock = {
  app: {
    getPath: (name) => `/tmp/bcsmusic-mock-${name}`,
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
    getAppPath: () => '/mock/app',
  },
  BrowserWindow: function () { return { on: () => {}, loadFile: () => {}, loadURL: () => {}, webContents: { setWindowOpenHandler: () => {}, openDevTools: () => {} } }; },
  shell: { openExternal: () => {} },
  ipcMain: { on: () => {}, handle: () => {} },
  globalShortcut: { register: () => true, unregisterAll: () => {} },
  Tray: function () { return { setToolTip: () => {}, setContextMenu: () => {}, on: () => {} }; },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromBuffer: () => ({}), createFromPath: () => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,' }), createEmpty: () => ({ isEmpty: () => true }) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  session: { defaultSession: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} } },
};

// 注入 require cache，让任何 `require('electron')` 返回我们的 mock
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'electron') return 'electron-mock';
  return origResolve.call(this, request, parent, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return electronMock;
  return origLoad.call(this, request, parent, ...rest);
};

// 准备 mock 的 userData 目录
fs.mkdirSync('/tmp/bcsmusic-mock-userData', { recursive: true });

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}: ${err.message}`);
    failures++;
  }
}

// 加载 store
const store = require(path.join(__dirname, '..', 'main', 'store.js'));
check('store.loadSession 返回默认对象', () => {
  const s = store.loadSession();
  if (!s || typeof s !== 'object') throw new Error('loadSession 返回非对象');
});

check('store.saveSession 写入并读回', () => {
  store.saveSession({ cookie: 'test=1', userId: 12345, nickname: 'test', avatarUrl: '' });
  const s = store.loadSession();
  if (s.cookie !== 'test=1' || s.userId !== 12345) throw new Error('会话未正确读回: ' + JSON.stringify(s));
});

check('store.clearSession 清空', () => {
  store.clearSession();
  const s = store.loadSession();
  if (s.cookie) throw new Error('清空后仍有 cookie');
});

// 加载 netease（不发起任何真实调用，只验证导出）
const netease = require(path.join(__dirname, '..', 'main', 'netease.js'));
check('netease 导出登录函数', () => {
  for (const fn of ['qrKey', 'qrCreate', 'qrCheck', 'loginStatus', 'logout']) {
    if (typeof netease[fn] !== 'function') throw new Error(`缺少 ${fn}`);
  }
});
check('netease 导出用户函数', () => {
  for (const fn of ['userPlaylist', 'userRecord', 'recommendSongs', 'recommendResource', 'playlistDetail', 'songUrl', 'songUrlBatch']) {
    if (typeof netease[fn] !== 'function') throw new Error(`缺少 ${fn}`);
  }
});

// 加载 ipc（注册不报错）
check('ipc.registerIpc 注册成功', () => {
  const ipc = require(path.join(__dirname, '..', 'main', 'ipc.js'));
  ipc.registerIpc();
});

// 设置 store
const settingsStore = require(path.join(__dirname, '..', 'main', 'store.js'));
check('store.loadSettings 返回默认值', () => {
  const s = settingsStore.loadSettings();
  if (s.hotkey !== 'Shift+Alt+A') throw new Error('默认快捷键不是 Shift+Alt+A: ' + s.hotkey);
  if (s.minimizeToTray !== true) throw new Error('默认 minimizeToTray 不是 true');
  if (s.backgroundImage !== '') throw new Error('默认 backgroundImage 不为空');
  if (s.backgroundOpacity !== 0.4) throw new Error('默认 backgroundOpacity 不是 0.4');
});

check('store.saveSettings 合并保存（含背景图字段）', () => {
  const merged = settingsStore.saveSettings({ hotkey: 'Ctrl+Shift+M', backgroundImage: 'http://x/y.jpg' });
  if (merged.hotkey !== 'Ctrl+Shift+M') throw new Error('hotkey 未更新');
  if (merged.backgroundImage !== 'http://x/y.jpg') throw new Error('backgroundImage 未更新');
  const reread = settingsStore.loadSettings();
  if (reread.backgroundImage !== 'http://x/y.jpg') throw new Error('保存后读回不一致');
  // 重置为默认
  settingsStore.saveSettings({ hotkey: 'Shift+Alt+A', backgroundImage: '' });
});

// 加载主进程模块（不执行入口，但能 require 成功）
check('main/index.js 能被 require', () => {
  // 注意：main/index.js 顶层会 app.whenReady().then(...)，但 mock 的 whenReady 返回 resolved promise，
  // 回调里会立即执行 createWindow/createTray/registerHotkey，全部使用 mock 应该不报错
  require(path.join(__dirname, '..', 'main', 'index.js'));
});

// netease 模块导出新增的 songUrlSmart/mvUrl/lyric
check('netease 模块导出 songUrlSmart/mvUrl/lyric', () => {
  const netease = require(path.join(__dirname, '..', 'main', 'netease.js'));
  for (const fn of ['songUrlSmart', 'mvUrl', 'lyric', 'cloudsearch', 'searchHotDetail', 'searchSuggest']) {
    if (typeof netease[fn] !== 'function') throw new Error('缺少导出: ' + fn);
  }
});

// NeteaseCloudMusicApi 实际暴露 mv_url / lyric / cloudsearch / search_hot_detail / search_suggest
check('NeteaseCloudMusicApi 暴露 mv_url/lyric/cloudsearch/search_hot_detail/search_suggest', () => {
  const api = require('NeteaseCloudMusicApi');
  for (const fn of ['mv_url', 'lyric', 'cloudsearch', 'search_hot_detail', 'search_suggest', 'song_url_v1', 'recommend_songs', 'recommend_resource']) {
    if (typeof api[fn] !== 'function') throw new Error('缺少 API: ' + fn);
  }
});

console.log('---');
console.log(failures === 0 ? '所有烟雾测试通过 ✓' : `${failures} 个测试失败`);
process.exit(failures === 0 ? 0 : 1);
