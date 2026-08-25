// 「心动模式」视图：基于网易云私人 FM (personal_fm)
// 与每日推荐页类似，但带「刷新」按钮：
//   - 切换页面时已加载的歌曲保留（缓存），不重置播放
//   - 只有点击刷新按钮才会清空缓存并重新拉取
async function mountHeartbeat(container) {
  const api = window.api;
  const ui = window.ui.tracklist;

  // 模块级缓存：挂在 window 上，跨路由切换保持
  window._heartbeatCache = window._heartbeatCache || { tracks: [], loading: false };

  // 已有缓存：直接渲染，不重新拉取（保证切换页面歌曲不重置）
  if (window._heartbeatCache.tracks.length) {
    renderHeartbeat(container, window._heartbeatCache.tracks);
    return;
  }

  // 无缓存：首次进入心动模式，清空容器只显示中间加载提示（无遮罩背景）
  showHeartbeatLoading(container, '正在加载心动模式…');
  await loadHeartbeat(container);
}

// 工具：在视口中央显示加载提示（仅转圈+文字，无背景遮罩）
// 关键：挂到 document.body 而非 container，避免 #view 路由动画期间 opacity:0 导致不可见
function showHeartbeatLoading(container, text) {
  removeHeartbeatMask(); // 先清理旧的
  const mask = document.createElement('div');
  mask.id = 'heartbeat-loading-mask';
  mask.className = 'heartbeat-loading-mask';
  mask.innerHTML = `
    <div class="heartbeat-loading-spinner"></div>
    <div class="heartbeat-loading-text">${text || '加载中…'}</div>
  `;
  document.body.appendChild(mask);
}

// 工具：移除心动模式加载提示
function removeHeartbeatMask(container) {
  // container 参数保留兼容（旧调用传 container），但实际从 body 查找
  const mask = document.getElementById('heartbeat-loading-mask');
  if (mask) mask.remove();
}

// 规范化 personal_fm 返回的歌曲字段：personal_fm 用 artists/album/duration，
// tracklist 期望 ar/al/dt。这里把字段平铺到统一格式，保证列表/底栏/播放页正常。
function normalizeFmTrack(t) {
  if (!t) return t;
  const ar = Array.isArray(t.ar) ? t.ar
    : (Array.isArray(t.artists) ? t.artists
      : (Array.isArray(t.songArtists) ? t.songArtists : []));
  const al = t.al || (t.album ? { ...t.album } : undefined);
  const dt = (t.dt != null) ? t.dt
    : (t.duration != null ? t.duration
      : (t.durationMs != null ? t.durationMs : undefined));
  return {
    ...t,
    ar: ar.length ? ar.map(a => ({ id: a.id, name: a.name })) : ar,
    al,
    dt,
  };
}

// 拉取私人 FM 歌曲（每次约 3 首，循环调用攒够 50 首）
async function fetchFmSongs(targetCount = 50) {
  const api = window.api;
  const all = [];
  const maxCalls = Math.ceil(targetCount / 3) + 4; // 多调几次兜底（personal_fm 会有重复）
  for (let i = 0; i < maxCalls && all.length < targetCount; i++) {
    try {
      const data = await api.netease.personalFm() || [];
      if (!data.length) break;
      // 去重（personal_fm 偶尔会重复返回同一首）
      for (const s of data) {
        if (s && s.id && !all.find(x => x.id === s.id)) {
          all.push(normalizeFmTrack(s));
        }
        if (all.length >= targetCount) break;
      }
    } catch (err) {
      break;
    }
  }
  return all;
}

async function loadHeartbeat(container) {
  const ui = window.ui.tracklist;
  const cache = window._heartbeatCache;
  if (cache.loading) return;
  cache.loading = true;

  // 首次加载：确保显示中间加载提示（mountHeartbeat 已显示，这里兜底）
  if (!cache.tracks.length) {
    if (!document.getElementById('heartbeat-loading-mask')) {
      showHeartbeatLoading(container, '正在加载心动模式…');
    }
  }

  // 记录当前路由，用于加载完成后判断是否还在心动模式页面
  const currentView = window._currentView || 'heartbeat';

  try {
    const session = await window.api.netease.getSession();
    if (!session.cookie || !session.cookie.includes('MUSIC_U=')) {
      // 如果已离开心动模式页面，只更新缓存，不修改 DOM
      if (window._currentView === 'heartbeat' && document.body.contains(container)) {
        container.innerHTML = ui.renderEmpty({
          icon: 'heart-pulse', title: '登录后开启心动模式',
          hint: '心动模式基于私人 FM，需登录网易云账号',
        });
      }
      cache.loading = false;
      removeHeartbeatMask(container);
      return;
    }
    const tracks = await fetchFmSongs(50);
    if (!tracks.length) {
      if (window._currentView === 'heartbeat' && document.body.contains(container)) {
        container.innerHTML = ui.renderEmpty({ icon: 'heart-pulse', title: '暂无心动推荐' });
      }
      cache.loading = false;
      removeHeartbeatMask(container);
      return;
    }
    cache.tracks = tracks;
    // 只有当用户还在心动模式页面时才渲染，否则只更新缓存
    if (window._currentView === 'heartbeat' && document.body.contains(container)) {
      renderHeartbeat(container, tracks);
    }
    // 移除加载遮罩
    removeHeartbeatMask(container);
  } catch (err) {
    removeHeartbeatMask(container);
    if (window._currentView === 'heartbeat' && document.body.contains(container)) {
      container.innerHTML = ui.renderError(err.message);
    }
  } finally {
    cache.loading = false;
  }
}

