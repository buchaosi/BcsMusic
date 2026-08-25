// SPA 入口：路由 + 启动时初始化（侧栏歌单、用户头像、窗口控件、登录入口）
// 依赖（plain script 已挂到 window）：player, auth, ui, views
const view = document.getElementById('view');
const sidebarNav = document.getElementById('sidebar-nav');
const userChip = document.getElementById('user-chip');
const userAvatar = document.getElementById('user-avatar');
const userName = document.getElementById('user-name');
const userPlaylistsEl = document.getElementById('user-playlists');
const navBackBtn = document.getElementById('nav-back');

// ============ 动画速度倍率 ============
// 来自设置页常规设置（数字填写，默认 1.0；越小越快）
// 同时写入 CSS 变量 --anim-mult 和供 JS setTimeout 使用
let _animMultCache = 1.0;
function animMult() { return _animMultCache; }
function applyAnimMult(v) {
  const n = parseFloat(v);
  _animMultCache = (isFinite(n) && n > 0) ? n : 1.0;
  document.documentElement.style.setProperty('--anim-mult', String(_animMultCache));
}
// ============ 逐字动画速度倍率 ============
// 来自设置页常规设置（数字填写，默认 0.6；越小越快）
let _textAnimMultCache = 0.6;
function textAnimMult() { return _textAnimMultCache; }
function applyTextAnimMult(v) {
  const n = parseFloat(v);
  _textAnimMultCache = (isFinite(n) && n > 0) ? n : 0.6;
}
// 启动时从设置读取
(async () => {
  try {
    const s = await window.api.settings.get();
    applyAnimMult(s.animationSpeed != null ? s.animationSpeed : 1.0);
    applyTextAnimMult(s.textAnimSpeed != null ? s.textAnimSpeed : 0.6);
    // 调试日志开关：只有用户在设置页开启「显示调试日志」时才启用 bcsLog 打点
    window.__bcsDebug = (s.showDebugLog === true);
  } catch { applyAnimMult(1.0); applyTextAnimMult(0.6); }
})();
window.applyAnimMult = applyAnimMult;
window.animMult = animMult;
window.applyTextAnimMult = applyTextAnimMult;
window.textAnimMult = textAnimMult;

const ROUTES = [
  { pattern: /^\/favorites\/?$/, view: 'favorites' },
  { pattern: /^\/daily\/?$/, view: 'daily' },
  { pattern: /^\/heartbeat\/?$/, view: 'heartbeat' },
  { pattern: /^\/albums\/?$/, view: 'albums' },
  { pattern: /^\/recent\/?$/, view: 'recent' },
  { pattern: /^\/playlist\/(\d+)\/?$/, view: 'playlist', params: m => ({ id: m[1] }) },
  { pattern: /^\/artist\/(\d+)\/?$/, view: 'artist', params: m => ({ id: m[1] }) },
  { pattern: /^\/album\/(\d+)\/?$/, view: 'album', params: m => ({ id: m[1] }) },
  { pattern: /^\/search\/?$/, view: 'search', params: m => ({ q: parseSearchQuery() }) },
  { pattern: /^\/settings\/?$/, view: 'settings' },
  { pattern: /^\/mv\/(\d+)\/?$/, view: 'mv', params: m => ({ id: m[1] }) },
];

// 侧栏主导航顺序，用于决定转场动画方向（向前=上滚，向后=下滚）
// playlist/artist/album 作为「更深一层」的子页，导航到它们视作「向前」
const ROUTE_ORDER = ['favorites', 'daily', 'heartbeat', 'albums', 'recent', 'playlist', 'artist', 'album', 'search', 'settings', 'mv'];

