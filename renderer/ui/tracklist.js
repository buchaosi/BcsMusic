// 通用曲目表渲染：复用原静态页的 <table> 结构，接受网易云 track 数组
// tracks: [{ id, name, ar/al/dt }, ...]  startIndex: 点击「全部播放」的起点
// onPlay: 自定义点击行回调（默认调 window.player.setQueue(tracks, i)）
// sortable: 是否启用列头排序（默认 true）；onSortChange(sortSpec) 排序变更回调
//   sortSpec = { key: 'default'|'name'|'artist'|'album'|'duration', direction: 'asc'|'desc'|null }
// 排序规则：
//   key = default            —— 保持 tracks 原始顺序（如 API 返回的热度顺序）
//   key = name/artist/album  —— 拼音首字母（A-Z）不区分大小写；数字/符号按字符顺序；空串放末尾
//   key = duration           —— 按 getDurationMs 毫秒数比较
// 点击列头循环：默认 → 正序 → 倒序 → 默认（回到接口顺序）
function renderTracklist(tracks, { onPlay, startIndex = 0, playlistId, sortable = true, onSortChange, initialSort } = {}) {
  const baseTracks = Object.freeze(tracks ? tracks.slice() : []); // 原始顺序（不可变）
  // 每列的排序状态：独立维护「上一次方向」，保证从不同列切回时先默认再升序（网易云客户端的逻辑）
  const lastDirPerKey = Object.create(null);

  // 当前应用的排序规格；默认全量不排序
  const spec = (initialSort && typeof initialSort === 'object')
    ? { key: initialSort.key || 'default', direction: ['asc', 'desc'].includes(initialSort.direction) ? initialSort.direction : null }
    : { key: 'default', direction: null };

  function _getSortKeyText(t, key) {
    switch (key) {
      case 'name': return t.name || '';
      case 'artist':
        if (Array.isArray(t.ar) && t.ar[0] && t.ar[0].name) return t.ar.map(a => a.name || '').join('/');
        if (t.artists) return String(t.artists);
        return '';
      case 'album':
        if (t.al && t.al.name) return String(t.al.name);
        if (t.album && t.album.name) return String(t.album.name);
        return '';
      default: return '';
    }
  }

  function applySort(spec, arr) {
    if (!arr || !arr.length) return arr || [];
    if (spec.key === 'default' || spec.direction == null) {
      return baseTracks.slice();
    }
    const clone = arr.slice();
    if (spec.key === 'duration') {
      clone.sort((a, b) => {
        const da = getDurationMs(a), db = getDurationMs(b);
        let r = 0;
        if (da === db) r = 0;
        else if (da === 0) r = 1;     // 0（未知）排末
        else if (db === 0) r = -1;
        else r = da - db;
        return spec.direction === 'desc' ? -r : r;
      });
      return clone;
    }
    // name / artist / album：首字母不区分大小写排序
    const toPinyin = (typeof window !== 'undefined' && window.firstPinyinLetters) || ((s) => String(s));
    const fallbackCollator = (typeof Intl !== 'undefined' && Intl.Collator)
      ? new Intl.Collator('zh-Hans-CN', { sensitivity: 'base', numeric: true })
      : null;
    clone.sort((a, b) => {
      const ta = _getSortKeyText(a, spec.key);
      const tb = _getSortKeyText(b, spec.key);
      const emptyA = ta == null || ta === '';
      const emptyB = tb == null || tb === '';
      if (emptyA && emptyB) return 0;
      if (emptyA) return 1; // 空排末
      if (emptyB) return -1;
      let r = 0;
      const pa = toPinyin(ta).toUpperCase();
      const pb = toPinyin(tb).toUpperCase();
      if (pa !== pb) r = pa < pb ? -1 : 1;
      else if (fallbackCollator) r = fallbackCollator.compare(ta, tb);
      else r = ta.localeCompare ? ta.localeCompare(tb, 'zh-CN') : (ta < tb ? -1 : (ta > tb ? 1 : 0));
      return spec.direction === 'desc' ? -r : r;
    });
    return clone;
  }

  let workingTracks = applySort(spec, baseTracks);

  // 构建渲染（workingTracks → HTML 行），同时把原始行号写到 data-base-index（用于双击播放用 baseTracks）
  function renderRows(sortedArr) {
    const current = (window.player && window.player.current()) || null;
    const currentId = current && current.id;
    return (sortedArr || []).map((t) => {
      const baseIdx = baseTracks.indexOf(t);
      const name = t.name || '';
      const alias = (t.alia && t.alia[0]) || (t.tns && t.tns[0]) || '';
      const artist = (t.ar || []).map(a => a.name).join(' / ') || '—';
      const artists = t.ar || [];
      let artistCell;
      if (artists.length && artists[0] && artists[0].id) {
        artistCell = artists.map(a =>
          `<a href="#/artist/${a.id}" class="hover:underline" style="color:var(--muted-foreground);" data-nav="artist" data-artist-id="${a.id}">${escapeHtml(a.name)}</a>`
        ).join('<span style="color:var(--muted-foreground);"> / </span>');
      } else {
        artistCell = `<span style="color:var(--muted-foreground);">${escapeHtml(artist)}</span>`;
      }
      const album = (t.al && t.al.name) || (t.album && t.album.name) || '';
      const albumId = (t.al && t.al.id) || (t.album && t.album.id) || null;
      const cover = (t.al && t.al.picUrl) || (t.album && t.album.picUrl) || '';
      const dur = (window._playerFmtTime || fmtTime)(getDurationMs(t) / 1000);
      const isCurrent = t.id === currentId;
      const albumCell = albumId
        ? `<a href="#/album/${albumId}" class="hover:underline" style="color:var(--muted-foreground);" data-nav="album">${escapeHtml(album)}</a>`
        : `<span style="color:var(--muted-foreground);">${escapeHtml(album)}</span>`;
      return `
        <tr class="track-row h-14 cursor-pointer" data-base-index="${baseIdx}" data-id="${t.id}" ${isCurrent ? 'data-current="true"' : ''}>
          <td class="pl-5 rounded-tl-lg rounded-bl-lg" style="color:var(--muted-foreground);">
            ${isCurrent
              ? `<i data-lucide="volume-2" class="w-4 h-4" style="color:var(--primary);"></i>`
              : `<span>${sortedArr.indexOf(t) + 1}</span>`}
          </td>
          <td>
            <div class="w-9 h-9 rounded-lg overflow-hidden ${cover ? '' : 'skeleton'}">
              ${cover ? `<img src="${cover}?param=88x88" alt="封面" class="w-full h-full object-cover" style="opacity:0;transition:opacity 0.35s ease;" onload="this.style.opacity='1'" onerror="this.parentElement.classList.add('skeleton');this.remove();">` : ''}
            </div>
          </td>
          <td>
            <div class="flex flex-col">
              <span class="track-name font-medium" style="color:var(--foreground);">${escapeHtml(name)}</span>
              ${alias ? `<span class="text-xs" style="color:var(--muted-foreground);">${escapeHtml(alias)}</span>` : ''}
            </div>
          </td>
          <td>${artistCell}</td>
          <td class="hidden md:table-cell">${albumCell}</td>
          <td class="pr-5 text-right font-variant-numeric" style="color:var(--muted-foreground);">${dur}</td>
        </tr>
      `;
    }).join('');
  }

  function buildThead(spec) {
    const arrowHtml = (key) => {
      if (!sortable) return '';
      const isActive = spec.key === key && spec.direction != null;
      const dir = isActive ? spec.direction : '';
      const arrowUp = '▲';
      const arrowDown = '▼';
      return `<span class="th-sort ${isActive ? 'is-active' : ''} ${dir ? `is-${dir}` : ''}" aria-hidden="true">
        <span class="th-sort-up">${arrowUp}</span>
        <span class="th-sort-down">${arrowDown}</span>
      </span>`;
    };
    const thAttr = (key, extraClass = '') => `class="sortable-th ${extraClass}" data-sort-key="${key}" role="columnheader" aria-sort="${spec.key === key ? (spec.direction === 'desc' ? 'descending' : (spec.direction === 'asc' ? 'ascending' : 'none')) : 'none'}"`;
    return `
      <thead>
        <tr class="h-10" style="border-bottom:1px solid color-mix(in srgb, #000000 8%, transparent);">
          <th class="w-14 pl-5 font-normal" style="color:var(--muted-foreground);">序号</th>
          <th class="w-14"></th>
          <th ${thAttr('name')} class="font-normal" style="color:var(--muted-foreground);cursor:${sortable ? 'pointer' : 'default'};user-select:none;">歌曲${arrowHtml('name')}</th>
          <th ${thAttr('artist')} class="font-normal" style="color:var(--muted-foreground);cursor:${sortable ? 'pointer' : 'default'};user-select:none;">歌手${arrowHtml('artist')}</th>
          <th ${thAttr('album')} class="font-normal hidden md:table-cell" style="color:var(--muted-foreground);cursor:${sortable ? 'pointer' : 'default'};user-select:none;">专辑${arrowHtml('album')}</th>
          <th ${thAttr('duration')} class="w-20 pr-5 text-right font-normal" style="color:var(--muted-foreground);cursor:${sortable ? 'pointer' : 'default'};user-select:none;">时长${arrowHtml('duration')}</th>
        </tr>
      </thead>`;
  }

  function buildHtml(spec, sortedArr) {
    return `
      <div class="rounded-2xl overflow-hidden" style="background-color:color-mix(in srgb, #ffffff 72%, transparent); border:1px solid color-mix(in srgb, #ffffff 60%, transparent);">
        <table class="w-full text-left text-sm">
          ${buildThead(spec)}
          <tbody>${renderRows(sortedArr)}</tbody>
        </table>
      </div>
    `;
  }

  // 返回对象：html + bind，还暴露 getSpec() / setSpec() 便于外部（如 load more 追加后）重建
  const api = {
    html: buildHtml(spec, workingTracks),
    getSpec: () => Object.freeze({ key: spec.key, direction: spec.direction }),
    getSorted: () => workingTracks.slice(),
    getBase: () => baseTracks.slice(),
    bind(container) {
      // ===== 排序交互：绑定列头点击 =====
      if (sortable) {
        container.querySelectorAll('th.sortable-th').forEach(th => {
          th.addEventListener('click', (e) => {
            e.stopPropagation();
            const key = th.dataset.sortKey;
            if (!key) return;
            if (!['name', 'artist', 'album', 'duration'].includes(key)) return;
            // 状态机：null（默认）→ asc → desc → null（回到接口原序）；换列则从 asc 开始
            const last = spec.key === key ? spec.direction : (lastDirPerKey[key] || null);
            let nextDir;
            if (last == null) nextDir = 'asc';
            else if (last === 'asc') nextDir = 'desc';
            else nextDir = null;
            spec.key = nextDir == null ? 'default' : key;
            spec.direction = nextDir;
            lastDirPerKey[key] = nextDir;
            workingTracks = applySort(spec, baseTracks);
            // 原地重渲染 tbody + thead（保持动画、不闪烁，避免整个 innerHTML 清掉导致 icon 闪烁）
            const tableEl = container.querySelector('table');
            if (tableEl) {
              const newHtml = buildHtml(spec, workingTracks);
              const tmp = document.createElement('div');
              tmp.innerHTML = newHtml;
              const newTbl = tmp.querySelector('table');
              if (newTbl) {
                const oldHead = tableEl.querySelector('thead');
                const oldBody = tableEl.querySelector('tbody');
                const newHead = newTbl.querySelector('thead');
                const newBody = newTbl.querySelector('tbody');
                if (oldHead && newHead) oldHead.replaceWith(newHead);
                if (oldBody && newBody) oldBody.replaceWith(newBody);
                // 重建图标（lucide）
                if (window.lucide && typeof window.lucide.createIcons === 'function') {
                  window.lucide.createIcons({ root: tableEl });
                }
                // 重新绑定列头/行交互（DOM 已替换，旧事件失效）
                api.bind(container);
                if (typeof onSortChange === 'function') onSortChange(api.getSpec());
                return;
              }
            }
            // 兜底：整段 innerHTML
            container.innerHTML = buildHtml(spec, workingTracks);
            if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons({ root: container });
            api.bind(container);
            if (typeof onSortChange === 'function') onSortChange(api.getSpec());
          });
        });
      }

      // ===== 行交互 =====
      container.querySelectorAll('tr.track-row').forEach(row => {
        row.addEventListener('dblclick', (e) => {
          if (e.target.closest('[data-nav]')) return;
          const baseIdx = parseInt(row.dataset.baseIndex, 10);
          const id = row.dataset.id;
          // 优先从 workingTracks 找（排序后 workingTracks 与 baseTracks 仍共享同一个 track 对象）
          const t = (isFinite(baseIdx) ? baseTracks[baseIdx] : null) || workingTracks.find(x => x && String(x.id) === String(id));
          if (!t) return;
          const idxInWorking = workingTracks.indexOf(t);
          if (onPlay) onPlay(idxInWorking >= 0 ? idxInWorking : 0, workingTracks);
          else if (window.player) window.player.setQueue(workingTracks, idxInWorking >= 0 ? idxInWorking : 0);
        });
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const baseIdx = parseInt(row.dataset.baseIndex, 10);
          const id = row.dataset.id;
          const t = (isFinite(baseIdx) ? baseTracks[baseIdx] : null) || workingTracks.find(x => x && String(x.id) === String(id));
          if (!t) return;
          if (window.ui && window.ui.contextMenu && window.ui.contextMenu.showForTrack) {
            window.ui.contextMenu.showForTrack(t, workingTracks, e.clientX, e.clientY, { playlistId });
          }
        });
        row.querySelectorAll('[data-nav]').forEach(link => {
          link.addEventListener('click', (e) => { e.stopPropagation(); });
        });
      });
    },
  };
  return api;
}

