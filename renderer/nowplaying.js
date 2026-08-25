// 全屏播放页：点击底栏封面从底部拉出铺满应用
// - 左侧：封面 + 歌名 + 歌手
// - 右侧：逐字滚动歌词（yrc 逐字高亮，无 yrc 时回退行级 lrc）
// - 底部：进度条 + 上/下一首 + 播放/暂停 + 模式 + 播放列表 + 音量
// - 鼠标离开底部区域自动隐藏底部控件；进入时再显示
// - 左上退出按钮：默认隐藏，鼠标移入 now-playing 区域时显示

const NP = {
  root: document.getElementById('now-playing'),
  exit: document.getElementById('np-exit'),
  fullscreen: document.getElementById('np-fullscreen'),
  topControls: document.querySelector('.np-top-controls'),
  cover: document.getElementById('np-cover'),
  title: document.getElementById('np-title'),
  artist: document.getElementById('np-artist'),
  lyric: document.getElementById('np-lyric'),
  lyricEmpty: document.getElementById('np-lyric-empty'),
  controls: document.getElementById('np-controls'),
  timeCur: document.getElementById('np-time-cur'),
  timeDur: document.getElementById('np-time-dur'),
  seek: document.getElementById('np-seek'),
  seekFill: document.getElementById('np-seek-fill'),
  play: document.getElementById('np-play'),
  prev: document.getElementById('np-prev'),
  next: document.getElementById('np-next'),
  mode: document.getElementById('np-mode'),
  like: document.getElementById('np-like'),
  playlist: document.getElementById('np-playlist'),
  volume: document.getElementById('np-volume'),
  volumeFill: document.getElementById('np-volume-fill'),
  bg: document.getElementById('np-bg'),
  translationToggle: document.getElementById('np-translation-toggle'),

  // 歌词：[{ time, text, translation?, el? }]（lrc 模式）
  lyricLines: [],
  activeLyricIndex: -1,
  // 逐字歌词：[{ time, duration, words: [{ time, duration, text }] }]
  yrcLines: [],
  isYrc: false,
  hideTimer: null,
  _lastCoverUrl: null,
};

// ===== Logo 兜底路径：优先复用 player.js 暴露的同一份常量，保证一致性；
// 若 player.js 尚未加载（极罕见时序），退回与 player 内定义一致的硬编码路径。*/
const NP_LOGO_PATH = (window.player && window.player.LOGO_PATH) || '../main/icon.png';

// ---------- 打开 / 关闭 ----------
function openNowPlaying() {
  if (!NP.root.classList.contains('hidden')) return;
  NP.root.classList.remove('hidden', 'closing');
  NP.root.classList.add('opening');
  const mult = window.animMult ? window.animMult() : 1;
  setTimeout(() => NP.root.classList.remove('opening'), Math.round(280 * mult));
  // 打开播放页后：先保持控件持续显示 4 秒（让用户能看到并移到按钮上），再开始 2.5 秒空闲隐藏
  showControlsOnOpen();
  refreshNowPlayingAll();
}

function closeNowPlaying() {
  if (NP.root.classList.contains('hidden')) return;
  NP.root.classList.add('closing');
  const mult = window.animMult ? window.animMult() : 1;
  setTimeout(() => {
    NP.root.classList.add('hidden');
    NP.root.classList.remove('closing');
    // ===== 关闭播放页后停掉 idle 计时器，避免后台事件继续消耗 CPU，
    // 并清掉 hide-controls 防止下次打开先出现"控件消失"。*/
    stopIdleTracker();
    stopNpSeekRAF();
  }, Math.round(240 * mult));
}

NP.exit.addEventListener('click', closeNowPlaying);

// 全屏按钮：交给主进程切换 BrowserWindow 全屏态
NP.fullscreen.addEventListener('click', () => {
  if (window.api && window.api.window && typeof window.api.window.toggleFullscreen === 'function') {
    window.api.window.toggleFullscreen();
  } else if (document.fullscreenEnabled) {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }
});

// ===== 全屏按钮图标与「最大化」按钮做区分 =====
// 全屏按钮（左上角，np-fullscreen）：未全屏=expand 图标，全屏后=minimize-2 图标
// 最大化按钮（右上角，np-win-max）：未全屏=square 图标，全屏后=minimize-2 图标
// 这样两个按钮在非全屏态图标不同（expand vs square），用户能一眼区分
function syncNpFullscreenIcon() {
  if (!NP.fullscreen) return;
  const icon = NP.fullscreen.querySelector('i[data-lucide]');
  if (!icon) return;
  const isFull = window.api && window.api.window && typeof window.api.window.isFullScreen === 'function'
    && window.api.window.isFullScreen();
  icon.setAttribute('data-lucide', isFull ? 'minimize-2' : 'expand');
  if (window.lucide) window.lucide.createIcons();
}
// 全屏态变化时同步图标（主进程 fullscreen-change 事件）
if (window.api && window.api.window && typeof window.api.window.onFullscreenChange === 'function') {
  window.api.window.onFullscreenChange(() => {
    syncNpFullscreenIcon();
    syncNpWinMaxIcon();
    showControls();
  });
}