function parseHash() {
  // 支持 #/favorites 或 #favorites 两种形式
  const raw = window.location.hash.replace(/^#\/?/, '');
  return '/' + raw;
}

// 从 hash 里取 q 参数：#/search?q=keyword
function parseSearchQuery() {
  const hash = window.location.hash;
  const qIdx = hash.indexOf('q=');
  if (qIdx === -1) return '';
  return decodeURIComponent(hash.slice(qIdx + 2));
}

function matchRoute(path) {
  // 分离 path 和 query：/search?q=hello → path=/search, q=hello
  const qIdx = path.indexOf('?');
  const purePath = qIdx === -1 ? path : path.slice(0, qIdx);
  for (const r of ROUTES) {
    const m = purePath.match(r.pattern);
    if (m) return { view: r.view, params: r.params ? r.params(m) : {} };
  }
  return { view: 'favorites', params: {} }; // 默认路由
}

let currentRoute = null;

// ---------- 浏览历史：记录用户点击流程，支持「返回上一级」 ----------
// 仅记录导航方向发生变化的跳转；同页参数变化也记录（如歌单A→歌单B）
const ROUTE_HISTORY_KEY = 'bcsmusic:route-history';
let routeHistory = []; // [{ path, view, params }]
let isNavigatingBack = false; // 返回时不应再 push 新历史

function loadRouteHistory() {
  try {
    const raw = sessionStorage.getItem(ROUTE_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveRouteHistory() {
  try { sessionStorage.setItem(ROUTE_HISTORY_KEY, JSON.stringify(routeHistory.slice(-30))); } catch {}
}
function pushRouteHistory(path, view, params) {
  if (isNavigatingBack) return;
  // 顶层路由（侧栏主入口）视为新会话起点：清掉旧历史
  const topViews = ['favorites', 'daily', 'heartbeat', 'albums', 'recent', 'search', 'settings'];
  if (topViews.includes(view) && routeHistory.length && topViews.includes(routeHistory[routeHistory.length - 1].view)) {
    // 同为顶层入口时不重置，只追加
  }
  routeHistory.push({ path, view, params: params || {} });
  if (routeHistory.length > 30) routeHistory.shift();
  saveRouteHistory();
  updateNavBackVisibility();
}
function popRouteHistory() {
  if (routeHistory.length < 2) return null;
  // 当前页是栈顶，要回到倒数第二个
  routeHistory.pop();
  saveRouteHistory();
  updateNavBackVisibility();
  return routeHistory[routeHistory.length - 1];
}
function updateNavBackVisibility() {
  if (!navBackBtn) return;
  navBackBtn.style.visibility = routeHistory.length > 1 ? 'visible' : 'hidden';
  navBackBtn.style.opacity = routeHistory.length > 1 ? '1' : '0';
}

// 转场动画：根据新旧路由在 ROUTE_ORDER 里的下标决定「上滚」或「下滚」
function routeAnimClass(prevView, nextView) {
  if (!prevView || prevView === nextView) return null;
  const prevIdx = ROUTE_ORDER.indexOf(prevView);
  const nextIdx = ROUTE_ORDER.indexOf(nextView);
  // 未知路由视为「向前」
  if (prevIdx === -1) return 'route-anim-in-up';
  if (nextIdx === -1) return 'route-anim-in-up';
  return nextIdx >= prevIdx ? 'route-anim-in-up' : 'route-anim-in-down';
}

async function route() {
  const path = parseHash();
  const match = matchRoute(path);
  const isSame = currentRoute && currentRoute.view === match.view
    && JSON.stringify(currentRoute.params) === JSON.stringify(match.params);
  if (isSame) return;

  // 同视图不同参数（如 /playlist/1 → /playlist/2）：做淡出→重挂载→淡入过渡
  const sameViewDiffParams = currentRoute && currentRoute.view === match.view
    && JSON.stringify(currentRoute.params) !== JSON.stringify(match.params);

  // 同步搜索框内容（从热搜点击进入时回填关键词）
  syncSearchInput();

  // 高亮侧栏当前路由项
  document.querySelectorAll('.nav-item').forEach(el => {
    el.dataset.active = (el.dataset.route === match.view) ? 'true' : 'false';
  });

  const prevView = currentRoute ? currentRoute.view : null;

  // 1) 退出动画：当前页滚出 + 淡出
  if (sameViewDiffParams) {
    // 同视图切换参数：简单淡出+下移，不走完整上下滚动动画
    view.style.transition = `opacity ${Math.round(200 * animMult())}ms ease-out, transform ${Math.round(200 * animMult())}ms ease-out`;
    view.style.opacity = '0';
    view.style.transform = 'translateY(-10px)';
    await new Promise(r => setTimeout(r, Math.round(200 * animMult())));
  } else if (prevView && prevView !== match.view) {
    const outClass = routeAnimClass(prevView, match.view) === 'route-anim-in-up'
      ? 'route-anim-out-up' : 'route-anim-out-down';
    view.classList.add(outClass);
    await new Promise(r => setTimeout(r, Math.round(220 * animMult())));
    view.classList.remove(outClass);
  }

  // 2) 先把容器隐藏 + 清空，避免新视图挂载过程中骨架/旧内容闪现
  view.style.opacity = '0';
  view.style.pointerEvents = 'none';
  view.scrollTop = 0;

  // 离开旧视图前调用其 _cleanup（如 settings 的 bcslog:append 订阅、playlist 的事件监听）
  if (typeof view._cleanup === 'function') {
    try { view._cleanup(); } catch (e) { console.warn('[route] cleanup 失败:', e); }
    view._cleanup = null;
  }

  // 记录当前视图，供子页面判断是否还在当前页面
  window._currentView = match.view;

  // 离开心动模式时隐藏加载遮罩（但不中断后台加载）
  if (prevView === 'heartbeat' && match.view !== 'heartbeat') {
    const mask = document.getElementById('heartbeat-loading-mask');
    if (mask) mask.remove();
  }

  currentRoute = match;
  // 记录浏览历史
  pushRouteHistory(path, match.view, match.params);
  const mod = window.views[match.view];
  if (!mod || typeof mod.mount !== 'function') {
    view.innerHTML = `<div class="empty-state"><p>路由 ${match.view} 未实现</p></div>`;
  } else {
    try {
      await mod.mount(view, match.params);
    } catch (err) {
      view.innerHTML = window.ui.tracklist.renderError(err.message);
    }
  }
  refreshIcons();

  // 3) 进入动画：先把容器恢复可交互但保持透明，再触发滚入动画
  view.style.pointerEvents = '';
  let routeDoneDelay = 0;
  if (sameViewDiffParams) {
    // 同视图切换参数：淡入+上移归位
    view.style.transition = `opacity ${Math.round(280 * animMult())}ms ease-out, transform ${Math.round(280 * animMult())}ms cubic-bezier(0.22, 1, 0.36, 1)`;
    view.style.opacity = '0';
    view.style.transform = 'translateY(14px)';
    requestAnimationFrame(() => {
      view.style.opacity = '1';
      view.style.transform = 'translateY(0)';
    });
    routeDoneDelay = Math.round(280 * animMult());
    setTimeout(() => { view.style.transition = ''; view.style.transform = ''; }, routeDoneDelay);
  } else if (prevView && prevView !== match.view) {
    const inClass = routeAnimClass(prevView, match.view);
    if (inClass) {
      view.classList.add(inClass);
      view.style.opacity = '';
      routeDoneDelay = Math.round(280 * animMult());
      setTimeout(() => view.classList.remove(inClass), routeDoneDelay);
    } else {
      view.style.opacity = '';
    }
  } else {
    // 首次挂载：直接淡入
    view.style.transition = 'opacity 0.3s ease-out';
    requestAnimationFrame(() => { view.style.opacity = ''; });
    routeDoneDelay = 320;
    setTimeout(() => { view.style.transition = ''; }, routeDoneDelay);
  }
  // ====== 关键修复：路由 + 滚入动画完全结束后，再通知 view 做逐字打字等"用户可见"动画 ======
  // view 侧通过 window.addEventListener('app:route-animation-done', handler) 监听
  //     或用 data-route-animate-done 标记已处理，避免重复触发
  const totalRouteAnimMs = routeDoneDelay + 30; // 多加 30ms 让布局完全稳定
  setTimeout(() => {
    view.dispatchEvent(new CustomEvent('app:route-animation-done', {
      bubbles: true,
      detail: { view: match.view, params: match.params },
    }));
    try { window.dispatchEvent(new CustomEvent('app:route-animation-done', { detail: { view: match.view, params: match.params } })); } catch (_) {}
  }, totalRouteAnimMs);
  // 返回导航完成，重置标志
  isNavigatingBack = false;
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

// ---------- 背景图 ----------
const bgImage = document.getElementById('bg-image');
const bgLoadingMask = document.getElementById('bg-loading-mask');
const bgLoadingSpinner = document.getElementById('bg-loading-spinner');

// 显示/隐藏背景加载遮罩：选择图片或应用背景图时弹出居中转圈
function showBgLoading() {
  if (bgLoadingMask) bgLoadingMask.classList.remove('hidden');
}
function hideBgLoading() {
  if (bgLoadingMask) bgLoadingMask.classList.add('hidden');
}
window.showBgLoading = showBgLoading;
window.hideBgLoading = hideBgLoading;

async function applyBackground() {
  const s = await window.api.settings.get();
  // 应用字体（customFont 是 dataURL）
  applyCustomFont(s);
  if (s.backgroundImage) {
    // 加载遮罩：图片未加载完成前显示居中转圈
    showBgLoading();
    // 预加载图片，加载完成后才隐藏遮罩
    const img = new Image();
    img.onload = () => {
      bgImage.style.backgroundImage = `url("${s.backgroundImage}")`;
      bgImage.style.backgroundSize = s.backgroundFit || 'cover';
      bgImage.style.backgroundPosition = 'center';
      bgImage.style.backgroundRepeat = 'no-repeat';
      bgImage.style.opacity = String(s.backgroundOpacity != null ? s.backgroundOpacity : 0.4);
      // 模糊度：通过 filter:blur 实现
      const blur = s.backgroundBlur != null ? s.backgroundBlur : 0;
      bgImage.style.filter = blur > 0 ? `blur(${blur}px)` : 'none';
      bgImage.classList.remove('hidden');
      hideBgLoading();
    };
    img.onerror = () => {
      // 加载失败也隐藏遮罩，避免一直转
      hideBgLoading();
    };
    img.src = s.backgroundImage;
  } else {
    bgImage.classList.add('hidden');
    bgImage.style.backgroundImage = '';
    bgImage.style.filter = 'none';
    hideBgLoading();
  }
}
window.applyBackground = applyBackground;

// ---------- 自定义 UI 字体 ----------
// 注入一个 @font-face 到 <head>，并把 body 的 font-family 改为自定义字体
let customFontStyleEl = null;
function applyCustomFont(s) {
  const name = (s && s.customFontName) || 'BcsCustomFont';
  const dataUrl = s && s.customFont;
  // 已注入过：更新或移除
  if (customFontStyleEl) {
    customFontStyleEl.remove();
    customFontStyleEl = null;
  }
  if (dataUrl) {
    customFontStyleEl = document.createElement('style');
    customFontStyleEl.id = 'bcsm-custom-font';
    customFontStyleEl.textContent = `
      @font-face {
        font-family: "${name}";
        src: url("${dataUrl}") format("woff2"), url("${dataUrl}") format("woff"), url("${dataUrl}") format("truetype");
        font-display: swap;
      }
      body, body * { font-family: "${name}", -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    `;
    document.head.appendChild(customFontStyleEl);
  }
}
window.applyCustomFont = applyCustomFont;

// ---------- 搜索栏 ----------
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
const searchDropdown = document.getElementById('search-dropdown');

// 历史搜索：localStorage 持久化，最多 20 条
const SEARCH_HISTORY_KEY = 'bcsmusic:search-history';
function loadSearchHistory() {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveSearchHistory(list) {
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list.slice(0, 20))); } catch {}
}
function pushSearchHistory(q) {
  const list = loadSearchHistory().filter(x => x !== q);
  list.unshift(q);
  saveSearchHistory(list);
}
// 暴露给 views 复用（如搜索页热搜榜点击）
window.pushSearchHistory = pushSearchHistory;
function removeSearchHistory(q) {
  saveSearchHistory(loadSearchHistory().filter(x => x !== q));
}

// 渲染下拉内容
let suggestAbort = null;
function renderSearchDropdown() {
  const q = searchInput.value.trim();
  const history = loadSearchHistory();
  const parts = [];

  if (q) {
    // 有输入：建议在上，历史在下（折叠为 tags）
    parts.push(`
      <div class="search-section" id="ss-suggest">
        <div class="search-section-title"><span>搜索建议</span></div>
        <div class="px-1 pb-1" id="ss-suggest-list">
          <div class="px-3 py-2 text-xs" style="color:var(--muted-foreground);">正在获取…</div>
        </div>
      </div>
    `);
    if (history.length) {
      parts.push(`
        <div class="search-section">
          <div class="search-section-title">
            <span>历史搜索</span>
            <button id="ss-clear-history" type="button">清空</button>
          </div>
          <div class="search-tags">
            ${history.map(h => `
              <span class="search-tag" data-q="${escapeHtmlAttr(h)}">
                <span>${escapeHtml(h)}</span>
                <button class="si-rm" data-rm="${escapeHtmlAttr(h)}" aria-label="删除"><i data-lucide="x" class="w-3 h-3"></i></button>
              </span>
            `).join('')}
          </div>
        </div>
      `);
    }
  } else {
    // 无输入：只显示历史
    if (!history.length) {
      parts.push(`
        <div class="px-3 py-3 text-center text-xs" style="color:var(--muted-foreground);">
          输入关键词开始搜索
        </div>
      `);
    } else {
      parts.push(`
        <div class="search-section">
          <div class="search-section-title">
            <span>历史搜索</span>
            <button id="ss-clear-history" type="button">清空</button>
          </div>
          <div class="px-1 pb-1">
            ${history.map((h, i) => `
              <div class="search-item" data-q="${escapeHtmlAttr(h)}">
                <i data-lucide="clock" class="w-4 h-4 si-icon"></i>
                <div class="si-text">
                  <div class="si-name">${escapeHtml(h)}</div>
                </div>
                <button class="si-rm" data-rm="${escapeHtmlAttr(h)}" aria-label="删除"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>
              </div>
            `).join('')}
          </div>
        </div>
      `);
    }
  }
  searchDropdown.innerHTML = parts.join('');
  refreshIcons();
  bindDropdownItems();

  // 异步拉取建议
  if (q) fetchSuggestions(q);
}

// 拉搜索建议（带 abort，避免旧请求覆盖新请求）
async function fetchSuggestions(q) {
  if (suggestAbort) suggestAbort.aborted = true;
  const my = { aborted: false };
  suggestAbort = my;
  try {
    // searchSuggest 返回 { songs?, artists?, albums?, playlists?, order? }
    const result = await window.api.netease.searchSuggest(q);
    if (my.aborted) return;
    const list = document.getElementById('ss-suggest-list');
    if (!list) return;
    const items = [];
    const order = result && result.order || [];
    // order 决定展示顺序，未给则按 songs->artists->albums->playlists
    const groups = [
      ['songs', '歌曲', 'music'],
      ['artists', '歌手', 'user'],
      ['albums', '专辑', 'disc'],
      ['playlists', '歌单', 'list-music'],
    ];
    const picked = order.length ? order : groups.map(g => g[0]);
    for (const key of picked) {
      const arr = result && result[key];
      if (!Array.isArray(arr) || !arr.length) continue;
      const meta = groups.find(g => g[0] === key);
      for (const it of arr.slice(0, 4)) {
        let name = '', sub = '';
        if (key === 'songs') {
          name = it.name || '';
          sub = (it.artists && it.artists.map(a => a.name).join('/')) || '';
        } else if (key === 'artists') {
          name = it.name || '';
          sub = (it.accountId ? '' : '');
        } else if (key === 'albums') {
          name = it.name || '';
          sub = (it.artist && it.artist.name) || '';
        } else if (key === 'playlists') {
          name = it.name || '';
          sub = (it.creator && it.creator.nickname) || '';
        }
        items.push(`
          <div class="search-item" data-q="${escapeHtmlAttr(name)}">
            <i data-lucide="${meta[2]}" class="w-4 h-4 si-icon"></i>
            <div class="si-text">
              <div class="si-name">${escapeHtml(name)}</div>
              ${sub ? `<div class="si-meta">${escapeHtml(sub)}</div>` : ''}
            </div>
          </div>
        `);
      }
    }
    list.innerHTML = items.length ? items.join('')
      : `<div class="px-3 py-2 text-xs" style="color:var(--muted-foreground);">无相关建议</div>`;
    refreshIcons();
    bindDropdownItems();
  } catch (err) {
    const list = document.getElementById('ss-suggest-list');
    if (list && !my.aborted) {
      list.innerHTML = `<div class="px-3 py-2 text-xs" style="color:var(--muted-foreground);">建议获取失败</div>`;
    }
  }
}

function bindDropdownItems() {
  // 点击条目：填入输入框并搜索
  searchDropdown.querySelectorAll('[data-q]').forEach(el => {
    if (el.tagName === 'BUTTON' || el.classList.contains('si-rm')) return;
    el.addEventListener('click', (e) => {
      // 点到删除按钮时不触发搜索
      if (e.target.closest('[data-rm]')) return;
      const q = el.dataset.q;
      if (!q) return;
      searchInput.value = q;
      pushSearchHistory(q);
      hideSearchDropdown();
      window.location.hash = `#/search?q=${encodeURIComponent(q)}`;
    });
  });
  // 删除单条历史
  searchDropdown.querySelectorAll('[data-rm]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeSearchHistory(btn.dataset.rm);
      renderSearchDropdown();
    });
  });
  // 清空历史
  const clearBtn = document.getElementById('ss-clear-history');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      saveSearchHistory([]);
      renderSearchDropdown();
    });
  }
}