// 鲁棒化时长解析：从 track 对象中提取毫秒数
// 网易云不同接口返回的字段名/单位不同：
//   t.dt        毫秒（playlist_detail / cloudsearch / recommend_songs）
//   t.duration  毫秒或秒（< 1e5 视为秒）
//   字段可能是 string 类型，需 parseFloat
function getDurationMs(t) {
  if (!t) return 0;
  // 网易云不同接口返回的字段名/嵌套层级不同
  // 尝试所有可能的字段路径
  const candidates = [
    t.dt, t.duration, t.duration_ms, t.time,
    // 嵌套在 song 对象里（某些接口返回 { song: { dt } }）
    t.song && t.song.dt, t.song && t.song.duration,
    // privilege 或其他嵌套
    t.privilege && t.privilege.dt,
  ];
  for (const v of candidates) {
    if (v == null) continue;
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n) || n <= 0) continue;
    // 阈值 100,000：< 1e5 视为秒（歌曲毫秒数一般 > 30,000）
    const ms = n < 100000 ? n * 1000 : n;
    // ===== 与 player.getDurationSec 同步：最终 ms < 5000 视为试听片段/错误值/1ms 假时长
    // 直接丢弃返回 0，避免「0:01 / 0:01」这种"1/1"显示（用户报告的问题）*/
    const final = ms < 5000 ? 0 : ms;
    // 调试打点：记录原始字段与最终判定，<5000 的可疑值强制记录
    if (window.bcsLog) {
      const suspicious = final === 0;
      window.bcsLog('tracklist.getDurationMs', {
        id: t.id, name: t.name,
        rawValue: v, parsed: n, computedMs: ms, final,
        suspicious,
      }, { dedupe: true });
    }
    return final;
  }
  // 所有候选字段都没有有效值
  if (window.bcsLog) {
    window.bcsLog('tracklist.getDurationMs', {
      id: t.id, name: t.name,
      decision: 'no duration field, return 0',
    }, { dedupe: true });
  }
  return 0;
}