function renderHeartbeat(container, tracks) {
  const ui = window.ui.tracklist;
  // 封面取第一首歌的封面（personal_fm 经 normalizeFmTrack 后 al.picUrl 即为封面）
  const cover = tracks[0] && tracks[0].al && tracks[0].al.picUrl;
  const meta = `BcsMusic · 心动模式 · ${tracks.length} 首 · 点击刷新换一批`;
  container.innerHTML = ui.renderHero({ cover, badge: '心动模式', title: '', meta, tracks })
    + `<section class="px-8 pb-8" id="tracklist-wrap"></section>`;

  // 在 hero 按钮区插入「刷新」按钮（圆角样式，参考 search 页查看更多按钮）
  const heroBtnRow = container.querySelector('section .flex.items-center.gap-3.mt-1');
  if (heroBtnRow) {
    const refreshBtn = document.createElement('button');
    refreshBtn.id = 'heartbeat-refresh';
    refreshBtn.className = 'h-9 px-4 rounded-lg text-sm flex items-center gap-1.5';
    refreshBtn.style.cssText = 'background:color-mix(in srgb, var(--primary) 10%, transparent); border:1px solid color-mix(in srgb, var(--primary) 30%, transparent); color:var(--primary);';
    refreshBtn.innerHTML = `<i data-lucide="refresh-cw" class="w-4 h-4"></i>换一批`;
    refreshBtn.addEventListener('click', () => onRefreshHeartbeat(container));
    heroBtnRow.appendChild(refreshBtn);
  }

  ui.bindPlayAll(container, tracks);
  const tl = ui.renderTracklist(tracks);
  const wrap = container.querySelector('#tracklist-wrap');
  wrap.innerHTML = tl.html;
  tl.bind(wrap);
  if (window.lucide) window.lucide.createIcons();

  // 逐字标题
  const routeDelay = Math.round(280 * (window.animMult ? window.animMult() : 1));
  const titleEl = container.querySelector('h1');
  if (titleEl) ui.animateTextSwap(titleEl, '', '心动模式', { delay: routeDelay });
}