function showSearchDropdown() {
  if (searchDropdown.classList.contains('hidden')) {
    searchDropdown.classList.remove('hidden');
    // 重新触发动画：先去掉再加上
    void searchDropdown.offsetWidth;
  }
  renderSearchDropdown();
}
function hideSearchDropdown() {
  // 向上淡出后再隐藏（而非直接消失）
  if (searchDropdown.classList.contains('hidden') || searchDropdown.classList.contains('closing')) return;
  searchDropdown.classList.add('closing');
  const mult = animMult();
  // 与 CSS @keyframes search-dropdown-out 时长同步（0.18s × anim-mult）
  setTimeout(() => {
    searchDropdown.classList.add('hidden');
    searchDropdown.classList.remove('closing');
    searchDropdown.innerHTML = '';
  }, Math.round(180 * mult));
}

// HTML 转义（与 ui.tracklist.escapeHtml 同步行为，避免依赖加载顺序）
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeHtmlAttr(s) {
  return escapeHtml(s);
}

// 回车搜索
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const q = searchInput.value.trim();
    if (q) {
      pushSearchHistory(q);
      hideSearchDropdown();
      window.location.hash = `#/search?q=${encodeURIComponent(q)}`;
    }
  }
  // Esc 清空搜索
  if (e.key === 'Escape') {
    searchInput.value = '';
    syncSearchClearBtn();
    hideSearchDropdown();
  }
  if (e.key === 'ArrowDown' && !searchDropdown.classList.contains('hidden')) {
    // 下拉打开时按 ↓ 聚焦到第一项
    const first = searchDropdown.querySelector('[data-q]:not([data-rm])');
    if (first) first.focus();
  }
});

