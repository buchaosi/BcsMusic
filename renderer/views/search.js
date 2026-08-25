// 搜索视图：支持热搜榜（无查询时展示）+ 搜索结果（曲目表，分页加载）
// 路由：#/search?q=关键词
const SEARCH_PAGE = 30;
let _searchState = { q: '', items: [], total: 0, loading: false, exhausted: false };

async function mountSearch(container, params) {
  const api = window.api;
  const ui = window.ui.tracklist;
  const q = (params && params.q || '').trim();

  // 重置分页状态（每次进入搜索页都重新开始）
  _searchState = { q, items: [], total: 0, loading: false, exhausted: false };

  if (!q) {
    // 无查询词：展示热搜榜
    await renderHotSearch(container);
    return;
  }

  // 有查询词：执行搜索
  // 搜索结果不展示封面框（用户明确要求）：只用标题 + 骨架列表
  container.innerHTML = `
    <section class="px-8 py-8">
      <div class="flex flex-col gap-3">
        <span class="text-xs font-semibold uppercase tracking-wider" style="color:var(--primary);">搜索结果</span>
        <h1 class="text-3xl font-semibold tracking-tight" id="sr-title" style="color:var(--foreground);"></h1>
        <p class="text-sm max-w-xl" id="sr-meta" style="color:var(--muted-foreground);">搜索中…</p>
      </div>
    </section>
    <section class="px-8 pb-8" id="tracklist-wrap"><div class="skeleton h-64 rounded-2xl"></div></section>
  `;
  // 标题先置空：不要一开始就有字，等搜索结果渲染出来后再逐字出现
  const titleEl = container.querySelector('#sr-title');
  if (titleEl) titleEl.textContent = '';

  // 路由动画完成后，给容器打标记 + 保留事件以便后续首屏渲染完后立刻逐字
  const markRouteDone = (evt) => {
    const detail = (evt && evt.detail) || {};
    if (detail.view && detail.view !== 'search') return;
    window.removeEventListener('app:route-animation-done', markRouteDone);
    container.dataset.routeAnimateDone = '1';
  };
  if (container.dataset.routeAnimateDone !== '1') {
    window.addEventListener('app:route-animation-done', markRouteDone);
  }

  await loadSearchPage(container);
}

// 加载一页搜索结果并追加渲染
async function loadSearchPage(container) {
  const api = window.api;
  const ui = window.ui.tracklist;
  const { q, items, loading, exhausted } = _searchState;
  if (loading || exhausted || !q) return;

  const isFirstPage = items.length === 0;
  _searchState.loading = true;
  const wrap = container.querySelector('#tracklist-wrap');
  const metaEl = container.querySelector('#sr-meta');

  // 首页：骨架；后续页：在底部加加载指示
  const offset = items.length;
  if (offset === 0) {
    wrap.innerHTML = `<div class="skeleton h-64 rounded-2xl"></div>`;
  } else {
    wrap.insertAdjacentHTML('beforeend', `<div id="sr-loading-more" class="py-4 text-center text-sm" style="color:var(--muted-foreground);"><i data-lucide="loader-2" class="w-4 h-4 animate-spin inline-block"></i> 加载中…</div>`);
    if (window.lucide) window.lucide.createIcons();
  }

  try {
    const result = await api.netease.search(q, { type: 1, limit: SEARCH_PAGE, offset });
    // 兼容多种返回格式：
    // 1) { songs: [...], songCount: N }
    // 2) { result: { songs: [...], songCount: N } }
    // 3) { code: 200, result: { songs: [...], songCount: N } }
    const payload = (result && result.result) || result;
    const songs = (payload && payload.songs) || (result && result.songs) || [];
    // songCount 可能在 payload.songCount 或 payload.result.songCount
    let songCount = null;
    if (payload && payload.songCount != null) songCount = payload.songCount;
    else if (result && result.songCount != null) songCount = result.songCount;
    else if (payload && payload.result && payload.result.songCount != null) songCount = payload.result.songCount;
    if (songCount != null && songCount > 0) {
      _searchState.total = songCount;
    } else if (!_searchState.total) {
      _searchState.total = songs.length;
    }
    _searchState.items = items.concat(songs);
    // 如果返回的歌曲数 < 每页限制，说明已经到末尾
    if (songs.length < SEARCH_PAGE) _searchState.exhausted = true;
    else _searchState.exhausted = _searchState.items.length >= _searchState.total;

    if (!_searchState.items.length) {
      wrap.innerHTML = ui.renderEmpty({ icon: 'search', title: `没有找到与“${q}”相关的歌曲` });
      if (metaEl) metaEl.textContent = '无结果';
      _searchState.loading = false;
      return;
    }

    if (metaEl) {
      const total = _searchState.total || _searchState.items.length;
      metaEl.textContent = `${_searchState.items.length}/${total} 首歌曲`;
    }

    // 重新渲染整个列表（歌曲数不多，重渲染开销可接受）
    ui.bindPlayAll(container, _searchState.items);
    const tl = ui.renderTracklist(_searchState.items);
    wrap.innerHTML = tl.html;
    tl.bind(wrap);

    // 还有更多：追加「查看更多」按钮
    if (!_searchState.exhausted) {
      const remaining = Math.max(0, (_searchState.total || 0) - _searchState.items.length);
      wrap.insertAdjacentHTML('beforeend', `
        <div class="flex justify-center py-4">
          <button id="sr-load-more" class="px-4 h-9 rounded-lg text-sm flex items-center gap-1.5" style="background:color-mix(in srgb, var(--primary) 10%, transparent); border:1px solid color-mix(in srgb, var(--primary) 30%, transparent); color:var(--primary);"><i data-lucide="chevron-down" class="w-3.5 h-3.5"></i>查看更多${remaining > 0 ? `（剩余 ${remaining} 首）` : ''}</button>
        </div>`);
      if (window.lucide) window.lucide.createIcons();
      const btn = wrap.querySelector('#sr-load-more');
      if (btn) btn.addEventListener('click', () => loadSearchPage(container));
    }

    // ====== 首页加载完成后 + 路由滚入动画完成后：才开始标题逐字动画 ======
    // （不要一开始就有字；不要在 opacity:0 时用户看不到逐字地后台打字）
    if (isFirstPage) {
      const titleEl = container.querySelector('#sr-title');
      if (titleEl) titleEl.textContent = '';
      const tryStart = () => {
        if (!titleEl) return;
        titleEl.textContent = '';
        // 再等 1 帧让 DOM 稳定
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            ui.animateTextSwap(titleEl, '', `“${q}”`, { delay: 0 });
          });
        });
      };
      // 如果路由动画已完成（或没有），直接开始；否则等路由完成事件
      if (container.dataset.routeAnimateDone === '1') {
        tryStart();
      } else {
        const onRouteDone = (evt) => {
          const detail = (evt && evt.detail) || {};
          // 过滤只处理当前 view 的完成事件
          if (detail.view && detail.view !== 'search') return;
          window.removeEventListener('app:route-animation-done', onRouteDone);
          if (container && container.parentNode) tryStart();
        };
        window.addEventListener('app:route-animation-done', onRouteDone);
        // 兜底：如果 3 秒后还没收到路由完成事件（比如首屏直接访问 hash），直接开始
        setTimeout(() => {
          if (titleEl && !titleEl.textContent) {
            window.removeEventListener('app:route-animation-done', onRouteDone);
            tryStart();
          }
        }, 3000);
      }
    }
    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    wrap.innerHTML = ui.renderError(err.message);
  } finally {
    _searchState.loading = false;
  }
}

