// 播放器引擎：单一 audio 元素 + 队列 + 原生 SMTC 桥（Windows）
// SMTC 通过主进程 spawn 的 Rust 子进程（bcs-smtc.exe）直接调 Windows 原生 API，
// 避开 Chromium MediaSession→SMTC 把封面下采样到约 150×150 的限制

// ===== 全局调试日志器：环形缓冲（最多 1000 条），供设置页「调试日志」面板查看 =====
// 默认不开启记录（性能 & 隐私）；只有当用户在设置页打开「显示调试日志」开关后，
// window.__bcsDebug 才为 true，bcsLog 才会真正写入缓冲。所有 bcsLog 打点保留在代码里，
// 但关闭状态下为 no-op，不影响性能。
(function setupBcsLogger() {
  if (window.bcsLog) return;
  window.__bcsLogs = [];
  window.__bcsLogSeq = 0;
  window.__bcsLogFilter = '';
  window.__bcsDebug = false; // 默认关闭
  const _lastSig = new Map();
  // 默认 no-op：debug 关闭时不做任何工作（连 JSON.stringify 都不执行）
  window.bcsLog = function bcsLog(source, data, opts) {
    if (!window.__bcsDebug) return null;
    opts = opts || {};
    if (opts.dedupe) {
      const sig = source + '::' + (typeof data === 'string' ? data : JSON.stringify(data));
      if (_lastSig.get(source) === sig) return null;
      _lastSig.set(source, sig);
    }
    const entry = {
      seq: ++window.__bcsLogSeq,
      t: Date.now(),
      source: String(source),
      data: data === undefined ? null : data,
    };
    window.__bcsLogs.push(entry);
    if (window.__bcsLogs.length > 1000) window.__bcsLogs.shift();
    window.dispatchEvent(new CustomEvent('bcslog:append', { detail: entry }));
    try { console.log('[bcsLog:' + source + ']', data); } catch (e) {}
    return entry;
  };
})();

const audio = document.getElementById('audio');
const btnPlay = document.getElementById('btn-play');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnMode = document.getElementById('btn-mode');      // 单一播放模式按钮（右）
const btnPlaylist = document.getElementById('btn-playlist'); // 队列面板开关
const btnLike = document.getElementById('btn-like');
const seek = document.getElementById('seek');
const seekFill = document.getElementById('seek-fill');
const volume = document.getElementById('volume');
const volumeFill = document.getElementById('volume-fill');
const nowCover = document.getElementById('now-cover');
const nowTitle = document.getElementById('now-title');
const nowArtist = document.getElementById('now-artist');
const timeCur = document.getElementById('time-cur');
const timeDur = document.getElementById('time-dur');
const queuePanel = document.getElementById('queue-panel');

// ====== 平滑进度条：用 rAF 在 timeupdate 之间插值，避免每秒跳一次 ======
let _seekRAF = null;             // rAF id
let _seekLastTime = 0;           // 最近一次 timeupdate 的 audio.currentTime
let _seekLastTs = 0;             // 最近一次 timeupdate 的 performance.now()
let _seekDragging = false;       // 正在拖动 seek 条时暂停 rAF 插值

// ===== Logo 路径：与主进程 main/index.js 读取的是同一个文件（main/icon.png）
// 相对 renderer/index.html，../main/icon.png 在开发与生产打包路径下都能正确命中。
// 用作「未播放歌曲 / 曲目无封面」的兜底图。*/
const PLAYER_LOGO_PATH = '../main/icon.png';

// 播放模式：合并原来 shuffle+repeat 的所有功能
// SEQUENTIAL=顺序播放（列表结束即停止）
// LOOP=列表循环（播完最后一首回到第一首）
// SINGLE=单曲循环（单曲循环）
// SHUFFLE=随机播放
const MODES = ['SEQUENTIAL', 'LOOP', 'SINGLE', 'SHUFFLE'];
const MODE_ICONS = { SEQUENTIAL: 'list', LOOP: 'repeat', SINGLE: 'repeat-1', SHUFFLE: 'shuffle' };
const MODE_LABELS = { SEQUENTIAL: '顺序播放', LOOP: '列表循环', SINGLE: '单曲循环', SHUFFLE: '随机播放' };

const state = {
  queue: [],       // [{ id, name, artists, album, cover, durationMs, url }]
  index: -1,       // 当前曲目在队列里的下标
  isPlaying: false,
  mode: 'SEQUENTIAL', // SEQUENTIAL | LOOP | SINGLE | SHUFFLE
  // 拉取 url 的并发去重
  _urlFetching: new Set(),
  // 已喜欢的歌曲 ID 集合（用于爱心按钮的红色态）
  likedIds: new Set(),
  // VIP/无版权 toast 去重：同一首歌只提示一次
  _vipToastShown: new Set(),
  // 「下一首播放」优先队列：FIFO，不管什么播放顺序，next() 时优先消费
  nextQueue: [],
};