// 输入时显示/隐藏清除按钮 + 重渲染下拉
searchInput.addEventListener('input', () => {
  syncSearchClearBtn();
  if (!searchDropdown.classList.contains('hidden')) renderSearchDropdown();
});

// 聚焦时显示下拉
searchInput.addEventListener('focus', () => {
  showSearchDropdown();
});

// 失焦时延迟隐藏（让点击事件先触发）
searchInput.addEventListener('blur', () => {
  setTimeout(() => {
    // 如果焦点移到了下拉里，不隐藏
    if (searchDropdown.contains(document.activeElement)) return;
    hideSearchDropdown();
  }, 180);
});

// 点击清除按钮
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  syncSearchClearBtn();
  searchInput.focus();
});

function syncSearchClearBtn() {
  const hasText = searchInput.value.length > 0;
  searchClear.classList.toggle('hidden', !hasText);
}

// 路由切换时同步搜索框内容（从热搜点击进入时回填关键词）
function syncSearchInput() {
  const path = parseHash();
  if (path.startsWith('/search')) {
    const q = parseSearchQuery();
    if (searchInput.value !== q) searchInput.value = q;
  } else {
    if (searchInput.value) searchInput.value = '';
  }
  syncSearchClearBtn();
}

// ---------- 用户会话与登录 ----------
async function refreshUserChip() {
  const session = await window.api.netease.getSession();
  if (session.nickname) {
    userName.textContent = session.nickname;
    if (session.avatarUrl) {
      userAvatar.innerHTML = `<img src="${session.avatarUrl}?param=56x56" alt="头像" class="w-full h-full object-cover rounded-full">`;
    } else {
      userAvatar.textContent = session.nickname.slice(0, 1).toUpperCase();
    }
    userChip.dataset.loggedIn = 'true';
  } else {
    userName.textContent = '未登录';
    userAvatar.textContent = 'U';
    userAvatar.style.background = 'var(--secondary)';
    userChip.dataset.loggedIn = 'false';
  }
  refreshIcons();
}
// 暴露给设置页（退出登录 / 登录后刷新用户卡片与侧栏歌单）
window.refreshUserChip = refreshUserChip;
window.loadSidebarPlaylists = loadSidebarPlaylists;

