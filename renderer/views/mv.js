// MV 播放页：路由 #/mv/:id
// 主体为 video 播放器（圆角容器），支持：进度拖动、倍速切换、暂停/播放、全屏、上一个返回
// 顶部：MV 标题 + 歌手 + 播放量，右上返回/全屏按钮
// 底部：控制栏（播放/暂停、上一首/下一首无意义 → 只有进度+倍速+音量+全屏）
// 模块级状态（renderMvPage / bindAll 都需要访问，不能放在 mountMv 局部作用域）
let curRate = 1.0;         // 播放倍速
let ratePopupOpen = false; // 倍速菜单展开

async function mountMv(container, params) {
  const api = window.api;
  const ui = window.ui.tracklist;
  const id = params && params.id;
  if (!id) {
    container.innerHTML = ui.renderEmpty({ icon: 'video-off', title: '缺少 MV ID' });
    return;
  }

  // 每次进入重置倍速
  curRate = 1.0;
  ratePopupOpen = false;

  // 加载 MV 详情 + 视频地址 + 渲染骨架
  container.innerHTML = renderMvSkeleton();
  refreshIcons();

  try {
    // 并行拉详情和地址
    const [detail, urlBody] = await Promise.all([
      api.netease.mvDetail(id),
      api.netease.mvUrl(id, 1080),
    ]);
    mvInfo = detail && (detail.data || detail);
    urlRes = urlBody && urlBody.data;
    if (!mvInfo || !urlRes || !urlRes.url) {
      // 没有权限 / 无播放地址
      let why = '该 MV 暂不可播放';
      if (urlBody && urlBody.code && urlBody.code !== 200) why += `（code=${urlBody.code}）`;
      container.innerHTML = ui.renderEmpty({
        icon: 'video-off',
        title: mvInfo && mvInfo.name ? escapeHtml(mvInfo.name) : '无法播放',
        hint: why,
        action: { text: '返回上一页', onClick: () => window.history.back() },
      });
      refreshIcons();
      return;
    }
    // 渲染正式内容
    container.innerHTML = renderMvPage(mvInfo, urlRes.url);
    bindAll(container);
    refreshIcons();
  } catch (err) {
    container.innerHTML = ui.renderError(err.message);
  }
}

// ========== 骨架屏 ==========
function renderMvSkeleton() {
  return `
    <section class="px-8 py-6">
      <div class="skeleton h-6 w-64 rounded"></div>
      <div class="skeleton h-4 w-40 rounded mt-2"></div>
    </section>
    <section class="px-8 pb-8">
      <div class="aspect-video w-full rounded-xl skeleton" style="max-width:1200px;"></div>
      <div class="mt-6 skeleton h-5 w-32 rounded"></div>
    </section>
  `;
}