// 刷新：旧内容滚出+淡出 → 拉取新内容（期间显示遮罩+转圈） → 新封面渐变出现 + 新列表滚入
async function onRefreshHeartbeat(container) {
  const ui = window.ui.tracklist;
  const animMult = window.animMult ? window.animMult() : 1;
  const btn = container.querySelector('#heartbeat-refresh');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i>刷新中…`;
    if (window.lucide) window.lucide.createIcons();
  }

  // ===== 1) 旧内容滚出+淡出（封面 + 列表 + 标题区域一起淡出，避免内容直接消失闪现）=====
  const hero = container.querySelector('section.flex.items-end');
  const coverWrap = container.querySelector('#hero-cover');
  const tracklistWrap = container.querySelector('#tracklist-wrap');
  const fadeOutMs = Math.round(260 * animMult);
  if (hero) {
    hero.style.transition = `opacity ${fadeOutMs}ms ease-out, transform ${fadeOutMs}ms ease-out`;
    hero.style.opacity = '0';
    hero.style.transform = 'translateY(-12px)';
  }
  if (tracklistWrap) {
    tracklistWrap.style.transition = `opacity ${fadeOutMs}ms ease-out, transform ${fadeOutMs}ms ease-out`;
    tracklistWrap.style.opacity = '0';
    tracklistWrap.style.transform = 'translateY(20px)';
  }
  // 等淡出动画完成
  await new Promise(r => setTimeout(r, fadeoutMs(fadeOutMs)));

  // ===== 2) 清空缓存 + 重新拉取（不重渲染中间态，避免骨架闪现）=====
  window._heartbeatCache.tracks = [];
  // 旧内容已淡出：清空容器，显示中间加载提示（无背景遮罩，只居中转圈+文字）
  container.innerHTML = '';
  showHeartbeatLoading(container, '换一批中…');
  // 触发淡入
  const mask = document.getElementById('heartbeat-loading-mask');
  if (mask) {
    mask.style.opacity = '0';
    mask.style.transition = 'opacity 200ms ease-out';
    mask.getBoundingClientRect();
    requestAnimationFrame(() => { mask.style.opacity = '1'; });
  }

  // ===== 3) 拉取新数据 =====
  try {
    const tracks = await fetchFmSongs(50);
    if (!tracks.length) {
      removeHeartbeatMask(container);
      // 只有当用户还在心动模式页面时才更新 DOM
      if (window._currentView === 'heartbeat' && document.body.contains(container)) {
        container.innerHTML = ui.renderEmpty({ icon: 'heart-pulse', title: '暂无心动推荐' });
      }
      return;
    }
    window._heartbeatCache.tracks = tracks;

    // 如果用户已离开心动模式页面，只更新缓存，不渲染 DOM
    if (window._currentView !== 'heartbeat' || !document.body.contains(container)) {
      removeHeartbeatMask(container);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="refresh-cw" class="w-4 h-4"></i>换一批`;
        if (window.lucide) window.lucide.createIcons();
      }
      return;
    }

    // ===== 4) 渲染新内容（先 opacity:0，再触发渐变出现）=====
    renderHeartbeat(container, tracks);
    const newHero = container.querySelector('section.flex.items-end');
    const newCoverWrap = container.querySelector('#hero-cover');
    const newTracklistWrap = container.querySelector('#tracklist-wrap');
    const fadeInMs = Math.round(360 * animMult);
    if (newHero) {
      newHero.style.transition = `opacity ${fadeInMs}ms ease-out, transform ${fadeInMs}ms cubic-bezier(0.22, 1, 0.36, 1)`;
      newHero.style.opacity = '0';
      newHero.style.transform = 'translateY(-12px)';
    }
    if (newTracklistWrap) {
      newTracklistWrap.style.transition = `opacity ${fadeInMs}ms ease-out, transform ${fadeInMs}ms cubic-bezier(0.22, 1, 0.36, 1)`;
      newTracklistWrap.style.opacity = '0';
      newTracklistWrap.style.transform = 'translateY(20px)';
    }
    // ===== 4.1) 先淡出遮罩，再触发新内容渐变出现 =====
    // 这样视觉上是「转圈淡出 → 新内容渐变滚入」，而非转圈突然消失
    const maskFadeMs = Math.round(180 * animMult);
    if (mask) {
      mask.style.transition = `opacity ${maskFadeMs}ms ease-out`;
      mask.style.opacity = '0';
    }
    // 等遮罩淡出后再触发新内容渐变（重叠 30% 让过渡更顺滑）
    await new Promise(r => setTimeout(r, Math.round(maskFadeMs * 0.7)));
    // 强制重排，让初始 opacity:0 生效后再触发动画
    if (newHero) newHero.getBoundingClientRect();
    requestAnimationFrame(() => {
      if (newHero) { newHero.style.opacity = '1'; newHero.style.transform = 'translateY(0)'; }
      if (newTracklistWrap) { newTracklistWrap.style.opacity = '1'; newTracklistWrap.style.transform = 'translateY(0)'; }
    });

    // 封面图加载完后渐变出现（renderHero 内 img onload 已经处理 opacity:0→1）
    if (newCoverWrap && tracks[0] && tracks[0].al && tracks[0].al.picUrl) {
      const img = newCoverWrap.querySelector('img');
      if (img) {
        img.style.opacity = '0';
        img.style.transition = `opacity ${fadeInMs}ms ease-out`;
        // renderHero 已经绑了 onload，这里额外确保 onload 后再触发
        const triggerIn = () => { requestAnimationFrame(() => { img.style.opacity = '1'; }); };
        if (img.complete) triggerIn();
        else img.addEventListener('load', triggerIn, { once: true });
      }
    }
    // 遮罩淡出动画结束后彻底移除（避免残留挡住交互）
    setTimeout(() => removeHeartbeatMask(container), maskFadeMs);
  } catch (err) {
    removeHeartbeatMask(container);
    if (window._currentView === 'heartbeat' && document.body.contains(container)) {
      container.innerHTML = ui.renderError(err.message);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="refresh-cw" class="w-4 h-4"></i>换一批`;
      if (window.lucide) window.lucide.createIcons();
    }
  }
}


// 工具：把 fadeOutMs 兜底（防止 0 或非法值导致立刻跳过 await）
function fadeoutMs(v) { return (v && v > 0) ? v : 1; }

window.views = window.views || {};
window.views.heartbeat = { mount: mountHeartbeat };