// 启动时校验登录态：无论是否有 userId，只要有 cookie 就调 loginStatus 验证
// 旧版 bug 可能存了匿名 cookie（不含 MUSIC_U）但有 profile，导致每日推荐
// 显示 demo 数据 / 网易云漫游 301。始终校验可清掉被污染的 cookie。
async function validateSession() {
  const session = await window.api.netease.getSession();
  if (!session.cookie) return; // 未登录，无需校验
  // 快速检测：cookie 不含 MUSIC_U → 一定是匿名/失效 cookie，直接清掉
  if (!session.cookie.includes('MUSIC_U=')) {
    await window.api.netease.clearSession();
    return;
  }
  try {
    const body = await window.api.netease.loginStatus();
    const profile = body && body.data && body.data.profile;
    if (!profile) {
      // cookie 存在但 loginStatus 拿不到 profile → 失效 cookie，清掉
      await window.api.netease.clearSession();
    }
  } catch (err) {
    // loginStatus 报错 → cookie 失效，清掉
    await window.api.netease.clearSession();
  }
}

userChip.addEventListener('click', async () => {
  const loggedIn = userChip.dataset.loggedIn === 'true';
  if (loggedIn) {
    if (!confirm('退出网易云音乐登录？')) return;
    await window.api.netease.logout();
    await refreshUserChip();
    await loadSidebarPlaylists();
    await route();
    window.toast('已退出登录');
    return;
  }
  window.auth.openQrModal({
    onSuccess: async () => {
      await refreshUserChip();
      await loadSidebarPlaylists();
      await route();
      window.toast('登录成功');
    },
  });
});