// ---------- 工具函数 ----------
function fmtTime(sec) {
  if (!sec || !isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ===== 本地时长格式化（独立于全局 fmtTime，避免被其他脚本覆盖导致"1/1"显示异常）=====
// 诊断日志显示 fmtTime(197.214) 返回了 "1/1" 而非 "3:17"，但所有 fmtTime 源码都正确，
// 极可能是全局 fmtTime 在运行时被某处覆盖。这里用独立函数 + 原始字符串拼接
// （不依赖 padStart/模板字符串），排除 String/Math 原型被 patch 的可能。
function _playerFmtTime(sec) {
  if (sec == null || !isFinite(sec) || sec < 0 || sec === 0) return '0:00';
  var m = Math.floor(sec / 60);
  var s = Math.floor(sec % 60);
  var ss = s < 10 ? '0' + s : '' + s;
  return m + ':' + ss;
}
// 显式暴露到 window，供 nowplaying.js / tracklist.js 复用（避免各自依赖被覆盖的全局 fmtTime）
window._playerFmtTime = _playerFmtTime;

function current() {
  return state.index >= 0 && state.index < state.queue.length ? state.queue[state.index] : null;
}

async function ensureUrl(track) {
  if (track.url) return track.url;
  if (state._urlFetching.has(track.id)) return null;
  state._urlFetching.add(track.id);
  try {
    // 用智能 URL：song_url 返回试听版时自动回退到 MV 音轨
    const res = await window.api.netease.songUrlSmart(track.id);
    if (res && res.url) {
      track.url = res.url;
      // ===== 关键修复：durationMs 赋值——绝不允许试听片段的短时长覆盖正确的元数据时长 =====
      // song_url_v1 在 VIP 曲目上会返回试听片段（freeTrialInfo.start~end，常为 30 秒），
      // 这个试听时长（30000ms）远小于真实歌曲时长（如 240000ms）。
      // 如果让它覆盖 track.durationMs，getDurationSec 会取这个短时长，底栏就显示「0:30 / 0:30」
      // 或更糟的「0:01 / 0:01」（MV 音轨 audio.duration=1 时）。
      // 策略：
      //   - 已有元数据时长（> 0）且响应时长更小 → 保留元数据，忽略试听时长
      //   - 已有元数据时长且响应时长 ≥ 已有时长 → 采用响应时长（可能是更完整的版本）
      //   - 无元数据时长 → 采用响应时长（有总比没有好），但 < 5000ms 的极小值不采用
      if (res.durationMs && res.durationMs >= 5000) {
        const existing = track.durationMs || 0;
        let decision;
        if (existing <= 0) {
          track.durationMs = res.durationMs;
          decision = 'adopt(res had none)';
        } else if (res.durationMs >= existing) {
          // 响应时长 ≥ 已有时长，采用响应（可能是完整版而非试听片段）
          track.durationMs = res.durationMs;
          decision = 'adopt(res >= existing)';
        } else {
          // 否则保留元数据时长（试听片段的短时长不覆盖真实元数据）
          decision = 'keep-existing(trial shorter)';
        }
        window.bcsLog && window.bcsLog('player.ensureUrl.durationMs', {
          id: track.id, name: track.name,
          'res.durationMs': res.durationMs, 'res.source': res.source,
          'existing(before)': existing,
          'track.durationMs(after)': track.durationMs,
          decision,
        });
      } else {
        window.bcsLog && window.bcsLog('player.ensureUrl.durationMs', {
          id: track.id, name: track.name,
          'res.durationMs': res.durationMs, 'res.source': res.source,
          'track.durationMs': track.durationMs,
          decision: 'skip(res < 5000 or missing)',
        });
      }
      track.source = res.source; // 'song' | 'mv'，便于 UI 提示
      return track.url;
    }
    return null; // VIP/无版权/MV 都没有
  } catch (err) {
    console.error('[player] 取歌曲 URL 失败:', err);
    return null;
  } finally {
    state._urlFetching.delete(track.id);
  }
}

// ---------- 播放控制 ----------
async function load(index, autoplay = true) {
  if (index < 0 || index >= state.queue.length) return;
  state.index = index;
  const track = state.queue[index];
  const url = await ensureUrl(track);
  if (!url) {
    // 跳过无版权 / VIP 曲目；同一首歌只弹一次提示，避免多次点击重复
    if (!state._vipToastShown.has(track.id)) {
      state._vipToastShown.add(track.id);
      toast(`无法播放：${track.name}（无版权或 VIP 曲目）`);
    }
    if (state.mode !== 'SINGLE' && index < state.queue.length - 1) {
      load(index + 1, autoplay);
    }
    return;
  }
  audio.src = url;
  audio.load();
  updateNowPlaying(track);
  updateMediaSession(track);
  renderQueuePanel();
  syncLikeButton(track.id);
  if (autoplay) await play();
  emit('track-changed', track);
  schedulePersist();
}

async function play() {
  try {
    await audio.play();
    state.isPlaying = true;
  } catch (err) {
    // autoplay 受限或网络问题
    console.warn('[player] play() 失败:', err);
    state.isPlaying = false;
  }
  updatePlayButton();
  updateMediaSessionPlaybackState();
  // 重新注册 actions（某些浏览器可能在播放状态变化后重置 handlers）
  registerMediaSessionActions();
}

function pause() {
  audio.pause();
  state.isPlaying = false;
  updatePlayButton();
  updateMediaSessionPlaybackState();
}

function toggle() {
  state.isPlaying ? pause() : play();
}

// 计算 SHUFFLE 模式下的随机下标（和当前 index 不同；边界情况兜底）
// 核心修复：完全防御式，任何 queue.length/state.index 组合都返回合法 index
function _shuffleIndex(direction /* 1=next, -1=prev */) {
  const n = state.queue.length;
  if (n <= 0) return -1;
  if (n === 1) return 0;
  const cur = (state.index >= 0 && state.index < n) ? state.index : -1;
  // 先不使用 while 死循环：挑一个新 index，和 cur 不一样就 OK
  let i = Math.floor(Math.random() * n);
  if (cur < 0) return i; // 当前没有曲目，任意一首都可以
  // 选中了当前曲：要么 cur+1/n 要么 cur-1+n 取模（根据 next/prev 方向）
  if (i === cur) {
    i = (direction === 1) ? (cur + 1) % n : (cur - 1 + n) % n;
    // 再给一次机会随机（因为方向相邻的概率大，用户会觉得"不随机"）
    const j = Math.floor(Math.random() * n);
    if (j !== cur) i = j;
  }
  // 最后再卡一次边界
  if (i < 0 || i >= n) i = (cur + 1) % n;
  return i;
}

function next() {
  if (!state.queue.length && !state.nextQueue.length) return;
  // 优先消费「下一首播放」队列（FIFO，不管什么播放顺序）
  if (state.nextQueue.length) {
    const t = state.nextQueue.shift();
    // 如果该曲已在主队列里，直接跳到它；否则插入到当前位置之后
    const existIdx = state.queue.findIndex(q => q.id === t.id);
    if (existIdx >= 0) {
      load(existIdx, true);
    } else {
      const insertAt = state.index >= 0 ? state.index + 1 : 0;
      state.queue.splice(insertAt, 0, t);
      load(insertAt, true);
    }
    renderQueuePanel();
    return;
  }
  if (!state.queue.length) return;
  if (state.mode === 'SHUFFLE') {
    const idx = _shuffleIndex(1);
    if (idx >= 0) load(idx, true);
    return;
  }
  // SEQUENTIAL / LOOP / SINGLE：SINGLE 被 audio.onended 单独处理（重播自己），这里视为顺序
  const nextIdx = state.index + 1 >= state.queue.length
    ? (state.mode === 'LOOP' ? 0 : -1)
    : state.index + 1;
  if (nextIdx === -1) { pause(); return; }
  load(nextIdx, true);
}

function prev() {
  if (!state.queue.length) return;
  // 播放超过 3 秒就回到本曲开头
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (state.mode === 'SHUFFLE') {
    const idx = _shuffleIndex(-1);
    if (idx >= 0) load(idx, true);
    return;
  }
  const prevIdx = state.index - 1 < 0
    ? (state.mode === 'LOOP' ? state.queue.length - 1 : -1)
    : state.index - 1;
  if (prevIdx === -1) { audio.currentTime = 0; return; }
  load(prevIdx, true);
}

function setQueue(tracks, startIndex = 0) {
  // 规范化字段：网易云的 ar/al/dt 转为我们内部统一格式
  const getMs = (t) => {
    const fn = (window.ui && window.ui.tracklist && window.ui.tracklist.getDurationMs);
    return fn ? fn(t) : (t.dt || 0);
  };
  state.queue = tracks.map(t => {
    // 保留原始 ar 数组（含 id），用于底栏/播放页/播放列表的歌手可点击跳转
    const ar = Array.isArray(t.ar) ? t.ar
      : (Array.isArray(t.artists) ? t.artists : []);
    return {
      id: t.id,
      name: t.name,
      ar,
      artists: ar.map(a => a.name).join(' / '),
      album: (t.al && t.al.name) || (t.album && t.album.name) || '',
      cover: (t.al && t.al.picUrl) || (t.album && t.album.picUrl) || t.cover || '',
      durationMs: getMs(t),
      url: t.url || null,
    };
  });
  state.index = -1;
  if (state.queue.length) load(startIndex, true);
  else resetNowPlaying(); // ===== 修复：传入空队列 / 全部清空时，底栏回到「未在播放」+ LOGO 状态
  schedulePersist();
}

// 「下一首播放」：加入优先队列（FIFO），不管什么播放顺序，next() 时必定播放
// 多次添加按添加顺序排队（先进先出）
function playNext(track) {
  if (!track) return;
  const getMs = (t) => {
    const fn = (window.ui && window.ui.tracklist && window.ui.tracklist.getDurationMs);
    return fn ? fn(t) : (t.dt || 0);
  };
  const t = {
    id: track.id,
    name: track.name,
    ar: Array.isArray(track.ar) ? track.ar
      : (Array.isArray(track.artists) ? track.artists : []),
    artists: Array.isArray(track.ar) ? track.ar.map(a => a.name).join(' / ')
      : (Array.isArray(track.artists) ? track.artists.map(a => a.name).join(' / ') : (track.artists || '')),
    album: (track.al && track.al.name) || (track.album && track.album.name) || '',
    cover: (track.al && track.al.picUrl) || (track.album && track.album.picUrl) || track.cover || '',
    durationMs: getMs(track),
    url: track.url || null,
  };
  // 如果队列为空，直接成为队列并播放
  if (!state.queue.length) {
    state.queue = [t];
    load(0, true);
    return;
  }
  // 加入优先队列，next() 时优先消费
  state.nextQueue.push(t);
  renderQueuePanel();
  toast(`已加入下一首播放：${t.name}`);
  schedulePersist();
}

// 从「下一首播放」优先队列移除指定位置曲目
function removeFromNextQueue(index) {
  if (index < 0 || index >= state.nextQueue.length) return;
  const removed = state.nextQueue.splice(index, 1)[0];
  renderQueuePanel();
  if (removed) toast(`已从下一首播放移除：${removed.name}`);
  schedulePersist();
}

// 清空「下一首播放」优先队列
function clearNextQueue() {
  if (!state.nextQueue.length) { toast('下一首播放已为空'); return; }
  state.nextQueue = [];
  renderQueuePanel();
  schedulePersist();
  toast('已清空下一首播放');
}

// 单曲播放：把一首歌作为新队列播放（用于「播放此曲」）
function playTrack(track) {
  if (!track) return;
  setQueue([track], 0);
}

// ---------- UI 同步 ----------
// 渲染可点击的歌手链接 HTML：ar 为 [{ id, name }]，无 id 时回退纯文本
function renderArtistsHtml(ar, fallbackText) {
  const list = Array.isArray(ar) ? ar.filter(a => a && a.name) : [];
  if (!list.length) {
    return `<span>${escapeHtmlLocal(fallbackText || '—')}</span>`;
  }
  // 仅含有 id 的歌手渲染为链接；无 id 的回退纯文本
  const parts = list.map(a => {
    if (a.id) {
      return `<a href="#/artist/${a.id}" class="hover:underline now-artist-link" style="color:var(--muted-foreground);" data-nav="artist" data-artist-id="${a.id}">${escapeHtmlLocal(a.name)}</a>`;
    }
    return `<span style="color:var(--muted-foreground);">${escapeHtmlLocal(a.name)}</span>`;
  });
  return parts.join('<span style="color:var(--muted-foreground);"> / </span>');
}

// 给底栏 #now-artist 注入可点击歌手，并绑定点击（阻止冒泡到封面点击）
function setNowArtistHtml(html) {
  if (!nowArtist) return;
  nowArtist.innerHTML = html;
  // 阻止点击歌手链接时冒泡触发底栏其他交互（如封面点击打开播放页）
  nowArtist.querySelectorAll('a[data-nav="artist"]').forEach(a => {
    a.addEventListener('click', (e) => { e.stopPropagation(); });
  });
}

function updateNowPlaying(track) {
  nowTitle.textContent = track.name;
  setNowArtistHtml(renderArtistsHtml(track.ar, track.artists));
  // ===== 修复：曲目有封面则显示封面图（88x88 缩略图），否则统一显示 APP LOGO
  // （原来是渐变背景，看起来"空"；现在和底栏未播放状态一致用 LOGO）*/
  const coverSrc = track.cover ? `${track.cover}?param=88x88` : PLAYER_LOGO_PATH;
  nowCover.innerHTML = `<img src="${coverSrc}" alt="封面" class="w-full h-full object-cover" onerror="this.onerror=null;this.src='${PLAYER_LOGO_PATH}';">`;
  nowCover.style.background = 'transparent';
  btnLike.disabled = false;
  // ===== 关键修复：立即用元数据时长刷新底栏时长显示 =====
  // 排序正确说明元数据 durationMs 已正确获取，这里必须立即显示，不依赖 audio.duration。
  // 之前只在 metaDur > 0 时才刷新，但如果 audio.duration=1 先到达 timeupdate 会覆盖成"0:01"。
  // 现在改为：与 getDurationSec 同步阈值——元数据 >= 5 秒才视为可信并立即显示；
  // 0~5 秒区间视为试听片段/错误值，不展示，等 audio loadedmetadata 提供真实值再刷新。
  const metaDur = (track.durationMs && track.durationMs > 0) ? track.durationMs / 1000 : 0;
  if (metaDur >= 5) {
    // 用本地 _playerFmtTime 实际显示（修复全局 fmtTime 被覆盖导致的"1/1"）
    const _durStr = _playerFmtTime(metaDur);
    timeDur.textContent = _durStr;
    timeCur.textContent = '0:00';
    seekFill.style.width = '0%';
    // 诊断：对比本地 _playerFmtTime 与全局 fmtTime，揭示"1/1"根因
    window.bcsLog && window.bcsLog('player.updateNowPlaying', {
      id: track.id, name: track.name,
      'track.durationMs': track.durationMs, metaDur,
      '_playerFmtTime.output': _durStr,
      'global fmtTime.output': fmtTime(metaDur),
      'fmtTime.src(250)': String(fmtTime).slice(0, 250),
      'textContent.afterSet': timeDur.textContent,
      decision: 'show metaDur (>=5)',
    });
  } else {
    window.bcsLog && window.bcsLog('player.updateNowPlaying', {
      id: track.id, name: track.name,
      'track.durationMs': track.durationMs, metaDur,
      decision: 'skip show (metaDur <5, wait for loadedmetadata)',
    });
  }
}

// ===== 新增：重置底栏到「未在播放」空状态（显示 LOGO、清除歌名/时长）
// 当播放队列为空、或者首次启动还没播放任何歌曲时调用。*/
function resetNowPlaying() {
  // 封面：显示 LOGO 兜底图
  nowCover.innerHTML = `<img src="${PLAYER_LOGO_PATH}" alt="未在播放" class="w-full h-full object-cover" onerror="this.onerror=null;this.style.background='linear-gradient(135deg,var(--brand-300),var(--brand-500))';">`;
  nowCover.style.background = 'transparent';
  // 标题/歌手：初始空状态文案（与 HTML 初始值保持一致）
  nowTitle.textContent = '未在播放';
  nowArtist.textContent = '—';
  // 进度/时长清零
  timeCur.textContent = '0:00';
  timeDur.textContent = '0:00';
  seekFill.style.width = '0%';
  // 喜欢按钮：禁用灰态（没歌曲在播放就不能点喜欢）
  btnLike.disabled = true;
  btnLike.style.color = 'var(--muted-foreground)';
  // 播放按钮恢复"播放"图标
  state.isPlaying = false;
  updatePlayButton();
}

function updatePlayButton() {
  const icon = state.isPlaying ? 'pause' : 'play';
  btnPlay.innerHTML = `<i data-lucide="${icon}" class="w-5 h-5" style="color:var(--primary-foreground);"></i>`;
  if (window.lucide) lucide.createIcons();
}

function updateModeButton() {
  const icon = MODE_ICONS[state.mode] || 'list';
  // 当前模式（除顺序播放外）以主色高亮
  const active = state.mode !== 'SEQUENTIAL';
  btnMode.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4" style="color:${active ? 'var(--primary)' : 'var(--muted-foreground)'};"></i>`;
  btnMode.title = MODE_LABELS[state.mode];
  if (window.lucide) lucide.createIcons();
}

// ---------- 喜欢按钮（底栏 + 播放页）同步 ----------
// 同步爱心按钮的红色态：底栏 btnLike 和播放页 np-like 都更新
function syncLikeButton(trackId) {
  const liked = state.likedIds.has(String(trackId));
  // 底栏
  if (btnLike) {
    btnLike.dataset.liked = liked ? 'true' : 'false';
    btnLike.innerHTML = `<i data-lucide="heart" class="w-4 h-4"></i>`;
    if (window.lucide) lucide.createIcons();
    // 用 CSS 类切换填充态
    btnLike.classList.toggle('is-liked', liked);
  }
  // 播放页
  const npLike = document.getElementById('np-like');
  if (npLike) {
    npLike.dataset.liked = liked ? 'true' : 'false';
    npLike.classList.toggle('is-liked', liked);
    // 重置图标，让 lucide 重建
    npLike.innerHTML = `<i data-lucide="heart" class="w-5 h-5"></i>`;
    if (window.lucide) lucide.createIcons();
  }
}

// 加载用户「喜欢的歌曲」ID 列表，缓存到 state.likedIds
async function loadLikelist() {
  try {
    const session = await window.api.netease.getSession();
    if (!session.userId) return;
    const ids = await window.api.netease.likelist(session.userId) || [];
    state.likedIds = new Set(ids.map(String));
    // 当前曲已加载则同步按钮
    const cur = current();
    if (cur) syncLikeButton(cur.id);
  } catch (err) {
    console.warn('[player] 加载喜欢列表失败:', err);
  }
}

// 切换当前曲的红心：调用 like 接口，更新本地缓存，刷新按钮态
async function toggleLikeCurrent() {
  const track = current();
  if (!track) return;
  const id = String(track.id);
  const willLike = !state.likedIds.has(id);
  try {
    await window.api.netease.like(track.id, willLike);
    if (willLike) {
      state.likedIds.add(id);
      window.toast('已添加到我喜欢的音乐');
    } else {
      state.likedIds.delete(id);
      window.toast('已从我喜欢的音乐移除');
    }
    syncLikeButton(track.id);
  } catch (err) {
    window.toast('操作失败：' + (err.message || '请稍后重试'));
  }
}

// ---------- 播放列表面板渲染 ----------
function renderQueuePanel() {
  // 「下一首播放」优先队列区块：仅在有曲目时显示
  const nextSection = queuePanel.querySelector('.queue-next-section');
  if (nextSection) {
    if (state.nextQueue.length) {
      nextSection.classList.remove('hidden');
      const nextCount = nextSection.querySelector('.queue-next-count');
      if (nextCount) nextCount.textContent = state.nextQueue.length;
      const nextList = nextSection.querySelector('.queue-next-list');
      const nextItems = state.nextQueue.map((t, i) => `
        <div class="queue-next-item flex items-center gap-2 h-10 px-2 rounded-lg cursor-pointer" data-index="${i}">
          <span class="text-xs w-5 text-center flex items-center justify-center" style="color:var(--primary);"><i data-lucide="skip-forward" class="w-3 h-3"></i></span>
          <div class="w-7 h-7 rounded overflow-hidden flex-shrink-0 ${t.cover ? '' : 'skeleton'}">
            ${t.cover ? `<img src="${t.cover}?param=56x56" alt="" class="w-full h-full object-cover">` : ''}
          </div>
          <div class="flex-1 min-w-0 flex flex-col">
            <span class="text-xs truncate" style="color:var(--foreground);">${escapeHtmlLocal(t.name)}</span>
            <div class="text-[10px] truncate" style="color:var(--muted-foreground);">${renderArtistsHtml(t.ar, t.artists)}</div>
          </div>
          <span class="text-[10px]" style="color:var(--muted-foreground);">${_playerFmtTime(t.durationMs / 1000)}</span>
        </div>
      `).join('');
      nextList.innerHTML = nextItems;
      // 阻止点击歌手链接时冒泡触发行点击
      nextList.querySelectorAll('a[data-nav="artist"]').forEach(a => {
        a.addEventListener('click', (e) => { e.stopPropagation(); });
      });
      nextList.querySelectorAll('.queue-next-item').forEach(el => {
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const idx = parseInt(el.dataset.index, 10);
          if (isNaN(idx)) return;
          if (window.ui && window.ui.contextMenu && window.ui.contextMenu.show) {
            window.ui.contextMenu.show(e.clientX, e.clientY, [
              { type: 'item', label: '删除', icon: 'trash-2', danger: true, onClick: () => removeFromNextQueue(idx) },
            ]);
          }
        });
      });
    } else {
      nextSection.classList.add('hidden');
      const nextList = nextSection.querySelector('.queue-next-list');
      if (nextList) nextList.innerHTML = '';
    }
  }

  if (!state.queue.length) {
    queuePanel.querySelector('.queue-list').innerHTML =
      `<div class="p-6 text-center text-sm" style="color:var(--muted-foreground);">播放队列为空</div>`;
    queuePanel.querySelector('.queue-count').textContent = '0';
    if (window.lucide) lucide.createIcons();
    return;
  }
  queuePanel.querySelector('.queue-count').textContent = state.queue.length;
  const items = state.queue.map((t, i) => {
    const isCurrent = i === state.index;
    return `
      <div class="queue-item flex items-center gap-2 h-10 px-2 rounded-lg cursor-pointer ${isCurrent ? 'is-current' : ''}" data-index="${i}">
        <span class="text-xs w-5 text-center" style="color:var(--muted-foreground);">${isCurrent ? `<i data-lucide="volume-2" class="w-3 h-3" style="color:var(--primary);"></i>` : (i + 1)}</span>
        <div class="w-7 h-7 rounded overflow-hidden flex-shrink-0 ${t.cover ? '' : 'skeleton'}">
          ${t.cover ? `<img src="${t.cover}?param=56x56" alt="" class="w-full h-full object-cover">` : ''}
        </div>
        <div class="flex-1 min-w-0 flex flex-col">
          <span class="text-xs truncate" style="color:${isCurrent ? 'var(--primary)' : 'var(--foreground)'};">${escapeHtmlLocal(t.name)}</span>
          <div class="text-[10px] truncate" style="color:var(--muted-foreground);">${renderArtistsHtml(t.ar, t.artists)}</div>
        </div>
        <span class="text-[10px]" style="color:var(--muted-foreground);">${_playerFmtTime(t.durationMs / 1000)}</span>
      </div>
    `;
  }).join('');
  const listEl = queuePanel.querySelector('.queue-list');
  listEl.innerHTML = items;
  // 阻止点击歌手链接时冒泡触发行点击（行点击会切歌）
  listEl.querySelectorAll('a[data-nav="artist"]').forEach(a => {
    a.addEventListener('click', (e) => { e.stopPropagation(); });
  });
  listEl.querySelectorAll('.queue-item').forEach(el => {
    el.addEventListener('dblclick', () => {
      const idx = parseInt(el.dataset.index, 10);
      if (!isNaN(idx)) load(idx, true);
    });
    // 右键菜单：下一首播放 / 从播放列表中删除
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = parseInt(el.dataset.index, 10);
      if (isNaN(idx)) return;
      const track = state.queue[idx];
      if (!track) return;
      if (window.ui && window.ui.contextMenu && window.ui.contextMenu.show) {
        window.ui.contextMenu.show(e.clientX, e.clientY, [
          {
            type: 'item', label: '下一首播放', icon: 'skip-forward',
            onClick: () => {
              // 从队列中移除当前项，然后加入 nextQueue
              state.queue.splice(idx, 1);
              if (idx < state.index) state.index--;
              playNext(track);
              renderQueuePanel();
            },
          },
          { type: 'sep' },
          {
            type: 'item', label: '从播放列表中删除', icon: 'trash-2', danger: true,
            onClick: () => {
              state.queue.splice(idx, 1);
              // 如果删除的是当前曲，跳到下一首
              if (idx === state.index) {
                if (state.queue.length) {
                  load(Math.min(idx, state.queue.length - 1), true);
                } else {
                  state.index = -1;
                  audio.pause();
                  audio.src = '';
                }
              } else if (idx < state.index) {
                state.index--;
              }
              renderQueuePanel();
              window.toast('已从播放列表中删除');
            },
          },
        ]);
      }
    });
  });
  if (window.lucide) lucide.createIcons();
}