// 热搜榜：网易云 /search/hot/detail，含排名、热搜词、图标
async function renderHotSearch(container) {
  container.innerHTML = `
    <section class="px-8 py-8">
      <div class="flex flex-col gap-3">
        <span class="text-xs font-semibold uppercase tracking-wider" style="color:var(--primary);">热搜榜</span>
        <h1 class="text-3xl font-semibold tracking-tight" style="color:var(--foreground);">热门搜索</h1>
        <p class="text-sm max-w-xl" style="color:var(--muted-foreground);">来自网易云实时热搜榜</p>
      </div>
    </section>
    <section class="px-8 pb-8" id="hot-wrap">
      <div class="grid gap-2" style="grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));">
        ${Array.from({length: 8}).map(() => `<div class="skeleton h-12 rounded-lg"></div>`).join('')}
      </div>
    </section>
  `;

  try {
    const hot = await window.api.netease.searchHot() || [];
    if (!hot.length) {
      container.querySelector('#hot-wrap').innerHTML =
        ui.renderEmpty({ icon: 'flame', title: '暂无热搜数据' });
      return;
    }
    const items = hot.map((h, i) => {
      const rank = i + 1;
      const isTop3 = rank <= 3;
      const color = isTop3 ? 'var(--destructive)' : 'var(--muted-foreground)';
      const icon = h.iconUrl ? `<img src="${h.iconUrl}" class="w-4 h-4" alt="">` : '';
      return `
        <div class="hot-item flex items-center gap-3 h-12 px-4 rounded-lg cursor-pointer hover:bg-black/5 transition-colors" data-q="${ui.escapeHtml(h.searchWord)}" style="background:color-mix(in srgb, #ffffff 60%, transparent); border:1px solid color-mix(in srgb, #ffffff 50%, transparent);">
          <span class="text-sm font-bold w-6 text-center" style="color:${color};">${rank}</span>
          <div class="flex-1 min-w-0">
            <span class="text-sm font-medium truncate" style="color:var(--foreground);">${ui.escapeHtml(h.searchWord)}</span>
            ${h.content ? `<p class="text-xs truncate" style="color:var(--muted-foreground);">${ui.escapeHtml(h.content)}</p>` : ''}
          </div>
          ${icon}
          ${h.score ? `<span class="text-xs" style="color:var(--muted-foreground);">${h.score}</span>` : ''}
        </div>
      `;
    }).join('');
    const wrap = container.querySelector('#hot-wrap');
    wrap.innerHTML = `<div class="grid gap-2" style="grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));">${items}</div>`;
    wrap.querySelectorAll('.hot-item').forEach(el => {
      el.addEventListener('click', () => {
        const kw = el.dataset.q;
        if (kw) {
          // 推到本地历史搜索（与回车搜索一致）
          if (typeof window.pushSearchHistory === 'function') window.pushSearchHistory(kw);
          document.getElementById('search-input').value = kw;
          window.location.hash = `#/search?q=${encodeURIComponent(kw)}`;
        }
      });
    });
  } catch (err) {
    container.querySelector('#hot-wrap').innerHTML = ui.renderError(err.message);
  }
}

window.views = window.views || {};
window.views.search = { mount: mountSearch };