// ===== 右上角窗口控件：复刻主顶栏，让用户在播放页/全屏态下也能最小化、退出全屏、关闭 =====
const npWinMin = document.getElementById('np-win-min');
const npWinMax = document.getElementById('np-win-max');
const npWinClose = document.getElementById('np-win-close');
if (npWinMin) {
  npWinMin.addEventListener('click', () => {
    if (window.api && window.api.window) window.api.window.minimize();
    showControls();
  });
}
if (npWinMax) {
  // 全屏态下点「最大化」= 退出全屏（用户期望的右上角退出路径）
  // 非全屏态 = 切换最大化/还原
  npWinMax.addEventListener('click', () => {
    if (!window.api || !window.api.window) return;
    if (typeof window.api.window.isFullScreen === 'function' && window.api.window.isFullScreen()) {
      window.api.window.toggleFullscreen();
    } else {
      window.api.window.maximize();
    }
    showControls();
  });
}
if (npWinClose) {
  npWinClose.addEventListener('click', () => {
    if (window.api && window.api.window) window.api.window.close();
  });
}

// 全屏状态变化时：刷新右上角「最大化」按钮图标（全屏=minimize-2，非全屏=maximize - 与主顶栏一致）
function syncNpWinMaxIcon() {
  if (!npWinMax) return;
  const icon = npWinMax.querySelector('i[data-lucide]');
  if (!icon) return;
  const isFull = window.api && window.api.window && typeof window.api.window.isFullScreen === 'function'
    && window.api.window.isFullScreen();
  // 非全屏态用 maximize（与主顶栏 win-max 相同图标），全屏态用 minimize-2（退出全屏）
  icon.setAttribute('data-lucide', isFull ? 'minimize-2' : 'maximize');
  if (window.lucide) window.lucide.createIcons();
}

// 喜欢按钮：复用 player 的红心逻辑
NP.like.addEventListener('click', (e) => {
  e.stopPropagation();
  if (window.player && typeof window.player.toggleLikeCurrent === 'function') {
    window.player.toggleLikeCurrent();
  }
  showControls();
});

// ---------- 控件显示控制 ----------
// ===== 根据用户需求重写：
//  - 打开播放页时，先显示控件 4 秒（showControlsOnOpen），
//  - 之后每 2.5 秒鼠标没有任何移动/按键/点击 → 加 .hide-controls 触发 CSS：
//      顶部两按钮 fade out；底栏整体下滚 + 淡出。
//  - 一旦有 mousemove/keydown/click/scroll 等用户活动 → 立刻移除 .hide-controls 重新显示，
//    并重置计时器继续等下一次空闲。
//  - 进度条拖动中（npSeekDragging）时计时器暂停，避免拖到一半控件消失。
const NP_IDLE_MS = 2500;       // 多长时间不动算"空闲"
const NP_SHOW_FIRST_MS = 4000; // 刚打开时持续显示的时间
let _npIdleTimer = null;
let _npIdleEnabled = false;

function _clearIdleTimer() {
  if (_npIdleTimer) { clearTimeout(_npIdleTimer); _npIdleTimer = null; }
}
function _applyHideControls(hidden) {
  if (!NP.root) return;
  if (hidden) NP.root.classList.add('hide-controls');
  else NP.root.classList.remove('hide-controls');
}
function _scheduleHide() {
  _clearIdleTimer();
  if (!_npIdleEnabled) return;
  // 拖动进度条 / 打开了队列面板等 → 先不隐藏，等下一轮活动再排
  if (npSeekDragging) return;
  _npIdleTimer = setTimeout(() => {
    // 到点：真的隐藏控件
    _applyHideControls(true);
  }, NP_IDLE_MS);
}
// 立刻显示控件，并重置下一次隐藏的计时
function showControls() {
  _applyHideControls(false);
  if (_npIdleEnabled) _scheduleHide();
}
// 启动 idle 机制（由 showControlsOnOpen 在打开播放页时调用）
function scheduleHideControls() {
  if (!_npIdleEnabled) return;
  _scheduleHide();
}
// 打开播放页的控件可见性策略：
//   先显示 NP_SHOW_FIRST_MS（4s），之后按 idle 2.5s 周期隐藏。
function showControlsOnOpen() {
  // 立刻显示控件（防止 CSS 过渡结束前隐藏）
  _npIdleEnabled = true;
  _applyHideControls(false);
  _clearIdleTimer();
  // 4 秒后开始接受 idle 超时
  _npIdleTimer = setTimeout(() => {
    _scheduleHide();
  }, NP_SHOW_FIRST_MS);
}
// 关闭播放页时：停止一切 idle 计时器，并清掉 hide-controls（避免下次打开残留状态）
function stopIdleTracker() {
  _npIdleEnabled = false;
  _clearIdleTimer();
  _applyHideControls(false);
}