function escapeHtmlLocal(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// ---------- 原生 SMTC 桥（Windows，替代 Chromium 的 MediaSession→SMTC） ----------
// 关键：不再走 navigator.mediaSession（Chromium 会把封面下采样到约 150×150），
//       而是通过 IPC 把数据传给主进程 spawn 的 Rust 子进程（bcs-smtc.exe），
//       由它直接调 Windows.SystemMediaTransportControls，封面尺寸无上限。
//   - smtc.setMetadata      → SMTC 显示的标题/歌手/专辑/封面
//   - smtc.setPosition      → SMTC 显示的时长 + 当前进度条
//   - smtc.setPlayback      → SMTC 播放/暂停按钮状态
//   - 按钮回调走 media:action 通道（见文件末尾 onMediaAction），与全局快捷键共用
function updateMediaSession(track) {
  if (!window.api || !window.api.smtc) return;
  try {
    // 去掉网易云封面 URL 上的 ?param=xx 限制，让主进程下载原图（高清封面）传给 Rust
    let coverUrl = track.cover || '';
    if (coverUrl) coverUrl = coverUrl.split('?')[0];
    window.api.smtc.setMetadata({
      title: track.name || '',
      artist: track.artists || '',
      album: track.album || '',
      coverUrl: coverUrl || null,
    });
  } catch (err) {
    console.warn('[player] 设置 SMTC metadata 失败:', err);
  }
  setMediaSessionPositionState((track.durationMs || 0) / 1000);
}

function setMediaSessionPositionState(durationSec) {
  if (!window.api || !window.api.smtc) return;
  const dur = isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const cur = audio.currentTime || 0;
  const pos = Math.floor(Math.min(cur, dur || cur) * 1000);
  try {
    window.api.smtc.setPosition(Math.floor(dur * 1000), pos);
  } catch (err) {
    // 子进程不可用时静默
  }
}

function updateMediaSessionPlaybackState() {
  if (!window.api || !window.api.smtc) return;
  try { window.api.smtc.setPlayback(state.isPlaying ? 'playing' : 'paused'); }
  catch (err) { /* 子进程不可用时静默 */ }
}

// ---------- 播放状态持久化（队列/曲目/模式/位置）----------
// 关键：网易云歌曲 URL 会过期，所以保存时不带 url，恢复时由 ensureUrl 重新拉取。
//   - 结构变化（切歌/加歌/清空/换模式）：防抖 1.2s 后保存
//   - 播放中：每 15s 保存一次位置（退出后位置最多差 15s）
//   - 暂停/换歌：立即保存（捕获最后位置）
let _persistTimer = null;
let _positionSaveTimer = null;
function _stripUrl(t) { const r = { ...t }; r.url = null; return r; }
function _getPlayerStateSnapshot() {
  return {
    queue: state.queue.map(_stripUrl),
    index: state.index,
    mode: state.mode,
    nextQueue: state.nextQueue.map(_stripUrl),
    position: audio.currentTime || 0,
    savedAt: Date.now(),
  };
}
function persistPlayerState() {
  if (!window.api || !window.api.player) return;
  try { window.api.player.saveState(_getPlayerStateSnapshot()); }
  catch (err) { console.warn('[player] 保存播放状态失败:', err); }
}
// 防抖保存：结构变化时合并写入，避免高频 IO
function schedulePersist() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => { _persistTimer = null; persistPlayerState(); }, 1200);
}