// ========== 主渲染 ==========
function renderMvPage(info, videoUrl) {
  const name = info.name || 'MV';
  const artists = Array.isArray(info.artists) ? info.artists : [];
  const artistText = artists.map(a => a.name).filter(Boolean).join(' / ') || (info.artistName || '');
  const playCount = info.playCount != null ? formatCount(info.playCount) : '';
  const cover = info.cover || info.imgurl || info.coverUrl || '';
  const durationMs = info.duration || 0;
  const desc = info.desc || '';

  return `
    <!-- MV 标题栏：返回按钮 + 标题/歌手 -->
    <section class="px-8 pt-6 pb-3 flex items-start justify-between gap-6">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-3">
          <button id="mv-back" class="p-2 rounded-full hover:bg-black/5 transition-colors shrink-0" aria-label="返回" title="返回">
            <i data-lucide="arrow-left" class="w-5 h-5" style="color:var(--foreground);"></i>
          </button>
          <div class="min-w-0">
            <h1 class="text-2xl font-semibold tracking-tight truncate" style="color:var(--foreground);">${escapeHtml(name)}</h1>
            <div class="text-sm mt-1 flex items-center gap-3" style="color:var(--muted-foreground);">
              <span>${escapeHtml(artistText || '—')}</span>
              ${playCount ? `<span class="flex items-center gap-1"><i data-lucide="play-circle" class="w-3.5 h-3.5"></i>${playCount} 次播放</span>` : ''}
              ${durationMs ? `<span class="flex items-center gap-1"><i data-lucide="clock" class="w-3.5 h-3.5"></i>${fmtMs(durationMs)}</span>` : ''}
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- MV 播放器主体 -->
    <section class="px-8 pb-10">
      <div class="mx-auto mv-player-wrap" style="max-width:1200px;">
        <!-- 圆角视频容器：relative 作为绝对定位控件的父上下文 -->
        <div class="mv-player relative overflow-hidden" style="border-radius:20px; aspect-ratio:16/9; background:#000;">
          <!-- 视频元素 -->
          <video id="mv-video" class="mv-video" preload="metadata" playsinline crossorigin="anonymous"
                 poster="${cover ? cover.replace(/http:/, 'https:') : ''}"
                 src="${escapeAttr(videoUrl.replace(/http:/, 'https:'))}">
          </video>

          <!-- 中央播放图标（未播放前点击启动，点击后隐藏） -->
          <button id="mv-center-play" class="mv-center-play absolute inset-0 flex items-center justify-center cursor-pointer" aria-label="播放 MV">
            <div class="mv-center-play-btn flex items-center justify-center rounded-full">
              <i data-lucide="play" class="w-12 h-12" style="color:#fff;margin-left:6px;"></i>
            </div>
          </button>

          <!-- 底部控制栏：鼠标静止淡出，移动出现 -->
          <div id="mv-controls" class="mv-controls absolute left-0 right-0 bottom-0">
            <!-- 进度条（可拖动） -->
            <div class="mv-progress-row px-4 pt-3">
              <span id="mv-time-cur" class="mv-time font-variant-numeric text-xs" style="color:rgba(255,255,255,0.85);">0:00</span>
              <div id="mv-seek" class="mv-seek flex-1 h-1.5 rounded-full overflow-hidden cursor-pointer" style="background:rgba(255,255,255,0.2);">
                <div id="mv-seek-fill" class="mv-seek-fill h-full rounded-full" style="width:0%; background:linear-gradient(to right,#43CBFF,#007aff);"></div>
                <div id="mv-seek-buffered" class="mv-seek-buffered"></div>
              </div>
              <span id="mv-time-dur" class="mv-time font-variant-numeric text-xs" style="color:rgba(255,255,255,0.85);">0:00</span>
            </div>
            <!-- 按钮栏 -->
            <div class="mv-buttons flex items-center justify-between px-4 pb-4 pt-2">
              <!-- 左：播放/暂停 + 倍速 -->
              <div class="flex items-center gap-3">
                <button id="mv-play" class="mv-btn" aria-label="播放/暂停" title="播放/暂停">
                  <i data-lucide="play" class="w-6 h-6"></i>
                </button>
                <!-- 倍速按钮 + 弹出菜单 -->
                <div class="relative">
                  <button id="mv-rate-btn" class="mv-btn mv-rate-btn text-sm font-semibold" aria-label="倍速" title="倍速">
                    ${curRate.toFixed(1)}x
                  </button>
                  <div id="mv-rate-popup" class="mv-rate-popup ${ratePopupOpen ? 'open' : ''}">
                    ${[0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map(r => `
                      <button class="mv-rate-item ${r === curRate ? 'active' : ''}" data-rate="${r}">${r.toFixed(1)}x</button>
                    `).join('')}
                  </div>
                </div>
                <!-- 音量 -->
                <div class="flex items-center gap-2 ml-2">
                  <button id="mv-mute" class="mv-btn" aria-label="静音" title="静音">
                    <i id="mv-vol-icon" data-lucide="volume-2" class="w-5 h-5"></i>
                  </button>
                  <div id="mv-volume" class="mv-volume-bar h-1 rounded-full overflow-hidden cursor-pointer" style="width:80px;background:rgba(255,255,255,0.2);">
                    <div id="mv-volume-fill" class="h-full rounded-full" style="width:100%; background:rgba(255,255,255,0.85);"></div>
                  </div>
                </div>
              </div>
              <!-- 右（保留空位置用于对齐） -->
              <div class="flex items-center gap-2">
              </div>
            </div>
          </div>

          <!-- 加载转圈（缓冲区不足时显示） -->
          <div id="mv-loading" class="mv-loading hidden absolute inset-0 flex items-center justify-center">
            <div class="mv-loading-spinner"></div>
          </div>
        </div>
      </div>

      ${desc ? `
      <!-- MV 简介：放在播放器下方 -->
      <div class="mx-auto mt-5" style="max-width:1200px;">
        <div class="rounded-xl p-4" style="background:color-mix(in srgb, var(--foreground) 3%, transparent); border:1px solid color-mix(in srgb, var(--foreground) 6%, transparent);">
          <div class="flex items-center gap-2 mb-2">
            <i data-lucide="file-text" class="w-4 h-4" style="color:var(--muted-foreground);"></i>
            <span class="text-sm font-medium" style="color:var(--muted-foreground);">MV 简介</span>
          </div>
          <p class="text-sm leading-relaxed whitespace-pre-wrap" style="color:var(--foreground);">${escapeHtml(desc)}</p>
        </div>
      </div>` : ''}
    </section>
  `;
}