// ---------- Idle 活动监听：在 NP.root / document 上统一抓一次 ----------
// 事件回调：只要用户做了什么，立刻显示控件并重排下一次隐藏
function _onActivity(e) {
  if (!_npIdleEnabled) return;
  if (NP.root && NP.root.classList.contains('hidden')) return;
  // 忽略非目标窗口的合成 mousemove（比如没移动只 hover 的重复事件）——没必要，直接节流即可
  showControls();
}
if (NP.root) {
  // mousemove 高频 → 加个简单的 50ms 节流避免反复 setTimeout 重建
  let _mmThrottle = 0;
  NP.root.addEventListener('mousemove', (e) => {
    if (!_npIdleEnabled) return;
    const now = Date.now();
    if (now - _mmThrottle < 50) return;
    _mmThrottle = now;
    // 移动距离极小（<2px）直接忽略，避免静止时浏览器偶尔发送的 0 距离事件重置计时器
    const last = NP._lastMove || { x: -999, y: -999 };
    if (Math.abs(last.x - e.clientX) < 2 && Math.abs(last.y - e.clientY) < 2) return;
    NP._lastMove = { x: e.clientX, y: e.clientY };
    showControls();
  }, { passive: true });
  NP.root.addEventListener('mousedown', _onActivity, true);
  NP.root.addEventListener('mouseup',   _onActivity, true);
  NP.root.addEventListener('wheel',     _onActivity, { passive: true });
  NP.root.addEventListener('keydown',   _onActivity);
  NP.root.addEventListener('touchstart',_onActivity, { passive: true });
  NP.root.addEventListener('touchmove', _onActivity, { passive: true });
  // 鼠标从隐藏状态刚 hover 进 now-playing 时，即便没移动也要立刻显示
  NP.root.addEventListener('mouseenter', (e) => {
    if (!_npIdleEnabled) return;
    showControls();
  });
}

// ---------- 歌手链接渲染（播放页 np-artist 可点击跳转）----------
// 播放页是暗色背景，歌手链接用白色系（区别于底栏的 muted-foreground）
function renderNpArtistsHtml(ar, fallbackText) {
  const list = Array.isArray(ar) ? ar.filter(a => a && a.name) : [];
  if (!list.length) return escapeHtml(fallbackText || '—');
  const parts = list.map(a => {
    if (a.id) {
      return `<a href="#/artist/${a.id}" class="np-artist-link" data-nav="artist" data-artist-id="${a.id}">${escapeHtml(a.name)}</a>`;
    }
    return `<span>${escapeHtml(a.name)}</span>`;
  });
  return parts.join('<span class="np-artist-sep"> / </span>');
}
function setNpArtistHtml(html) {
  if (!NP.artist) return;
  NP.artist.innerHTML = html;
  // 点击歌手链接不冒泡（避免触发其他播放页交互）
  NP.artist.querySelectorAll('a[data-nav="artist"]').forEach(a => {
    a.addEventListener('click', (e) => { e.stopPropagation(); });
  });
}

// ---------- 同步状态 ----------
// 监听 player 的曲目变化事件，刷新封面/标题/歌词
// ===== 修复：不再遇到 !track 直接 return，
// 空状态（未播放任何歌曲）也要把封面换成 LOGO、标题/歌手清空、歌词重置。*/
function refreshNowPlayingTrack(track) {
  // 封面渐变切换：先淡出旧封面，加载新封面后淡入
  if (NP.cover) {
    NP.cover.style.transition = 'opacity 0.4s ease';
    NP.cover.style.opacity = '0';
    // ===== 修复：曲目封面为空 → 用 LOGO；曲目本身为空（未在播放）→ 也用 LOGO
    // 无论哪种都不允许出现空 src（否则 img 显示为碎图，难看）*/
    const coverBase = track ? (track.cover || '') : '';
    const newSrc = coverBase ? coverBase : NP_LOGO_PATH;
    const img = new Image();
    img.onload = () => {
      NP.cover.src = newSrc;
      NP.cover.style.opacity = '1';
    };
    img.onerror = () => {
      // 加载失败兜底（例如 logo 路径也找不到）：直接赋值 logo 并淡入，避免永久 0 opacity
      NP.cover.src = NP_LOGO_PATH;
      NP.cover.style.opacity = '1';
    };
    img.src = newSrc;
  }
  // ===== 无曲目：清空标题/歌手文案到「未在播放」状态 =====
  if (!track) {
    if (NP.title) NP.title.textContent = '未在播放';
    if (NP.artist) {
      NP.artist.innerHTML = '<span>—</span>';
    }
    updateNpBackground(null);
    loadLyric(null); // 清空歌词
    if (NP.like) NP.like.disabled = true;
    return;
  }
  // ===== 有曲目：正常刷新 =====
  if (NP.title) NP.title.textContent = track.name || '';
  // 歌手名可点击跳转到歌手页（用 track.ar 数组，含 id）
  if (NP.artist) setNpArtistHtml(renderNpArtistsHtml(track.ar, track.artists));
  updateNpBackground(track.cover);
  loadLyric(track.id);
  // 同步喜欢按钮红色态
  if (window.player && typeof window.player.syncLikeButton === 'function') {
    window.player.syncLikeButton(track.id);
  }
}