// ---------- 恢复上次的播放状态 ----------
async function restorePlayerState() {
  if (!window.api || !window.api.player) return false;
  let saved;
  try { saved = await window.api.player.loadState(); }
  catch (err) { console.warn('[player] 读取播放状态失败:', err); return false; }
  if (!saved || !Array.isArray(saved.queue) || !saved.queue.length) return false;

  // 恢复播放模式
  if (saved.mode && MODES.includes(saved.mode)) {
    state.mode = saved.mode;
    updateModeButton();
  }
  // 恢复队列与索引（直接赋值，不走 setQueue 规范化，因为保存的已是规范化数据）
  state.queue = saved.queue.map(_stripUrl);
  state.nextQueue = Array.isArray(saved.nextQueue) ? saved.nextQueue.map(_stripUrl) : [];
  const idx = (typeof saved.index === 'number' && saved.index >= 0 && saved.index < state.queue.length)
    ? saved.index : 0;
  state.index = idx;

  const track = state.queue[idx];
  if (!track) return false;

  // 拉取 URL（可能已过期）→ 加载但不自动播放（让用户主动点播放）
  const url = await ensureUrl(track);
  if (!url) {
    // URL 拉取失败（VIP/无版权）：仍渲染队列，但不加载音频
    renderQueuePanel();
    syncLikeButton(track.id);
    return false;
  }
  audio.src = url;
  audio.load();
  updateNowPlaying(track);
  updateMediaSession(track);
  renderQueuePanel();
  syncLikeButton(track.id);
  // 通知 SMTC：已暂停（不自动播放）
  try { window.api.smtc && window.api.smtc.setPlayback('paused'); } catch {}

  // 恢复播放位置（需等 loadedmetadata 后才能 seek）
  const pos = (typeof saved.position === 'number' && saved.position > 0) ? saved.position : 0;
  const durSec = (track.durationMs || 0) / 1000;
  if (pos > 0 && (!durSec || pos < durSec)) {
    const seekOnce = () => {
      try { if (isFinite(audio.duration) && pos < audio.duration) audio.currentTime = pos; } catch {}
    };
    if (audio.readyState >= 1) seekOnce();
    else audio.addEventListener('loadedmetadata', seekOnce, { once: true });
  }
  emit('track-changed', track);
  console.log('[player] 已恢复上次播放状态:', track.name, '@', Math.floor(pos), 's');
  return true;
}