// ========== 事件绑定 ==========
function bindAll(container) {
  const video = container.querySelector('#mv-video');
  const centerPlay = container.querySelector('#mv-center-play');
  const playBtn = container.querySelector('#mv-play');
  const fsBtn = container.querySelector('#mv-fullscreen');
  const backBtn = container.querySelector('#mv-back');
  const seek = container.querySelector('#mv-seek');
  const seekFill = container.querySelector('#mv-seek-fill');
  const timeCur = container.querySelector('#mv-time-cur');
  const timeDur = container.querySelector('#mv-time-dur');
  const rateBtn = container.querySelector('#mv-rate-btn');
  const ratePopup = container.querySelector('#mv-rate-popup');
  const muteBtn = container.querySelector('#mv-mute');
  const volIcon = container.querySelector('#mv-vol-icon');
  const volume = container.querySelector('#mv-volume');
  const volumeFill = container.querySelector('#mv-volume-fill');
  const loading = container.querySelector('#mv-loading');
  const playerWrap = container.querySelector('.mv-player');
  const controls = container.querySelector('#mv-controls');

  if (!video) return;

  // 返回按钮
  if (backBtn) backBtn.addEventListener('click', () => window.history.back());

  // ---- 播放/暂停 ----
  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }
  if (centerPlay) centerPlay.addEventListener('click', togglePlay);
  if (playBtn) playBtn.addEventListener('click', togglePlay);
  // 点击视频本身切换播放
  video.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });

  function syncPlayIcon() {
    const playing = !video.paused && !video.ended;
    const iconName = playing ? 'pause' : 'play';
    if (playBtn) playBtn.innerHTML = `<i data-lucide="${iconName}" class="w-6 h-6"></i>`;
    // 中央大图标：播放态隐藏
    if (centerPlay) {
      centerPlay.style.opacity = playing ? '0' : '1';
      centerPlay.style.pointerEvents = playing ? 'none' : 'auto';
    }
    if (window.lucide) window.lucide.createIcons();
  }
  video.addEventListener('play', syncPlayIcon);
  video.addEventListener('pause', syncPlayIcon);
  video.addEventListener('ended', syncPlayIcon);

  // ---- 倍速按钮 ----
  function setRate(r) {
    curRate = r;
    video.playbackRate = r;
    if (rateBtn) rateBtn.textContent = r.toFixed(1) + 'x';
    // 更新 active
    ratePopup && ratePopup.querySelectorAll('.mv-rate-item').forEach(el => {
      el.classList.toggle('active', parseFloat(el.dataset.rate) === r);
    });
  }
  if (rateBtn) rateBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ratePopupOpen = !ratePopupOpen;
    ratePopup && ratePopup.classList.toggle('open', ratePopupOpen);
  });
  ratePopup && ratePopup.addEventListener('click', (e) => e.stopPropagation());
  ratePopup && ratePopup.querySelectorAll('.mv-rate-item').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = parseFloat(el.dataset.rate);
      if (isFinite(r)) setRate(r);
      ratePopupOpen = false;
      ratePopup.classList.remove('open');
    });
  });
  // 点击其他地方关闭倍速菜单
  document.addEventListener('click', () => {
    if (ratePopupOpen) {
      ratePopupOpen = false;
      ratePopup && ratePopup.classList.remove('open');
    }
  });

  // ---- 进度条 + 时长显示（rAF 平滑插值，避免每秒一跳）----
  let _mvRAF = null;
  let _mvLastTime = 0;
  let _mvLastTs = 0;
  let _mvDragging = false;
  function syncTime() {
    const p = video.currentTime || 0;
    const d = video.duration || 0;
    _mvLastTime = p;
    _mvLastTs = performance.now();
    if (timeDur) timeDur.textContent = fmtTime(d);
    if (timeCur) { timeCur.textContent = fmtTime(p); timeCur.dataset.sec = String(Math.floor(p)); }
    if (!_mvDragging && seekFill) seekFill.style.width = (d > 0 ? (p / d * 100) : 0) + '%';
    // 播放中启动 rAF 平滑插值
    if (!video.paused) startMvRAF(); else stopMvRAF();
  }
  function startMvRAF() {
    if (_mvRAF) return;
    const tick = () => {
      if (_mvDragging) { _mvRAF = requestAnimationFrame(tick); return; }
      const d = video.duration || 0;
      if (d > 0 && !video.paused) {
        const now = performance.now();
        const elapsed = (now - _mvLastTs) / 1000;
        const interp = _mvLastTime + elapsed * (video.playbackRate || 1);
        const cur = Math.min(interp, d);
        if (seekFill) seekFill.style.width = Math.min(100, (cur / d * 100)) + '%';
        const sec = Math.floor(cur);
        if (timeCur && timeCur.dataset.sec !== String(sec)) {
          timeCur.dataset.sec = String(sec);
          timeCur.textContent = fmtTime(cur);
        }
      }
      _mvRAF = requestAnimationFrame(tick);
    };
    _mvRAF = requestAnimationFrame(tick);
  }
  function stopMvRAF() { if (_mvRAF) { cancelAnimationFrame(_mvRAF); _mvRAF = null; } }
  video.addEventListener('loadedmetadata', syncTime);
  video.addEventListener('timeupdate', syncTime);
  video.addEventListener('durationchange', syncTime);
  video.addEventListener('play', startMvRAF);
  video.addEventListener('pause', stopMvRAF);
  video.addEventListener('ended', stopMvRAF);

  // 进度条拖动
  let dragging = false;
  function seekFromEvent(e) {
    if (!video || !video.duration) return;
    const rect = seek.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.currentTime = ratio * video.duration;
    seekFill.style.width = (ratio * 100) + '%';
    if (timeCur) timeCur.textContent = fmtTime(ratio * video.duration);
  }
  if (seek) {
    seek.addEventListener('click', seekFromEvent);
    seek.addEventListener('mousedown', (e) => { dragging = true; _mvDragging = true; seekFromEvent(e); });
  }
  document.addEventListener('mousemove', (e) => { if (dragging) seekFromEvent(e); });
  document.addEventListener('mouseup', () => { if (dragging) { dragging = false; _mvDragging = false; } });

  // ---- 音量 + 静音 ----
  video.volume = 1.0;
  let lastVolume = 1.0;
  function syncVolumeUI() {
    const v = video.muted ? 0 : video.volume;
    if (volumeFill) volumeFill.style.width = (v * 100) + '%';
    if (volIcon) {
      const name = (v === 0 || video.muted) ? 'volume-x'
        : (v < 0.5 ? 'volume-1' : 'volume-2');
      volIcon.setAttribute('data-lucide', name);
      if (window.lucide) window.lucide.createIcons();
    }
  }
  function volFromEvent(e) {
    const rect = volume.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.muted = false;
    video.volume = ratio;
    if (ratio > 0) lastVolume = ratio;
    syncVolumeUI();
  }
  if (volume) {
    volume.addEventListener('click', volFromEvent);
    let volDragging = false;
    volume.addEventListener('mousedown', (e) => { volDragging = true; volFromEvent(e); });
    document.addEventListener('mousemove', (e) => { if (volDragging) volFromEvent(e); });
    document.addEventListener('mouseup', () => { volDragging = false; });
  }
  if (muteBtn) muteBtn.addEventListener('click', () => {
    if (video.muted || video.volume === 0) {
      video.muted = false;
      video.volume = lastVolume > 0 ? lastVolume : 0.8;
    } else {
      lastVolume = video.volume;
      video.muted = true;
    }
    syncVolumeUI();
  });
  video.addEventListener('volumechange', syncVolumeUI);
  syncVolumeUI();

  // ---- 视频全屏（双击切换）----
  function doFullscreen() {
    const isFull = !!(document.fullscreenElement && (document.fullscreenElement === video || document.fullscreenElement === playerWrap));
    if (isFull) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else {
      if (video.requestFullscreen) {
        video.requestFullscreen().catch(() => {
          if (playerWrap && playerWrap.requestFullscreen) playerWrap.requestFullscreen().catch(() => {});
        });
      } else if (video.webkitRequestFullscreen) {
        video.webkitRequestFullscreen();
      } else if (playerWrap) {
        if (playerWrap.requestFullscreen) playerWrap.requestFullscreen().catch(() => {});
        else if (playerWrap.webkitRequestFullscreen) playerWrap.webkitRequestFullscreen();
      }
    }
  }

  video.addEventListener('dblclick', (e) => { e.stopPropagation(); doFullscreen(); });

  // ---- 缓冲/加载转圈 ----
  video.addEventListener('waiting', () => loading && loading.classList.remove('hidden'));
  video.addEventListener('canplay', () => loading && loading.classList.add('hidden'));
  video.addEventListener('playing', () => loading && loading.classList.add('hidden'));
  video.addEventListener('seeking', () => loading && loading.classList.remove('hidden'));
  video.addEventListener('seeked', () => loading && loading.classList.add('hidden'));

  // ---- 控件空闲淡出（与全屏播放页相同的体验）----
  let idleTimer = null;
  function showCtrls() {
    if (!controls) return;
    controls.style.opacity = '1';
    controls.style.transform = 'translateY(0)';
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!video.paused) {
        controls.style.opacity = '0';
        controls.style.transform = 'translateY(8px)';
        // 光标隐藏
        if (playerWrap) {
          playerWrap.style.cursor = 'none';
          playerWrap.querySelectorAll('*').forEach(n => n.style.cursor = 'none');
        }
      }
    }, 2500);
  }
  controls && (controls.style.transition = 'opacity 0.3s ease, transform 0.3s ease;');
  [video, playerWrap, controls].forEach(el => {
    if (!el) return;
    el.addEventListener('mousemove', () => {
      if (playerWrap) {
        playerWrap.style.cursor = '';
        playerWrap.querySelectorAll('*').forEach(n => n.style.cursor = '');
      }
      showCtrls();
    });
    el.addEventListener('click', showCtrls);
  });
  video.addEventListener('pause', showCtrls);

  // ---- 空格：播放/暂停；ESC：若全屏则退出；左右箭头：前后 5s；上下箭头：音量 ----
  document.addEventListener('keydown', (e) => {
    if (!container.isConnected) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); showCtrls(); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); video.currentTime = Math.min((video.duration || 0), video.currentTime + 5); syncTime(); showCtrls(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5); syncTime(); showCtrls(); }
    else if (e.code === 'ArrowUp') { e.preventDefault(); video.muted = false; video.volume = Math.min(1, video.volume + 0.1); syncVolumeUI(); showCtrls(); }
    else if (e.code === 'ArrowDown') { e.preventDefault(); video.muted = false; video.volume = Math.max(0, video.volume - 0.1); syncVolumeUI(); showCtrls(); }
    else if (e.code === 'Escape') {
      // ESC 时关闭倍速菜单；全屏退出由浏览器自己处理
      if (ratePopupOpen && ratePopup) { ratePopupOpen = false; ratePopup.classList.remove('open'); }
    }
  });

  // ---- 初始化：首次同步按钮图标 ----
  syncPlayIcon();
  syncTime();
}

// ========== 工具 ==========
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

function fmtTime(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '0:00';
  var m = Math.floor(sec / 60);
  var s = Math.floor(sec % 60);
  var ss = s < 10 ? '0' + s : '' + s;
  return m + ':' + ss;
}
function fmtMs(ms) {
  if (!ms || !isFinite(ms) || ms < 0) return '0:00';
  return fmtTime(Math.floor(ms / 1000));
}
function formatCount(n) {
  if (!isFinite(n) || n < 0) return '0';
  if (n < 10000) return String(n);
  if (n < 100000000) return (n / 10000).toFixed(n % 10000 === 0 ? 0 : 1) + '万';
  return (n / 100000000).toFixed(n % 100000000 === 0 ? 0 : 1) + '亿';
}
function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }

window.views = window.views || {};
window.views.mv = { mount: mountMv };