// ---------- 流动颜色背景 ----------
// 从当前封面提取 3 个主色，写入 --np-c1/2/3 到 #np-bg 上，
// 由 styles.css 里的 .np-bg-blob-N 用作渐变背景。不直接显示封面图。
function updateNpBackground(coverUrl) {
  // 颜色变量挂在 #now-playing 根节点上，背景层 blob 与歌词都能继承使用
  const host = NP.root || NP.bg;
  if (!host) return;
  // 同一张封面不重复提取
  if (!coverUrl) {
    host.style.setProperty('--np-c1', '#9708CC');
    host.style.setProperty('--np-c2', '#43CBFF');
    host.style.setProperty('--np-c3', '#FB016D');
    NP._lastCoverUrl = null;
    return;
  }
  if (NP._lastCoverUrl === coverUrl) return;
  NP._lastCoverUrl = coverUrl;

  // 网易云封面 URL 末尾带 ?param=...，我们用小尺寸缩略图提取颜色更快
  const sampleUrl = coverUrl.replace(/\?param=\d+x\d+/i, '') + '?param=64x64';
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const colors = extractDominantColors(img, 3);
      if (colors && colors.length) {
        host.style.setProperty('--np-c1', colors[0]);
        if (colors[1]) host.style.setProperty('--np-c2', colors[1]);
        if (colors[2]) host.style.setProperty('--np-c3', colors[2]);
      }
    } catch (err) {
      // 跨域 / canvas tainted：保留默认色，不报错
    }
  };
  img.onerror = () => { /* 保留默认色 */ };
  img.src = sampleUrl;
}

// 简单颜色提取：把图片缩到 64x64，按像素累计色相聚类，取出现频次最高的 3 种
function extractDominantColors(img, count = 3) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;

  // 量化到 4-bit per channel（16 级），合并相近色
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
    if (a < 128) continue;
    // 过滤过暗（接近黑）和过亮（接近白）的像素，让背景颜色更有辨识度
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max < 30) continue;
    if (min > 230 && max - min < 15) continue;
    const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
    const prev = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    prev.r += r; prev.g += g; prev.b += b; prev.n += 1;
    buckets.set(key, prev);
  }
  if (!buckets.size) return null;
  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
  const colors = [];
  for (const bk of sorted) {
    if (colors.length >= count) break;
    const r = Math.round(bk.r / bk.n);
    const g = Math.round(bk.g / bk.n);
    const b = Math.round(bk.b / bk.n);
    // 与已选颜色差异过小则跳过（避免三个色相相同）
    const tooClose = colors.some(c => Math.abs(c.r - r) + Math.abs(c.g - g) + Math.abs(c.b - b) < 60);
    if (tooClose) continue;
    colors.push({ r, g, b });
  }
  // 不够 3 个就用已有的填充
  while (colors.length < count && sorted.length > 0) {
    const bk = sorted[colors.length % sorted.length];
    colors.push({
      r: Math.round(bk.r / bk.n),
      g: Math.round(bk.g / bk.n),
      b: Math.round(bk.b / bk.n),
    });
  }
  return colors.map(c => `rgb(${c.r}, ${c.g}, ${c.b})`);
}

function refreshNowPlayingPlayback() {
  const audio = window.player.audio;
  if (!audio) return;
  const p = audio.currentTime || 0;
  const d = npDurationSec();
  // 用 player._playerFmtTime（本地独立实现）避免全局 fmtTime 被覆盖导致"1/1"
  const _fmt = (window._playerFmtTime || fmtTime);
  if (NP.timeCur) NP.timeCur.textContent = _fmt(p);
  if (NP.timeDur) NP.timeDur.textContent = _fmt(d);
  if (NP.seekFill && !_npSeekDragging) NP.seekFill.style.width = (d > 0 ? (p / d * 100) : 0) + '%';
  syncLyric(p);
  // 调试：播放页时长显示路径，仅在显示文本变化时记录
  if (window.bcsLog) {
    const shown = `${NP.timeCur ? NP.timeCur.textContent : ''}/${NP.timeDur ? NP.timeDur.textContent : ''}`;
    const suspicious = d > 0 && d < 5;
    window.bcsLog('nowplaying.refreshPlayback', {
      cur: p, dur: d, displayed: shown, suspicious,
    }, { dedupe: true });
  }
}

// 统一获取时长（秒）：复用 player.getDurationSec，避免各处各自取 audio.duration 不一致
function npDurationSec() {
  if (window.player && typeof window.player.getDurationSec === 'function') {
    const d = window.player.getDurationSec();
    return (d && isFinite(d)) ? d : 0;
  }
  const audio = window.player && window.player.audio;
  const d = audio ? audio.duration : 0;
  return (d && isFinite(d)) ? d : 0;
}