// 兼容空函数：原 SMTC 按钮回调通过 navigator.mediaSession.setActionHandler 注册，
// 现在改走主进程的 media:action 通道（见文件末尾 onMediaAction），这里保留空实现避免改调用点
function registerMediaSessionActions() {}

// ---------- 事件总线（视图订阅 track-changed） ----------
const listeners = new Map();
function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}
function emit(evt, payload) {
  const fns = listeners.get(evt);
  if (fns) fns.forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } });
}

// ---------- audio 元素事件 ----------
// 获取有效时长（** 这是"时长显示 1/1"的最后防线 **）：
//   - 权威值：元数据 durationMs（由 tracklist.getDurationMs 解析自原始接口），单位毫秒。
//   - 排序正确 = 元数据 durationMs 已正确获取（tracklist.getDurationMs 工作正常）。
//   - 显示"1/1"的根因：track.durationMs 被试听片段/MV 的短时长覆盖，或 audio.duration=1 被误用。
//   - 修复策略：元数据 >= 5 秒就视为权威值，绝不退化到 audio.duration=1 这种垃圾值。
function getDurationSec() {
  const track = current();
  const metaDur = track && track.durationMs ? track.durationMs / 1000 : 0;
  const ad = audio.duration;
  const adValid = ad && isFinite(ad) && ad > 5; // >5 秒才算真正有效（MV=1/流媒体=1 都判无效）
  let chosen, reason;
  // ===== 1) 元数据 >= 5 秒 → 视为权威值，优先采用 =====
  // 排序正确说明元数据已正确获取，这里必须信任它，不被 audio.duration=1 干扰
  if (metaDur >= 5) {
    if (!adValid || ad <= metaDur + 2) { chosen = metaDur; reason = 'meta>=5(no ad or ad<=meta+2)'; }
    else { chosen = ad; reason = 'audio longer(MV full track)'; }
  } else if (metaDur > 0 && metaDur < 5) {
    // ===== 2) 元数据 0~5 秒（极可能是试听片段/错误值/1ms 假时长）→ 视为不可信 =====
    if (adValid && ad > metaDur) { chosen = ad; reason = 'meta<5 untrusted, use ad'; }
    else { chosen = 0; reason = 'meta<5 untrusted + no valid ad -> 0'; }
  } else if (adValid) {
    // ===== 3) 无元数据，audio 有效就用 audio（MV 音轨必须靠这个）=====
    chosen = ad; reason = 'no meta, use ad';
  } else {
    // ===== 4) 最终兜底：audio.duration === 1 这种垃圾值不允许当 1s 展示给用户造成"1/1"。
    chosen = 0; reason = 'no trustworthy value -> 0';
  }
  // 调试打点：仅在返回值变化或可疑 (<5s) 时记录，避免 timeupdate 高频刷屏
  if (window.bcsLog) {
    const suspicious = (chosen > 0 && chosen < 5);
    window.bcsLog('player.getDurationSec', {
      id: track && track.id, name: track && track.name,
      'track.durationMs': track && track.durationMs, metaDur,
      'audio.duration': ad, adValid,
      chosen, reason, suspicious,
    }, { dedupe: true });
  }
  return chosen;
}

