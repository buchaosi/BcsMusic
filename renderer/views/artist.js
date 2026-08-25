// 歌手详情视图：#/artist/:id
// 展示：头像、歌手名、单曲数/专辑数/MV数、选项卡（歌曲列表/专辑列表/MV列表）
// 顶部「热门 50 首」按歌曲推荐形式展示
// 加载时使用逐字标题 + 封面淡入，弱化加载感

// 关注按钮逻辑：已关注显示「取消关注」，未关注显示「关注」
async function initArtistSubButton(container, id, artist) {
  const api = window.api;
  const btn = container.querySelector('#artist-sub-btn');
  if (!btn) return;

  // 先看响应里是否直接带 followed 字段
  let subed = (artist && typeof artist.followed === 'boolean') ? artist.followed
    : (artist && typeof artist.subed === 'boolean') ? artist.subed : null;

  // 响应没带时，查 artist_sublist 确认
  if (subed === null) {
    try {
      const list = await api.netease.artistSublist({ limit: 100, offset: 0 }) || [];
      subed = list.some(a => String(a.id) === String(id));
    } catch (err) {
      subed = false;
    }
  }

  function renderBtn(isSubed) {
    btn.disabled = false;
    btn.classList.remove('opacity-50');
    btn.innerHTML = isSubed
      ? `<i data-lucide="user-check" class="w-4 h-4"></i>取消关注`
      : `<i data-lucide="user-plus" class="w-4 h-4"></i>关注`;
    if (window.lucide) window.lucide.createIcons();
  }
  renderBtn(subed);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i>处理中…`;
    if (window.lucide) window.lucide.createIcons();
    const newSubed = !subed;
    try {
      await api.netease.artistSub(id, newSubed ? 1 : 0);
      subed = newSubed;
      renderBtn(subed);
      if (window.toast) window.toast(newSubed ? '已关注歌手' : '已取消关注');
    } catch (err) {
      if (window.toast) window.toast('操作失败：' + (err.message || ''));
      renderBtn(subed);
    }
  });
}

async function mountArtist(container, params) {
  const api = window.api;
  const ui = window.ui.tracklist;
  const id = params && params.id;
  if (!id) {
    container.innerHTML = ui.renderError('缺少歌手 ID');
    return;
  }

  // 占位渲染：先放骨架，标题留空（逐字动画在路由滚入后触发）
  container.innerHTML = `
    <section class="flex items-end gap-6 px-8 py-8">
      <div class="w-44 h-44 rounded-2xl overflow-hidden skeleton flex-shrink-0" id="artist-cover-wrap"></div>
      <div class="flex flex-col gap-3">
        <span class="text-xs font-semibold uppercase tracking-wider" style="color:var(--primary);">歌手</span>
        <h1 class="text-3xl font-semibold tracking-tight" id="artist-title" style="color:var(--foreground);"></h1>
        <p class="text-sm max-w-xl" id="artist-meta" style="color:var(--muted-foreground);">正在获取歌手信息…</p>
        <div class="flex items-center gap-3 mt-1">
          <button id="artist-play-all" class="h-9 px-5 rounded-lg text-sm flex items-center gap-1.5" style="background:var(--primary);color:var(--primary-foreground);" disabled>
            <i data-lucide="play" class="w-4 h-4"></i>全部播放
          </button>
          <button id="artist-sub-btn" class="h-9 px-4 rounded-lg text-sm flex items-center gap-1.5 opacity-50" disabled style="background:color-mix(in srgb, var(--primary) 10%, transparent); border:1px solid color-mix(in srgb, var(--primary) 30%, transparent); color:var(--primary);">
            <i data-lucide="user-plus" class="w-4 h-4"></i>关注
          </button>
        </div>
      </div>
    </section>
    <section class="px-8 pb-8" id="artist-tabs-wrap"></section>
  `;

  const titleEl = container.querySelector('#artist-title');
  const metaEl = container.querySelector('#artist-meta');
  const coverWrap = container.querySelector('#artist-cover-wrap');

  // 路由动画完成后给容器打标记（逐字必须在这之后才启动）
  if (container.dataset.routeAnimateDone !== '1') {
    const markRouteDone = (evt) => {
      const detail = (evt && evt.detail) || {};
      if (detail.view && detail.view !== 'artist') return;
      window.removeEventListener('app:route-animation-done', markRouteDone);
      container.dataset.routeAnimateDone = '1';
    };
    window.addEventListener('app:route-animation-done', markRouteDone);
  }

  let detail, topSongs = [], albums = [], mvs = [];
  try {
    detail = await api.netease.artistDetail(id);
  } catch (err) {
    container.innerHTML = ui.renderError(err.message);
    return;
  }
  // detail 形状：{ artist: { id, name, cover, ... }, albumSize, musicSize, mvSize, ... }
  const artist = (detail && detail.artist) || detail || {};
  const name = artist.name || '歌手';
  const cover = artist.cover || artist.picUrl || artist.img1v1Url || '';
  const singles = (detail && detail.musicSize) || (artist.musicSize) || 0;
  const albumCount = (detail && detail.albumSize) || (artist.albumSize) || 0;
  const mvCount = (detail && detail.mvSize) || (artist.mvSize) || 0;

  // 标题先留空：绝对不要一开始就有字（用户要求"不要一开始就有字"）
  if (titleEl) titleEl.textContent = '';
  metaEl.textContent = `${singles} 首单曲 · ${albumCount} 张专辑 · ${mvCount} 个 MV`;
  // 封面淡入
  ui.fadeInCover(coverWrap, cover ? cover.replace(/http:/, 'https:') + '?param=300x300' : '', name);

  // 关注按钮：检查是否已关注（artist.followed 优先，否则查 sublist）
  initArtistSubButton(container, id, artist);

  // 启用顶部「全部播放」按钮（先 disabled，拉到歌曲后启用）
  const playAllBtn = container.querySelector('#artist-play-all');
  if (playAllBtn) {
    playAllBtn.disabled = true; // 等 songs 加载完再启用
  }

  // 并行拉取三类内容：歌曲用 artistSongs 分页（首屏 50 首）
  const PAGE = 50;
  let songsPage = { items: [], total: 0, loading: false, exhausted: false };
  const tasks = [
    api.netease.artistSongs(id, { limit: PAGE, offset: 0, order: 'hot' }).catch(() => null),
    api.netease.artistAlbum(id, { limit: 30, offset: 0 }).catch(() => []),
    api.netease.artistMv(id, { limit: 30, offset: 0 }).catch(() => []),
  ];
  const [songsBody, albumsBody, mvsBody] = await Promise.all(tasks);
  albums = albumsBody || [];
  mvs = mvsBody || [];
  // artist_songs 返回可能是 [songs]、{ songs, total } 或嵌套 { result: { songs, total } }
  if (Array.isArray(songsBody)) {
    topSongs = songsBody;
    songsPage.items = songsBody;
    songsPage.total = songsBody.length;
    songsPage.exhausted = songsBody.length < PAGE;
  } else if (songsBody) {
    const payload = songsBody.result || songsBody;
    const arr = (payload && payload.songs) || songsBody.songs;
    if (Array.isArray(arr)) {
      const t = (payload && payload.total != null) ? payload.total : songsBody.total;
      songsPage.items = arr;
      songsPage.total = (t != null) ? t : arr.length;
      // 更可靠的 exhausted 判断：返回的数量 < PAGE 则说明没有下一页
      songsPage.exhausted = arr.length < PAGE || songsPage.items.length >= songsPage.total;
      topSongs = arr;
    }
  }
  if (!topSongs.length) {
    // 回退到 top song（仅 50 首，无分页元数据）
    topSongs = songsBody || [];
    songsPage.exhausted = true;
  }
  if (!topSongs.length) {
    // 兜底：用 artistTopSong
    topSongs = await api.netease.artistTopSong(id).catch(() => []);
    songsPage.items = topSongs;
    songsPage.exhausted = true;
  }

  // 渲染选项卡容器
  const tabsWrap = container.querySelector('#artist-tabs-wrap');
  tabsWrap.innerHTML = `
    <div class="flex items-center gap-6 mb-4" id="artist-tab-bar" style="border-bottom:1px solid color-mix(in srgb, #000000 8%, transparent);">
      <button class="artist-tab py-3 text-sm font-medium" data-tab="songs" style="color:var(--primary); border-bottom:2px solid var(--primary);">歌曲 ${songsPage.total || topSongs.length}</button>
      <button class="artist-tab py-3 text-sm font-medium" data-tab="albums" style="color:var(--muted-foreground);">专辑 ${albums.length}</button>
      <button class="artist-tab py-3 text-sm font-medium" data-tab="mvs" style="color:var(--muted-foreground);">MV ${mvs.length}</button>
    </div>
    <div id="artist-tab-content"></div>
  `;

  // 启用顶部「全部播放」按钮：点击后用 topSongs 设置队列并从第一首开始
  if (playAllBtn && topSongs.length) {
    playAllBtn.disabled = false;
    playAllBtn.addEventListener('click', () => {
      if (window.player) window.player.setQueue(topSongs, 0);
    });
  }

  const tabContent = tabsWrap.querySelector('#artist-tab-content');
  const tabBtns = tabsWrap.querySelectorAll('.artist-tab');

  let _firstSongsRendered = false;
  function renderSongs() {
    if (!songsPage.items.length) {
      tabContent.innerHTML = ui.renderEmpty({ icon: 'music', title: '暂无歌曲' });
    } else {
      const tl = ui.renderTracklist(songsPage.items);
      tabContent.innerHTML = tl.html;
      tl.bind(tabContent);
      if (window.lucide) window.lucide.createIcons();
      // 拉到底显示更多按钮
      if (!songsPage.exhausted) {
        const more = document.createElement('div');
        more.className = 'flex justify-center py-4';
        more.innerHTML = `<button id="artist-load-more" class="px-4 h-9 rounded-lg text-sm flex items-center gap-1.5" style="background:color-mix(in srgb, var(--primary) 10%, transparent); border:1px solid color-mix(in srgb, var(--primary) 30%, transparent); color:var(--primary);"><i data-lucide="chevron-down" class="w-3.5 h-3.5"></i>加载更多（${songsPage.items.length}/${songsPage.total || songsPage.items.length}）</button>`;
        tabContent.appendChild(more);
        const btn = more.querySelector('#artist-load-more');
        btn.addEventListener('click', () => loadMoreSongs());
        if (window.lucide) window.lucide.createIcons();
      }
    }
    // ===== 首次渲染出内容后 + 路由滚入动画完成：才开始标题逐字出现 =====
    // （两个条件同时满足：首屏内容渲染完 → 用户看到了列表；滚动完成 → 容器 opacity 已经是 1）
    if (!_firstSongsRendered) {
      _firstSongsRendered = true;
      const tryStartTyping = () => {
        if (!titleEl) return;
        titleEl.textContent = '';
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            ui.animateTextSwap(titleEl, '', name, { delay: 0 });
          });
        });
      };
      if (container.dataset.routeAnimateDone === '1') {
        tryStartTyping();
      } else {
        const onRouteDone = (evt) => {
          const detail = (evt && evt.detail) || {};
          if (detail.view && detail.view !== 'artist') return;
          window.removeEventListener('app:route-animation-done', onRouteDone);
          if (container && container.parentNode) tryStartTyping();
        };
        window.addEventListener('app:route-animation-done', onRouteDone);
        // 兜底：3 秒后还没收到事件就直接打字
        setTimeout(() => {
          if (titleEl && !titleEl.textContent) {
            window.removeEventListener('app:route-animation-done', onRouteDone);
            tryStartTyping();
          }
        }, 3000);
      }
    }
  }
  async function loadMoreSongs() {
    if (songsPage.loading || songsPage.exhausted) return;
    songsPage.loading = true;
    const btn = tabContent.querySelector('#artist-load-more');
    if (btn) btn.innerHTML = `<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i>加载中…`;
    if (window.lucide) window.lucide.createIcons();
    try {
      const offset = songsPage.items.length;
      const res = await api.netease.artistSongs(id, { limit: PAGE, offset, order: 'hot' });
      // 兼容嵌套返回结构
      let more;
      if (Array.isArray(res)) more = res;
      else {
        const payload = (res && res.result) || res;
        more = (payload && payload.songs) || (res && res.songs) || [];
        const t = (payload && payload.total != null) ? payload.total : (res && res.total);
        if (t != null) songsPage.total = t;
      }
      songsPage.items = songsPage.items.concat(more);
      if (!songsPage.total) songsPage.total = songsPage.items.length;
      if (more.length < PAGE || songsPage.items.length >= songsPage.total) {
        songsPage.exhausted = true;
      }
    } catch (err) {
      window.toast && window.toast('加载更多失败');
    } finally {
      songsPage.loading = false;
      renderSongs();
    }
  }
  function renderAlbums() {
    if (!albums.length) {
      tabContent.innerHTML = ui.renderEmpty({ icon: 'disc', title: '暂无专辑' });
      return;
    }
    const html = albums.map(a => {
      const c = a.picUrl || a.coverImgUrl || '';
      return `
        <a href="#/album/${a.id}" class="playlist-card flex flex-col" data-id="${a.id}">
          <div class="aspect-square overflow-hidden ${c ? '' : 'skeleton'}">
            ${c ? `<img src="${c.replace(/http:/, 'https:')}?param=300x300" alt="${ui.escapeHtml(a.name)}" class="w-full h-full object-cover" style="opacity:0;transition:opacity 0.4s ease;" onload="this.style.opacity='1';this.parentElement.classList.remove('skeleton');" onerror="this.parentElement.classList.add('skeleton');this.remove();">` : ''}
          </div>
          <div class="p-3 flex flex-col gap-1">
            <span class="text-sm font-medium truncate" style="color:var(--foreground);">${ui.escapeHtml(a.name)}</span>
            <span class="text-xs" style="color:var(--muted-foreground);">${a.publishTime ? new Date(a.publishTime).getFullYear() : ''}</span>
          </div>
        </a>
      `;
    }).join('');
    tabContent.innerHTML = `<div class="grid gap-4" style="grid-template-columns:repeat(auto-fill, minmax(160px, 1fr));">${html}</div>`;
  }
  function renderMvs() {
    if (!mvs.length) {
      tabContent.innerHTML = ui.renderEmpty({ icon: 'video', title: '暂无 MV' });
      return;
    }
    const html = mvs.map(m => {
      const c = (m.imgurl16v9 || m.cover || m.picUrl || '');
      const playCount = m.playCount != null ? m.playCount : (m.count || null);
      return `
        <a href="#/mv/${m.id}" class="playlist-card flex flex-col group" data-id="${m.id}" style="text-decoration:none;">
          <div class="aspect-video overflow-hidden relative ${c ? '' : 'skeleton'}">
            ${c ? `<img src="${c.replace(/http:/, 'https:')}" alt="${ui.escapeHtml(m.name)}" class="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500 ease-out" style="opacity:0;transition:opacity 0.4s ease,transform 0.5s ease;" onload="this.style.opacity='1';this.parentElement.classList.remove('skeleton');" onerror="this.parentElement.classList.add('skeleton');this.remove();">` : ''}
            <!-- MV 播放图标覆盖层（hover 显现） -->
            <div class="absolute inset-0 flex items-center justify-center" style="background:rgba(0,0,0,0);transition:background 0.25s ease;">
              <div class="mv-card-play flex items-center justify-center rounded-full" style="width:56px;height:56px;background:rgba(0,122,255,0.92);opacity:0;transform:scale(0.9);transition:opacity 0.25s ease,transform 0.25s ease;box-shadow:0 8px 24px -6px rgba(0,122,255,0.6);">
                <i data-lucide="play" style="width:24px;height:24px;color:#fff;margin-left:3px;"></i>
              </div>
            </div>
            <!-- 时长 / 播放数角标 -->
            <div class="absolute bottom-2 right-2 flex items-center gap-2">
              ${playCount != null ? `<span class="text-[11px] font-medium px-2 py-0.5 rounded-md flex items-center gap-1" style="background:rgba(0,0,0,0.6);color:#fff;"><i data-lucide="play-circle" class="w-3 h-3"></i>${formatCountShort(playCount)}</span>` : ''}
            </div>
          </div>
          <div class="p-3 flex flex-col gap-1">
            <span class="text-sm font-medium truncate group-hover:underline decoration-dotted underline-offset-2" style="color:var(--foreground);">${ui.escapeHtml(m.name)}</span>
            <span class="text-xs" style="color:var(--muted-foreground);">${m.publishTime ? new Date(m.publishTime).toLocaleDateString() : ''}</span>
          </div>
        </a>
      `;
    }).join('');
    tabContent.innerHTML = `<div class="grid gap-4" style="grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));">${html}</div>`;
    // hover 覆盖层 + 图标显现
    tabContent.querySelectorAll('.playlist-card').forEach(card => {
      card.addEventListener('mouseenter', () => {
        const ov = card.querySelector('.absolute.inset-0');
        const p = card.querySelector('.mv-card-play');
        if (ov) ov.style.background = 'rgba(0,0,0,0.22)';
        if (p) { p.style.opacity = '1'; p.style.transform = 'scale(1)'; }
      });
      card.addEventListener('mouseleave', () => {
        const ov = card.querySelector('.absolute.inset-0');
        const p = card.querySelector('.mv-card-play');
        if (ov) ov.style.background = 'rgba(0,0,0,0)';
        if (p) { p.style.opacity = '0'; p.style.transform = 'scale(0.9)'; }
      });
    });
    if (window.lucide) window.lucide.createIcons();
  }

  function setActiveTab(tab) {
    tabBtns.forEach(b => {
      const active = b.dataset.tab === tab;
      b.style.color = active ? 'var(--primary)' : 'var(--muted-foreground)';
      b.style.borderBottom = active ? '2px solid var(--primary)' : '2px solid transparent';
    });
    if (tab === 'songs') renderSongs();
    else if (tab === 'albums') renderAlbums();
    else if (tab === 'mvs') renderMvs();
  }
  tabBtns.forEach(b => b.addEventListener('click', () => setActiveTab(b.dataset.tab)));
  setActiveTab('songs');
}

window.views = window.views || {};
window.views.artist = { mount: mountArtist };

function formatCountShort(n) {
  if (!isFinite(n) || n < 0) return '0';
  if (n < 10000) return String(n);
  if (n < 100000000) return (n / 10000).toFixed(n % 10000 === 0 ? 0 : 1) + '万';
  return (n / 100000000).toFixed(n % 100000000 === 0 ? 0 : 1) + '亿';
}
