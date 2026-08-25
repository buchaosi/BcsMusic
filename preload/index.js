// Preload：通过 contextBridge 把受控 API 暴露到渲染进程 window.api
// 渲染进程拿不到 Node 能力，只能调这里显式暴露的接口
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  netease: {
    // 会话
    getSession: () => ipcRenderer.invoke('netease:session:get'),
    clearSession: () => ipcRenderer.invoke('netease:session:clear'),
    // 扫码登录
    qrKey: () => ipcRenderer.invoke('netease:qr:key'),
    qrCreate: (key) => ipcRenderer.invoke('netease:qr:create', key),
    qrCheck: (key) => ipcRenderer.invoke('netease:qr:check', key),
    loginStatus: () => ipcRenderer.invoke('netease:loginStatus'),
    logout: () => ipcRenderer.invoke('netease:logout'),
    // 用户内容
    userPlaylist: (uid) => ipcRenderer.invoke('netease:user:playlist', uid),
    userRecord: (uid, type = 1) => ipcRenderer.invoke('netease:user:record', uid, type),
    // 推荐
    recommendSongs: () => ipcRenderer.invoke('netease:recommend:songs'),
    recommendResource: () => ipcRenderer.invoke('netease:recommend:resource'),
    // 歌单详情
    playlistDetail: (id) => ipcRenderer.invoke('netease:playlist:detail', id),
    // 歌曲 URL
    songUrl: (id, level = 'exhigh') => ipcRenderer.invoke('netease:song:url', id, level),
    songUrlBatch: (ids, level = 'exhigh') => ipcRenderer.invoke('netease:song:urlBatch', ids, level),
    // 智能 URL：试听版自动回退到 MV
    songUrlSmart: (id) => ipcRenderer.invoke('netease:song:urlSmart', id),
    // 歌词
    lyric: (id) => ipcRenderer.invoke('netease:lyric', id),
    // 听歌打卡（同步到网易云最近播放）
    scrobble: (id, sourceId, time) => ipcRenderer.invoke('netease:scrobble', id, sourceId, time),
    // 喜欢的歌曲
    like: (id, like = true) => ipcRenderer.invoke('netease:like', id, like),
    likelist: (uid) => ipcRenderer.invoke('netease:likelist', uid),
    // 收藏单曲到歌单 / 从歌单删除
    playlistTracks: (op, pid, trackIds) => ipcRenderer.invoke('netease:playlist:tracks', op, pid, trackIds),
    // 歌手
    artistDetail: (id) => ipcRenderer.invoke('netease:artist:detail', id),
    artistTopSong: (id) => ipcRenderer.invoke('netease:artist:topSong', id),
    artistSongs: (id, options) => ipcRenderer.invoke('netease:artist:songs', id, options),
    artistAlbum: (id, options) => ipcRenderer.invoke('netease:artist:album', id, options),
    artistMv: (id, options) => ipcRenderer.invoke('netease:artist:mv', id, options),
    // 歌手关注（t=1 关注，t=0 取消关注）
    artistSub: (id, t = 1) => ipcRenderer.invoke('netease:artist:sub', id, t),
    artistSublist: (options) => ipcRenderer.invoke('netease:artist:sublist', options),
    // 专辑
    album: (id) => ipcRenderer.invoke('netease:album', id),
    // 专辑收藏（t=1 收藏，t=0 取消收藏）
    albumSub: (id, t = 1) => ipcRenderer.invoke('netease:album:sub', id, t),
    albumSublist: (options) => ipcRenderer.invoke('netease:album:sublist', options),
    // 私人 FM（心动模式）
    personalFm: () => ipcRenderer.invoke('netease:personalFm'),
    // MV
    mvDetail: (id) => ipcRenderer.invoke('netease:mv:detail', id),
    mvUrl: (id, r) => ipcRenderer.invoke('netease:mv:url', id, r),
    // 搜索
    search: (keywords, options) => ipcRenderer.invoke('netease:search', keywords, options),
    searchHot: () => ipcRenderer.invoke('netease:search:hot'),
    searchSuggest: (keywords) => ipcRenderer.invoke('netease:search:suggest', keywords),
  },
  // 系统级——窗口控制
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    toggleFullscreen: () => ipcRenderer.send('win:toggleFullscreen'),
    // 同步查询当前是否全屏：用于「最大化按钮在全屏态下应退出全屏」的判断
    isFullScreen: () => ipcRenderer.sendSync('win:isFullScreen'),
    // 「进入/退出全屏」事件：主进程 fullscreen 状态变化时通知渲染进程刷新按钮图标
    onFullscreenChange: (cb) => {
      const listener = (_e, isFull) => cb(isFull);
      ipcRenderer.on('win:fullscreen-change', listener);
      return () => ipcRenderer.removeListener('win:fullscreen-change', listener);
    },
  },
  // 应用设置
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (partial) => ipcRenderer.invoke('settings:save', partial),
    pickImage: () => ipcRenderer.invoke('settings:pickImage'),
    pickFont: () => ipcRenderer.invoke('settings:pickFont'),
  },
  // 窗口控制
  enterFullscreen: () => ipcRenderer.invoke('window:enterFullscreen'),
  exitFullscreen: () => ipcRenderer.invoke('window:exitFullscreen'),
  isFullscreen: () => ipcRenderer.invoke('window:isFullscreen'),
  // 媒体快捷键回调（主进程触发 → 渲染进程响应）
  onMediaAction: (cb) => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on('media:action', handler);
    return () => ipcRenderer.removeListener('media:action', handler);
  },
  // 原生 SMTC（Windows）：替代 Chromium MediaSession→SMTC，封面无下采样限制
  smtc: {
    setMetadata: (payload) => ipcRenderer.invoke('smtc:setMetadata', payload),
    setPlayback: (state) => ipcRenderer.invoke('smtc:setPlayback', state),
    setPosition: (durationMs, positionMs) => ipcRenderer.invoke('smtc:setPosition', durationMs, positionMs),
  },
  // 播放器状态持久化：保存/恢复播放队列、当前曲目、播放模式、播放位置
  player: {
    loadState: () => ipcRenderer.invoke('player:loadState'),
    saveState: (state) => ipcRenderer.invoke('player:saveState', state),
  },
});