audio.addEventListener('loadedmetadata', () => {
  // ===== 当 audio loadedmetadata 拿到有效值，立刻**回写**到 track.durationMs
  // 上（更新权威元数据），保证后续 timeupdate 不会再回落到错误的短时长。
  // 策略：audio.duration > 5 秒才回写（MV=1/流媒体=1 这种垃圾值绝不回写，
  // 否则会把正确的元数据时长覆盖成 1000ms 导致显示"0:01 / 0:01"）。
  const track = current();
  const ad = audio.duration;
  let writeBack = false;
  if (track && ad && isFinite(ad) && ad > 5) {
    const adMs = Math.round(ad * 1000);
    const existing = track.durationMs || 0;
    // 只有 audio 时长 > 已有元数据时才回写（audio 是更完整的版本，如 MV 完整音轨）
    if (existing <= 0 || adMs > existing) {
      track.durationMs = adMs;
      writeBack = true;
    }
  }
  const dur = getDurationSec();
  if (dur > 0) {
    timeDur.textContent = _playerFmtTime(dur);
    if (track) setMediaSessionPositionState(dur);
  }
  window.bcsLog && window.bcsLog('player.audio.loadedmetadata', {
    id: track && track.id, name: track && track.name,
    'audio.duration': ad, isFinite: isFinite(ad),
    'track.durationMs(before)': track && (track.durationMs),
    writeBack,
    'dur(getDurationSec)': dur,
    'displayed timeDur': timeDur.textContent,
  });
});