// ---------- 侧栏「我的歌单」 ----------
async function loadSidebarPlaylists() {
  const session = await window.api.netease.getSession();
  if (!session.userId) {
    userPlaylistsEl.innerHTML = `<a class="h-8 flex items-center text-xs rounded-md px-2 opacity-0 group-hover:opacity-100 transition-opacity" style="color:var(--muted-foreground);">登录后查看</a>`;
    return;
  }
  try {
    const playlists = await window.api.netease.userPlaylist(session.userId) || [];
    // 只显示用户自己创建的（网易云会顺带返回收藏的他人歌单）
    const mine = playlists.filter(p => p.creator && String(p.creator.userId) === String(session.userId));
    const list = mine.slice(1, 11); // 第一条是「我喜欢的音乐」已在主导航，跳过；最多 10 条
    if (!list.length) {
      userPlaylistsEl.innerHTML = `<a class="h-8 flex items-center text-xs rounded-md px-2 opacity-0 group-hover:opacity-100 transition-opacity" style="color:var(--muted-foreground);">暂无自建歌单</a>`;
      return;
    }
    userPlaylistsEl.innerHTML = list.map(p => `
      <a href="#/playlist/${p.id}" class="h-8 flex items-center text-xs rounded-md hover:bg-black/5 px-2 truncate opacity-0 group-hover:opacity-100 transition-opacity" style="color:var(--muted-foreground);" title="${window.ui.tracklist.escapeHtml(p.name)}">
        ${window.ui.tracklist.escapeHtml(p.name)}
      </a>
    `).join('');
  } catch (err) {
    console.warn('[app] 加载侧栏歌单失败:', err);
  }
}