// ====== 平滑进度条 rAF：在 timeupdate 之间插值，避免每秒一跳 ======
let _npSeekRAF = null;
let _npSeekLastTime = 0;
let _npSeekLastTs = 0;
let _npSeekDragging = false;

function startNpSeekRAF() {
  if (_npSeekRAF) return;
  const tick = () => {
    const audio = window.player ? window.player.audio : null;
    if (!audio || NP.root.classList.contains('hidden')) {
      _npSeekRAF = null;
      return;
    }
    if (!_npSeekDragging && !audio.paused) {
      const dur = npDurationSec();
      if (dur > 0) {
        const now = performance.now();
        const elapsed = (now - _npSeekLastTs) / 1000;
        const interp = _npSeekLastTime + elapsed * (audio.playbackRate || 1);
        const cur = Math.min(interp, dur);
        if (NP.seekFill) NP.seekFill.style.width = `${Math.min(100, (cur / dur) * 100)}%`;
        // 时间文字只在秒变化时更新
        const sec = Math.floor(cur);
        if (NP.timeCur && NP.timeCur.dataset.sec !== String(sec)) {
          NP.timeCur.dataset.sec = String(sec);
          const _fmt = (window._playerFmtTime || fmtTime);
          NP.timeCur.textContent = _fmt(cur);
        }
      }
    }
    _npSeekRAF = requestAnimationFrame(tick);
  };
  _npSeekRAF = requestAnimationFrame(tick);
}
function stopNpSeekRAF() {
  if (_npSeekRAF) { cancelAnimationFrame(_npSeekRAF); _npSeekRAF = null; }
}

function refreshNowPlayingAll() {
  if (!window.player) return;
  refreshNowPlayingTrack(window.player.current());
  refreshNowPlayingPlayback();
  updatePlayBtnIcon();
  syncModeBtn();
  syncVolume();
}

// 修复：用 innerHTML 重置图标元素，避免 lucide 替换成 svg 后找不到 i[data-lucide]
function updatePlayBtnIcon() {
  if (!NP.play) return;
  const playing = window.player.state.isPlaying;
  const icon = playing ? 'pause' : 'play';
  NP.play.innerHTML = `<i data-lucide="${icon}" class="w-6 h-6"></i>`;
  if (window.lucide) window.lucide.createIcons();
}

function syncModeBtn() {
  if (!NP.mode || !window.player) return;
  const mode = window.player.state.mode;
  const ICONS = { SEQUENTIAL: 'list', LOOP: 'repeat', SINGLE: 'repeat-1', SHUFFLE: 'shuffle' };
  NP.mode.innerHTML = `<i data-lucide="${ICONS[mode] || 'list'}" class="w-4 h-4"></i>`;
  if (window.lucide) window.lucide.createIcons();
}

function syncVolume() {
  const audio = window.player.audio;
  if (!audio || !NP.volumeFill) return;
  NP.volumeFill.style.width = (audio.volume * 100) + '%';
}

// ---------- 控件事件 ----------
NP.prev.addEventListener('click', () => { window.player.prev(); showControls(); });
NP.next.addEventListener('click', () => { window.player.next(); showControls(); });
NP.play.addEventListener('click', () => { window.player.toggle(); showControls(); });
NP.mode.addEventListener('click', () => {
  // 委托给底栏 btn-mode：触发其 click，使模式状态一致
  const btnMode = document.getElementById('btn-mode');
  if (btnMode) btnMode.click();
  setTimeout(syncModeBtn, 0);
  showControls();
});
NP.playlist.addEventListener('click', (e) => {
  e.stopPropagation();
  const btn = document.getElementById('btn-playlist');
  if (btn) btn.click();
});

// 进度条拖动
NP.seek.addEventListener('click', (e) => {
  const audio = window.player.audio;
  const dur = npDurationSec();
  if (!audio || !dur) return;
  const rect = NP.seek.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audio.currentTime = ratio * dur;
  refreshNowPlayingPlayback();
  showControls();
});
// 拖动支持：与主页一致，拖动时连续 seek（产生预览声音）
let npSeekDragging = false;
NP.seek.addEventListener('mousedown', (e) => { npSeekDragging = true; _npSeekDragging = true; showControls(); });
document.addEventListener('mousemove', (e) => {
  if (!npSeekDragging) return;
  const audio = window.player.audio;
  const dur = npDurationSec();
  if (!audio || !dur) return;
  const rect = NP.seek.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  // 连续 seek → 拖动时出现预览声音（与主页精细调节一致）
  audio.currentTime = ratio * dur;
  NP.seekFill.style.width = (ratio * 100) + '%';
  const _fmt = (window._playerFmtTime || fmtTime);
  if (NP.timeCur) NP.timeCur.textContent = _fmt(ratio * dur);
});
document.addEventListener('mouseup', (e) => {
  if (!npSeekDragging) return;
  npSeekDragging = false;
  _npSeekDragging = false;
  const audio = window.player.audio;
  const dur = npDurationSec();
  if (audio && dur) {
    const rect = NP.seek.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * dur;
    refreshNowPlayingPlayback();
  }
});