// ====== 平滑进度条 rAF 循环：在 timeupdate 之间用 performance.now 插值 ======
function startSeekRAF() {
  if (_seekRAF) return;
  const tick = () => {
    if (_seekDragging) { _seekRAF = requestAnimationFrame(tick); return; }
    const dur = getDurationSec();
    if (dur > 0 && !audio.paused) {
      const now = performance.now();
      const elapsed = (now - _seekLastTs) / 1000;
      const interp = _seekLastTime + elapsed * (audio.playbackRate || 1);
      const cur = Math.min(interp, dur);
      seekFill.style.width = `${Math.min(100, (cur / dur) * 100)}%`;
      // 时间文字只在秒变化时更新，避免频繁 reflow
      const sec = Math.floor(cur);
      if (timeCur.dataset.sec !== String(sec)) {
        timeCur.dataset.sec = String(sec);
        timeCur.textContent = _playerFmtTime(cur);
      }
    }
    _seekRAF = requestAnimationFrame(tick);
  };
  _seekRAF = requestAnimationFrame(tick);
}
function stopSeekRAF() {
  if (_seekRAF) { cancelAnimationFrame(_seekRAF); _seekRAF = null; }
}

audio.addEventListener('timeupdate', () => {
  const cur = audio.currentTime || 0;
  const dur = getDurationSec();
  _seekLastTime = cur;
  _seekLastTs = performance.now();
  // 用本地 _playerFmtTime 实际显示（修复全局 fmtTime 被覆盖导致的"1/1"）
  const _curStr = _playerFmtTime(cur);
  const _durStr = dur > 0 ? _playerFmtTime(dur) : '';
  timeCur.textContent = _curStr;
  timeCur.dataset.sec = String(Math.floor(cur));
  if (dur > 0) {
    timeDur.textContent = _durStr;
    if (!_seekDragging) seekFill.style.width = `${Math.min(100, (cur / dur) * 100)}%`;
  }
  if (dur > 0) setMediaSessionPositionState(dur);
  // 播放中启动 rAF 插值；暂停时停止
  if (!audio.paused) startSeekRAF(); else stopSeekRAF();
  // 诊断：对比本地 _playerFmtTime 与全局 fmtTime，揭示"1/1"根因（仅在变化时记录）
  if (window.bcsLog) {
    const shown = `${timeCur.textContent}/${timeDur.textContent}`;
    const suspicious = dur > 0 && dur < 5;
    window.bcsLog('player.audio.timeupdate', {
      cur, dur,
      '_playerFmtTime(cur)': _curStr,
      '_playerFmtTime(dur)': _durStr,
      'global fmtTime(cur)': fmtTime(cur),
      'global fmtTime(dur)': dur > 0 ? fmtTime(dur) : '',
      'fmtTime.src(250)': String(fmtTime).slice(0, 250),
      'displayed': shown, suspicious,
    }, { dedupe: true });
  }
});

audio.addEventListener('loadedmetadata', () => {
  // audio.duration 可能返回 1 或 Infinity（MV 音轨/流媒体），用 getDurationSec 兜底
  const dur = getDurationSec();
  if (dur > 0) {
    timeDur.textContent = _playerFmtTime(dur);
    const track = current();
    if (track) setMediaSessionPositionState(dur);
  }
});

audio.addEventListener('durationchange', () => {
  // 部分音频流会在播放中才确定时长，这里再刷新一次
  const dur = getDurationSec();
  if (dur > 0) timeDur.textContent = _playerFmtTime(dur);
});

audio.addEventListener('ended', () => {
  if (state.mode === 'SINGLE') {
    audio.currentTime = 0;
    play();
    return;
  }
  next();
});

audio.addEventListener('play', () => {
  state.isPlaying = true;
  updatePlayButton();
  updateMediaSessionPlaybackState();
  registerMediaSessionActions(); // 确保 SMTC actions 在播放时可用
  startSeekRAF();
  // 播放中每 15s 保存一次位置（退出后位置最多差 15s）
  if (_positionSaveTimer) clearInterval(_positionSaveTimer);
  _positionSaveTimer = setInterval(persistPlayerState, 15000);
  // 听歌打卡：异步上报到网易云 /api/feedback/weblog，让最近播放与网易云同步
  // 失败静默忽略，不能影响播放
  const track = current();
  if (track && window.api && window.api.netease && window.api.netease.scrobble) {
    window.api.netease.scrobble(track.id, track.id, Date.now()).catch(() => {});
  }
});

audio.addEventListener('pause', () => {
  state.isPlaying = false;
  updatePlayButton();
  updateMediaSessionPlaybackState();
  stopSeekRAF();
  // 暂停时立即保存（捕获最后位置）+ 停止周期保存
  if (_positionSaveTimer) { clearInterval(_positionSaveTimer); _positionSaveTimer = null; }
  persistPlayerState();
});

audio.addEventListener('error', (e) => {
  console.error('[player] audio error:', e, audio.error);
  // 跳过当前曲目，尝试下一首（单曲循环下也跳过，避免死循环）
  if (state.mode !== 'SINGLE' && state.index < state.queue.length - 1) {
    setTimeout(() => next(), 800);
  }
});

// ---------- 控件事件 ----------
btnPlay.addEventListener('click', toggle);
btnPrev.addEventListener('click', prev);
btnNext.addEventListener('click', next);

// 播放模式切换：顺序 → 列表循环 → 单曲循环 → 随机 → 顺序
btnMode.addEventListener('click', () => {
  const i = MODES.indexOf(state.mode);
  state.mode = MODES[(i + 1) % MODES.length];
  updateModeButton();
  toast(MODE_LABELS[state.mode]);
  schedulePersist();
});

// 喜欢按钮：底栏
btnLike.addEventListener('click', (e) => {
  e.stopPropagation();
  if (btnLike.disabled) return;
  toggleLikeCurrent();
});