// ---------- 「我的歌单」手动折叠/展开 ----------
// 与 CSS .collapsed + :hover 协同：用户点击标题切手动折叠态，鼠标移开会自动收回
document.getElementById('my-playlists-toggle').addEventListener('click', () => {
  const playlists = document.getElementById('user-playlists');
  const chevron = document.getElementById('my-playlists-chevron');
  playlists.classList.toggle('collapsed');
  chevron.classList.toggle('rotated');
});

// ---------- 窗口控件 ----------
document.getElementById('win-min').addEventListener('click', () => window.api.window.minimize());
// 最大化按钮：全屏态下点它 = 退出全屏（用户在播放页全屏后想从右上角退出）
// 否则按原行为在 最大化/还原 之间切换
document.getElementById('win-max').addEventListener('click', () => {
  if (window.api.window && typeof window.api.window.isFullScreen === 'function'
      && window.api.window.isFullScreen()) {
    window.api.window.toggleFullscreen();
  } else {
    window.api.window.maximize();
  }
});
document.getElementById('win-close').addEventListener('click', () => window.api.window.close());

// ===== 全屏状态变化：刷新「最大化」按钮图标（全屏时显示「退出全屏」语义的图标）=====
// 让用户能直观看到右上角按钮在全屏态下会退出全屏
function syncWinMaxIcon() {
  const btn = document.getElementById('win-max');
  if (!btn) return;
  const icon = btn.querySelector('i[data-lucide]');
  if (!icon) return;
  const isFull = window.api.window && typeof window.api.window.isFullScreen === 'function'
    && window.api.window.isFullScreen();
  const name = isFull ? 'minimize-2' : 'maximize';
  icon.setAttribute('data-lucide', name);
  if (window.lucide) window.lucide.createIcons();
}
if (window.api.window && typeof window.api.window.onFullscreenChange === 'function') {
  window.api.window.onFullscreenChange(() => syncWinMaxIcon());
}