// 音量条
NP.volume.addEventListener('click', (e) => {
  const audio = window.player.audio;
  if (!audio) return;
  const rect = NP.volume.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audio.volume = ratio;
  syncVolume();
});

// ---------- 逐字歌词（yrc）+ 行级歌词（lrc）----------
// 网易云 lyric 接口返回 yrc.lyric（逐字格式）和 lrc.lyric（行级格式）
// yrc 格式：每行 [start_ms,duration_ms,0](word1)word2(word3)...
//   例：[4300,1500,0]不要[5800,800,0]离开
// 我们优先用 yrc 逐字高亮；无 yrc 时回退 lrc 行级高亮

// 解析 yrc 逐字歌词：返回 [{ time, duration, words: [{ time, duration, text }] }]
function parseYrc(yrcStr) {
  if (!yrcStr) return [];
  const lines = yrcStr.split('\n');
  const out = [];
  // 行头：[start,duration,xxx]
  const lineHeadRe = /\[(\d+),(\d+),\d+\]/;
  // 行内词：(word) 或 直接文本（无括号的是纯文本部分）
  // 网易云 yrc 实际格式：[start,duration,0](word1,dur1)word2(word3,dur3)
  // 简化处理：按 () 分组提取词
  for (const line of lines) {
    const headMatch = line.match(lineHeadRe);
    if (!headMatch) continue;
    const lineStart = parseInt(headMatch[1], 10);
    const lineDuration = parseInt(headMatch[2], 10);
    const rest = line.slice(headMatch[0].length);

    // 提取词：格式 (word,duration) 或 (word) 或纯文本
    // 用正则全局匹配 (...) 组
    const words = [];
    const wordRe = /\(([^)]*)\)/g;
    let lastIdx = 0;
    let wordTime = lineStart;
    let m;
    while ((m = wordRe.exec(rest)) !== null) {
      // 纯文本部分（括号前）
      const textBefore = rest.slice(lastIdx, m.index);
      if (textBefore) {
        words.push({ time: wordTime, duration: 0, text: textBefore });
      }
      // 括号内：word,duration 或 word
      const inner = m[1];
      const parts = inner.split(',');
      const wText = parts[0] || '';
      const wDur = parts.length > 1 ? parseInt(parts[1], 10) || 0 : 0;
      if (wText) {
        words.push({ time: wordTime, duration: wDur, text: wText });
        wordTime += wDur;
      }
      lastIdx = m.index + m[0].length;
    }
    // 行尾纯文本
    const textAfter = rest.slice(lastIdx);
    if (textAfter) {
      words.push({ time: wordTime, duration: 0, text: textAfter });
    }

    if (words.length) {
      out.push({ time: lineStart / 1000, duration: lineDuration / 1000, words });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

// 解析行级 lrc
function parseLrc(lrcStr) {
  if (!lrcStr) return [];
  const lines = lrcStr.split('\n');
  const out = [];
  // [mm:ss.xx] 或 [mm:ss.xxx] 可多个
  const re = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  for (const line of lines) {
    let m;
    const times = [];
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      const min = parseInt(m[1], 10);
      const sec = parseFloat(m[2]);
      times.push(min * 60 + sec);
    }
    const text = line.replace(re, '').trim();
    if (!times.length) continue;
    for (const t of times) out.push({ time: t, text });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

async function loadLyric(songId) {
  // ===== 修复：调用传入空/假值（例如未播放任何歌曲）时，先清掉旧歌词再直接返回，
  // 否则旧歌曲的歌词会残留在"未在播放"界面上。*/
  NP.lyricLines = [];
  NP.yrcLines = [];
  NP.isYrc = false;
  NP.lyric.innerHTML = '';
  NP.activeLyricIndex = -1;
  if (!songId) {
    // 无曲目时：歌词为空，显示"暂无歌词"风格的占位
    NP.lyricEmpty.classList.remove('hidden');
    NP.lyricEmpty.textContent = '未在播放';
    return;
  }
  NP.lyricEmpty.classList.remove('hidden');
  NP.lyricEmpty.textContent = '歌词加载中…';
  try {
    const body = await window.api.netease.lyric(songId);
    const lrcStr = body && body.lrc && body.lrc.lyric;
    const tLrcStr = body && body.tlyric && body.tlyric.lyric;
    const yrcStr = body && body.yrc && body.yrc.lyric;

    if (!lrcStr && !yrcStr) {
      NP.lyricEmpty.textContent = '暂无歌词';
      NP.lyricEmpty.classList.remove('hidden');
      return;
    }

    // 优先 yrc 逐字歌词
    if (yrcStr) {
      NP.yrcLines = parseYrc(yrcStr);
      NP.isYrc = NP.yrcLines.length > 0;
    }

    if (NP.isYrc) {
      // 渲染逐字歌词：每行一个 div，每个 word 一个 span（带 data-time）
      const transMap = new Map();
      if (tLrcStr) {
        parseLrc(tLrcStr).forEach(l => transMap.set(l.time, l.text));
      }
      const html = NP.yrcLines.map((line, i) => {
        const trans = transMap.get(Math.round(line.time)) || '';
        const wordsHtml = line.words.map((w, j) =>
          `<span class="np-yrc-word" data-time="${w.time}" data-dur="${w.duration}">${escapeHtml(w.text || ' ')}</span>`
        ).join('');
        const transHtml = trans
          ? `<div class="np-lyric-line translation" data-idx="${i}">${escapeHtml(trans)}</div>`
          : '';
        return `<div class="np-lyric-line" data-idx="${i}">${wordsHtml}</div>${transHtml}`;
      }).join('');
      NP.lyric.innerHTML = html;
    } else {
      // 回退行级 lrc
      const mainLines = parseLrc(lrcStr);
      const transLines = tLrcStr ? parseLrc(tLrcStr) : [];
      const transMap = new Map();
      transLines.forEach(l => transMap.set(l.time, l.text));
      NP.lyricLines = mainLines.map(l => ({
        ...l,
        translation: transMap.get(l.time) || '',
      }));
      const html = NP.lyricLines.map((l, i) => {
        const tHtml = l.translation
          ? `<div class="np-lyric-line translation" data-idx="${i}">${escapeHtml(l.translation)}</div>`
          : '';
        return `<div class="np-lyric-line" data-idx="${i}">${escapeHtml(l.text || '♪')}</div>${tHtml}`;
      }).join('');
      NP.lyric.innerHTML = html;
    }

    // 绑定歌词行点击 → 跳转到对应时间点
    bindLyricClicks();

    NP.lyricEmpty.classList.add('hidden');
    NP.activeLyricIndex = -1;
  } catch (err) {
    console.error('[nowplaying] 加载歌词失败:', err);
    NP.lyricEmpty.textContent = '歌词加载失败';
    NP.lyricEmpty.classList.remove('hidden');
  }
}

// 歌词行点击 → 跳转到对应播放时间
function bindLyricClicks() {
  if (!NP.lyric) return;
  const audio = window.player ? window.player.audio : null;
  if (!audio) return;
  NP.lyric.querySelectorAll('.np-lyric-line').forEach(el => {
    if (el.classList.contains('translation')) return; // 翻译行不响应
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.idx, 10);
      if (isNaN(idx)) return;
      let targetTime = -1;
      if (NP.isYrc && NP.yrcLines[idx]) {
        // YRC 时间是毫秒，转换为秒
        targetTime = NP.yrcLines[idx].time / 1000;
      } else if (NP.lyricLines && NP.lyricLines[idx]) {
        // LRC 时间是秒
        targetTime = NP.lyricLines[idx].time;
      }
      if (targetTime >= 0 && audio) {
        audio.currentTime = targetTime;
        if (audio.paused) audio.play().catch(() => {});
      }
    });
  });
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// 跟随播放进度滚动到当前行 + 逐字高亮
function syncLyric(currentTime) {
  if (NP.isYrc) {
    syncYrc(currentTime);
    return;
  }
  if (!NP.lyricLines.length) return;
  // 二分/线性找当前行
  let idx = -1;
  for (let i = 0; i < NP.lyricLines.length; i++) {
    if (NP.lyricLines[i].time <= currentTime) idx = i;
    else break;
  }
  if (idx === NP.activeLyricIndex) return;
  NP.activeLyricIndex = idx;
  // 移除旧 active
  NP.lyric.querySelectorAll('.np-lyric-line.active').forEach(el => el.classList.remove('active'));
  if (idx < 0) {
    NP.lyric.scrollTop = 0;
    return;
  }
  const lineEls = NP.lyric.querySelectorAll('.np-lyric-line:not(.translation)');
  const el = lineEls[idx];
  if (el) {
    el.classList.add('active');
    // 同步高亮紧随其后的翻译行（与主行同 data-idx）
    const transEl = el.nextElementSibling;
    if (transEl && transEl.classList.contains('translation')) {
      transEl.classList.add('active');
    }
    // 滚动到居中
    const containerH = NP.lyric.clientHeight;
    const targetTop = el.offsetTop - containerH / 2 + el.offsetHeight / 2;
    NP.lyric.scrollTo({ top: targetTop, behavior: 'smooth' });
  }
}

// 逐字高亮：根据 currentTime 高亮当前行的已唱词
function syncYrc(currentTime) {
  if (!NP.yrcLines.length) return;
  // 找当前行
  let idx = -1;
  for (let i = 0; i < NP.yrcLines.length; i++) {
    if (NP.yrcLines[i].time <= currentTime) idx = i;
    else break;
  }
  if (idx === NP.activeLyricIndex) {
    // 同行：只更新逐字高亮
    updateYrcWordHighlight(idx, currentTime);
    return;
  }
  NP.activeLyricIndex = idx;
  NP.lyric.querySelectorAll('.np-lyric-line.active').forEach(el => el.classList.remove('active'));
  if (idx < 0) {
    NP.lyric.scrollTop = 0;
    return;
  }
  const lineEls = NP.lyric.querySelectorAll('.np-lyric-line:not(.translation)');
  const el = lineEls[idx];
  if (el) {
    el.classList.add('active');
    // 同步高亮紧随其后的翻译行（与主行同 data-idx）
    const transEl = el.nextElementSibling;
    if (transEl && transEl.classList.contains('translation')) {
      transEl.classList.add('active');
    }
    const containerH = NP.lyric.clientHeight;
    const targetTop = el.offsetTop - containerH / 2 + el.offsetHeight / 2;
    NP.lyric.scrollTo({ top: targetTop, behavior: 'smooth' });
  }
  updateYrcWordHighlight(idx, currentTime);
}

// 逐字高亮：已唱过的词加 .sung 类
function updateYrcWordHighlight(lineIdx, currentTime) {
  const lineEls = NP.lyric.querySelectorAll('.np-lyric-line:not(.translation)');
  const el = lineEls[lineIdx];
  if (!el) return;
  const words = el.querySelectorAll('.np-yrc-word');
  words.forEach(w => {
    const t = parseFloat(w.dataset.time) || 0;
    if (currentTime >= t) w.classList.add('sung');
    else w.classList.remove('sung');
  });
}

// ---------- 翻译显示/隐藏 ----------
const NP_TRANS_KEY = 'bcsMusic:showTranslations';

function syncTranslationToggleBtn() {
  const btn = NP.translationToggle;
  if (!btn) return;
  const hidden = NP.lyric.classList.contains('hide-translations');
  btn.classList.toggle('off', hidden);
  btn.title = hidden ? '显示翻译' : '隐藏翻译';
}

function toggleTranslations() {
  NP.lyric.classList.toggle('hide-translations');
  try {
    const show = !NP.lyric.classList.contains('hide-translations');
    localStorage.setItem(NP_TRANS_KEY, show ? '1' : '0');
  } catch (e) { /* localStorage 不可用时静默忽略 */ }
  syncTranslationToggleBtn();
  // ===== 修复：切换翻译显示后，翻译行 height 变化会让当前 active 行位置漂移，
  // 必须立刻重新定位一次，否则会一直偏移到下一句才恢复。
  // 强制重置 activeLyricIndex 再调用 syncLyric，让滚动居中逻辑重新执行。
  const audio = window.player && window.player.audio;
  if (audio && NP.lyricLines.length) {
    NP.activeLyricIndex = -1;
    syncLyric(audio.currentTime || 0);
  }
}

// 初始化翻译显示偏好（页面加载时调用一次）
function initTranslationPreference() {
  let show = true;
  try {
    const v = localStorage.getItem(NP_TRANS_KEY);
    if (v !== null) show = v !== '0';
  } catch (e) { /* ignore */ }
  NP.lyric.classList.toggle('hide-translations', !show);
  syncTranslationToggleBtn();
}

if (NP.translationToggle) {
  NP.translationToggle.addEventListener('click', toggleTranslations);
}
initTranslationPreference();

// ---------- 时间格式化 ----------
function fmtTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---------- 绑定底栏封面点击 + player 事件 ----------
function bindNowPlayingToPlayer() {
  // 底栏封面点击 → 打开全屏
  const nowCover = document.getElementById('now-cover');
  if (nowCover) {
    nowCover.addEventListener('click', openNowPlaying);
  }
  // player 事件
  if (window.player) {
    window.player.on('track-changed', refreshNowPlayingTrack);
  }
  // audio 事件：节流刷新进度
  const audio = window.player ? window.player.audio : null;
  if (audio) {
    audio.addEventListener('timeupdate', () => {
      if (!NP.root.classList.contains('hidden')) {
        // 记录插值基准，启动 rAF 平滑动画
        _npSeekLastTime = audio.currentTime || 0;
        _npSeekLastTs = performance.now();
        refreshNowPlayingPlayback();
        if (!audio.paused) startNpSeekRAF(); else stopNpSeekRAF();
      }
    });
    audio.addEventListener('play', () => { updatePlayBtnIcon(); startNpSeekRAF(); });
    audio.addEventListener('pause', () => { updatePlayBtnIcon(); stopNpSeekRAF(); });
    audio.addEventListener('volumechange', syncVolume);
  }
}

// 暴露给外部，方便 app.js 在 player 初始化后调用
window.nowPlaying = {
  open: openNowPlaying,
  close: closeNowPlaying,
  refresh: refreshNowPlayingAll,
  bindToPlayer: bindNowPlayingToPlayer,
};