function fmtTime(sec) {
  if (!sec || !isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function renderHero({ cover, badge, title, meta, onPlayAll, tracks, id }) {
  const totalDur = (tracks || []).reduce((s, t) => s + getDurationMs(t), 0) / 1000;
  const metaText = meta || (tracks
    ? `BcsMusic · ${tracks.length} 首歌曲 · ${(window._playerFmtTime || fmtTime)(totalDur)}`
    : '加载中…');
  // hero id 便于 view 用 fadeInCover 单独注入封面（避免骨架背景框割裂）
  const heroId = id || 'hero-cover';
  return `
    <section class="flex items-end gap-6 px-8 py-8">
      <div id="${escapeAttr(heroId)}" class="w-44 h-44 rounded-2xl overflow-hidden shadow-2xl flex-shrink-0 ${cover ? '' : 'skeleton'}" style="box-shadow:var(--shadow-2xl);">
        ${cover ? `<img src="${cover}" alt="${escapeAttr(badge || '封面')}" class="w-full h-full object-cover" style="opacity:0;transition:opacity 0.45s ease;" onload="this.style.opacity='1';this.parentElement.classList.remove('skeleton');" onerror="this.parentElement.classList.add('skeleton');this.remove();">` : ''}
      </div>
      <div class="flex flex-col gap-3">
        <span class="text-xs font-semibold uppercase tracking-wider" style="color:var(--primary);">${escapeHtml(badge || '精选歌单')}</span>
        <h1 class="text-3xl font-semibold tracking-tight" style="color:var(--foreground); min-height:1.2em;">${escapeHtml(title || '')}</h1>
        <p class="text-sm max-w-xl" style="color:var(--muted-foreground);">${escapeHtml(metaText)}</p>
        <div class="flex items-center gap-3 mt-1">
          <button class="h-9 px-5 rounded-lg text-sm flex items-center gap-1.5" style="background:var(--primary);color:var(--primary-foreground);" data-action="play-all" ${!tracks || !tracks.length ? 'disabled' : ''}>
            <i data-lucide="play" class="w-4 h-4"></i>全部播放
          </button>
        </div>
      </div>
    </section>
  `;
}

function escapeAttr(s) { return escapeHtml(s); }

function renderEmpty({ icon = 'music', title = '暂无内容', hint = '' } = {}) {
  return `
    <div class="empty-state">
      <i data-lucide="${icon}" class="w-12 h-12" style="color:var(--muted-foreground); opacity:0.6;"></i>
      <p class="text-base font-medium" style="color:var(--foreground);">${escapeHtml(title)}</p>
      ${hint ? `<p class="text-sm">${escapeHtml(hint)}</p>` : ''}
    </div>
  `;
}

function renderError(msg) {
  return `
    <div class="empty-state">
      <i data-lucide="triangle-alert" class="w-12 h-12" style="color:var(--destructive); opacity:0.8;"></i>
      <p class="text-base font-medium" style="color:var(--foreground);">加载失败</p>
      <p class="text-sm">${escapeHtml(msg || '请重试')}</p>
    </div>
  `;
}

// 「全部播放」按钮绑定
function bindPlayAll(container, tracks) {
  const btn = container.querySelector('[data-action="play-all"]');
  if (btn && tracks && tracks.length) {
    btn.addEventListener('click', () => window.player.setQueue(tracks, 0));
  }
}

// 逐字标题切换：从空文本逐字增加到目标文本
// 用于：路由滚入动画完成后再逐字出现标题，避免用户看不到效果
// opts.delay: 等待多少 ms 后再开始（用于等路由滚入动画完成）
// 动态速度：字数越少每字越快，字数越多每字越慢（但总时长有上限）
async function animateTextSwap(el, fromText, toText, opts = {}) {
  if (!el) return;
  const mult = (window.animMult ? window.animMult() : 1);
  // 逐字动画速度倍率（用户可在设置中调节，默认 1.0）
  const textMult = (window.textAnimMult ? window.textAnimMult() : 1.0);
  // 动态步进：根据字数计算每字间隔
  // 短文字（≤4 字）：每字 40ms（很快，避免等太久）
  // 中等文字（5~10 字）：每字 50~80ms
  // 长文字（>10 字）：每字 80~120ms（总时长有上限避免太慢）
  const len = Math.max(toText.length, fromText.length, 1);
  let baseStep;
  if (len <= 4) baseStep = 40;
  else if (len <= 8) baseStep = 55;
  else if (len <= 15) baseStep = 75;
  else baseStep = 90;
  const step = Math.max(8, Math.round(baseStep * mult * textMult));
  // 等待路由滚入动画完成后再开始逐字（否则动画期间用户看不到）
  if (opts.delay) await new Promise(r => setTimeout(r, opts.delay));
  // 减少（若有旧文本）
  for (let i = fromText.length; i >= 0; i--) {
    el.textContent = fromText.slice(0, i);
    await new Promise(r => setTimeout(r, step));
  }
  // 增加
  for (let i = 0; i <= toText.length; i++) {
    el.textContent = toText.slice(0, i);
    await new Promise(r => setTimeout(r, step));
  }
}

// 封面淡入：避免骨架背景框「突然消失、图片割裂地出现」
// 给定容器 + 封面 URL，预加载图片，加载完成后用 opacity 渐变到 1，骨架过渡为图片
function fadeInCover(wrapEl, coverUrl, alt = '封面') {
  if (!wrapEl) return;
  if (!coverUrl) {
    wrapEl.classList.remove('skeleton');
    return;
  }
  // 渲染一个透明的 img，等图片 load 完成后再淡入
  wrapEl.innerHTML = `<img src="${coverUrl}" alt="${escapeHtml(alt)}" class="w-full h-full object-cover" style="opacity:0;transition:opacity 0.45s ease;">`;
  const img = wrapEl.querySelector('img');
  if (!img) return;
  // 先保留 skeleton class（背景占位），图片加载完后移除骨架 + 淡入图片
  // 但骨架有动画背景，会与图片割裂：改用静态占位色（不动画）
  wrapEl.classList.remove('skeleton');
  wrapEl.style.backgroundColor = 'color-mix(in srgb, var(--muted) 50%, transparent)';
  img.addEventListener('load', () => {
    wrapEl.style.backgroundColor = '';
    requestAnimationFrame(() => { img.style.opacity = '1'; });
  });
  img.addEventListener('error', () => {
    wrapEl.style.backgroundColor = '';
    // 失败回退骨架
    wrapEl.classList.add('skeleton');
    img.remove();
  });
}

// 公开到 window.ui
window.ui = window.ui || {};
window.ui.tracklist = {
  renderTracklist, renderHero, renderEmpty, renderError, bindPlayAll,
  fmtTime: (window._playerFmtTime || fmtTime), escapeHtml, animateTextSwap, fadeInCover, getDurationMs,
  // 拼音首字母工具（列头排序底层）
  firstPinyinLetters: function (s) { return (typeof window !== 'undefined' && window.firstPinyinLetters) ? window.firstPinyinLetters(s) : String(s || ''); },
};