// 播放列表面板开关：上滚出/下滚出（与搜索下拉风格一致）
function openQueuePanel() {
  if (!queuePanel.classList.contains('hidden')) return;
  queuePanel.classList.remove('hidden', 'closing');
  queuePanel.classList.add('opening');
  renderQueuePanel();
  const mult = window.animMult ? window.animMult() : 1;
  setTimeout(() => queuePanel.classList.remove('opening'), Math.round(200 * mult));
}
function closeQueuePanel() {
  if (queuePanel.classList.contains('hidden')) return;
  queuePanel.classList.remove('opening');
  queuePanel.classList.add('closing');
  const mult = window.animMult ? window.animMult() : 1;
  setTimeout(() => {
    queuePanel.classList.add('hidden');
    queuePanel.classList.remove('closing');
  }, Math.round(160 * mult));
}
btnPlaylist.addEventListener('click', (e) => {
  e.stopPropagation();
  if (queuePanel.classList.contains('hidden')) openQueuePanel();
  else closeQueuePanel();
});

// 清空播放列表
const queueClearBtn = document.getElementById('queue-clear');
if (queueClearBtn) {
  queueClearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.queue.length) { toast('播放列表已为空'); return; }
    // 清空队列、停止播放、重置 UI
    state.queue = [];
    state.index = -1;
    state.isPlaying = false;
    audio.pause();
    audio.src = '';
    audio.load();
    nowTitle.textContent = '未在播放';
    nowArtist.textContent = '—';
    nowCover.innerHTML = '';
    nowCover.style.background = 'linear-gradient(135deg, var(--brand-300), var(--brand-500))';
    btnLike.disabled = true;
    updatePlayButton();
    renderQueuePanel();
    // 通知 SMTC 关闭：无歌曲时隐藏 SMTC 条目
    try { window.api && window.api.smtc && window.api.smtc.setPlayback('closed'); } catch {}
    // 保存空状态（覆盖上次播放列表，下次启动不恢复）
    persistPlayerState();
    toast('已清空播放列表');
  });
}

// 清空「下一首播放」优先队列
const queueNextClearBtn = document.getElementById('queue-next-clear');
if (queueNextClearBtn) {
  queueNextClearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearNextQueue();
  });
}

// 点击面板外关闭（np-playlist 是 now-playing 内的播放列表按钮，也需排除）
document.addEventListener('click', (e) => {
  if (queuePanel.classList.contains('hidden')) return;
  if (queuePanel.contains(e.target)) return;
  if (btnPlaylist.contains(e.target)) return;
  const npPlaylistBtn = document.getElementById('np-playlist');
  if (npPlaylistBtn && npPlaylistBtn.contains(e.target)) return;
  closeQueuePanel();
});

// 主进程通过 IPC 触发的全局媒体快捷键
if (window.api && window.api.onMediaAction) {
  window.api.onMediaAction((action) => {
    switch (action) {
      case 'play-pause': toggle(); break;
      case 'play': play(); break;
      case 'pause': pause(); break;
      case 'prev': prev(); break;
      case 'next': next(); break;
      case 'vol-up':
        audio.volume = Math.min(1, audio.volume + 0.05);
        volumeFill.style.width = `${audio.volume * 100}%`;
        break;
      case 'vol-down':
        audio.volume = Math.max(0, audio.volume - 0.05);
        volumeFill.style.width = `${audio.volume * 100}%`;
        break;
    }
  });
}

// 进度条点击 seek
function attachSeekBar(barEl, getVal) {
  let dragging = false;
  const onPos = (clientX) => {
    const rect = barEl.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    getVal(pct);
  };
  barEl.addEventListener('mousedown', (e) => {
    dragging = true;
    _seekDragging = true;
    onPos(e.clientX);
  });
  document.addEventListener('mousemove', (e) => { if (dragging) onPos(e.clientX); });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; _seekDragging = false; }
  });
}

attachSeekBar(seek, (pct) => {
  const dur = getDurationSec();
  if (dur) {
    audio.currentTime = pct * dur;
    seekFill.style.width = `${pct * 100}%`;
  }
});

attachSeekBar(volume, (pct) => {
  audio.volume = pct;
  volumeFill.style.width = `${pct * 100}%`;
});
audio.volume = 0.7;
volumeFill.style.width = '70%';

// ---------- 全局快捷键 ----------
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.code === 'ArrowRight' && e.shiftKey) { e.preventDefault(); next(); }
  else if (e.code === 'ArrowLeft' && e.shiftKey) { e.preventDefault(); prev(); }
  else if (e.code === 'ArrowUp') { e.preventDefault(); audio.volume = Math.min(1, audio.volume + 0.05); volumeFill.style.width = `${audio.volume * 100}%`; }
  else if (e.code === 'ArrowDown') { e.preventDefault(); audio.volume = Math.max(0, audio.volume - 0.05); volumeFill.style.width = `${audio.volume * 100}%`; }
});

// ---------- 简易 toast（其他模块也用得到，挂到 window） ----------
// 同一时间只保留一条 toast：新调用会立刻撤掉上一条
let _currentToast = null;
let _currentToastTimer = null;
window.toast = function toast(msg, durationMs = 1800) {
  // 立刻清掉上一条
  if (_currentToastTimer) { clearTimeout(_currentToastTimer); _currentToastTimer = null; }
  if (_currentToast) { _currentToast.remove(); _currentToast = null; }
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  _currentToast = t;
  _currentToastTimer = setTimeout(() => {
    if (t === _currentToast) _currentToast = null;
    t.remove();
    _currentToastTimer = null;
  }, durationMs);
};

// ---------- 初始化 ----------
registerMediaSessionActions();
updatePlayButton();
updateModeButton();
// ===== 修复：首次启动时立刻将底栏设置为"未在播放"+LOGO 状态
// （原代码 HTML 初始值虽有"未在播放"文案，但封面是渐变背景而不是 LOGO）*/
resetNowPlaying();
// 启动后异步加载喜欢列表
setTimeout(loadLikelist, 800);
// 异步恢复上次的播放状态（队列/曲目/模式/位置，不自动播放）
restorePlayerState().catch(err => console.warn('[player] 恢复状态失败:', err));

// 退出前最后保存一次（捕获播放中的最终位置）
window.addEventListener('beforeunload', () => {
  try { persistPlayerState(); } catch {}
});

// 导出 API 供 app.js / views 调用
window.player = {
  state,
  setQueue,
  play, pause, toggle, next, prev,
  playNext, playTrack,
  removeFromNextQueue, clearNextQueue,
  current: () => current(),
  on, emit,
  audio,
  renderQueuePanel,
  openQueuePanel,
  closeQueuePanel,
  loadLikelist,
  toggleLikeCurrent,
  syncLikeButton,
  resetNowPlaying, // 暴露给外部（例如清空播放队列时调用）
  // ===== 将 LOGO 路径暴露出去，nowplaying.js 复用同一个常量（避免多处写死路径）
  LOGO_PATH: PLAYER_LOGO_PATH,
  // 暴露给 nowplaying.js / 底栏 / 播放列表共用的工具
  getDurationSec,
  renderArtistsHtml,
};