// 设置按钮：路由到设置页
document.getElementById('btn-settings').addEventListener('click', () => {
  window.location.hash = '#/settings';
});

// ---------- player 状态变化时刷新视图以高亮当前行 ----------
window.player.on('track-changed', () => {
  // 当前 view 是 favorites/daily/recent/playlist 时，重新渲染才能高亮新行——但避免重渲染打断滚动
  // 简单起见：只更新 DOM 中已有行的 active 标记
  const cur = window.player.current();
  if (!cur) return;
  // ===== 修复：序号 NaN bug =====
  // 原代码用 row.dataset.index，但行上只有 data-base-index（原始顺序下标），
  // parseInt(undefined,10)=NaN，导致切换歌曲后所有行序号显示"NaN"。
  // 现改为：用行在 tbody 里的 DOM 位置（即排序后的可见位置）作为序号。
  document.querySelectorAll('tbody').forEach(tbody => {
    const rows = Array.from(tbody.querySelectorAll('tr.track-row'));
    rows.forEach((row, i) => {
      const isCurrent = row.dataset.id === String(cur.id);
      row.dataset.current = isCurrent ? 'true' : 'false';
      const firstCell = row.querySelector('td');
      if (firstCell) {
        firstCell.innerHTML = isCurrent
          ? `<i data-lucide="volume-2" class="w-4 h-4" style="color:var(--primary);"></i>`
          : `<span>${i + 1}</span>`;
      }
    });
  });
  refreshIcons();
});

// ---------- 路由监听 + 启动 ----------
window.addEventListener('hashchange', route);

// 返回上一级：从浏览历史栈弹出上一项，回到其 hash
if (navBackBtn) {
  navBackBtn.addEventListener('click', () => {
    const prev = popRouteHistory();
    if (!prev) return;
    isNavigatingBack = true;
    // 重建 hash，让路由匹配上一页
    const targetHash = buildHash(prev);
    if (targetHash && `#${targetHash}` !== window.location.hash) {
      window.location.hash = targetHash;
    } else {
      // 已经在目标页：直接刷新可见性
      updateNavBackVisibility();
      isNavigatingBack = false;
    }
  });
  // 初始隐藏
  navBackBtn.style.visibility = 'hidden';
  navBackBtn.style.opacity = '0';
  navBackBtn.style.transition = 'opacity 0.2s ease';
}
function buildHash(entry) {
  if (!entry) return '';
  const { view, params } = entry;
  if (view === 'playlist' && params && params.id) return `/playlist/${params.id}`;
  if (view === 'artist' && params && params.id) return `/artist/${params.id}`;
  if (view === 'album' && params && params.id) return `/album/${params.id}`;
  if (view === 'search') {
    const q = params && params.q ? `?q=${encodeURIComponent(params.q)}` : '';
    return `/search${q}`;
  }
  return `/${view}`;
}

async function bootstrap() {
  refreshIcons();
  // 恢复浏览历史（同会话内有效）
  routeHistory = loadRouteHistory();
  updateNavBackVisibility();
  await applyBackground();
  // 启动时校验登录态：清掉旧版 bug 残留的匿名 cookie
  await validateSession();
  await refreshUserChip();
  await loadSidebarPlaylists();
  // 绑定全屏播放页到 player
  if (window.nowPlaying && window.nowPlaying.bindToPlayer) {
    window.nowPlaying.bindToPlayer();
  }
  // 默认进入 #/favorites（或当前 hash）
  if (!window.location.hash) window.location.hash = '#/favorites';
  else await route();
}

bootstrap();
// 显式触发首次路由（即便 hash 已存在，bootstrap 也会调 route）
window.addEventListener('load', route);
