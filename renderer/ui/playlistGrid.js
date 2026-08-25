// 歌单卡片网格：用于「网易云漫游」推荐歌单 + 用户歌单列表
// playlists: [{ id, name, coverImgUrl, trackCount, playcount, creator: {nickname} }]
function renderPlaylistGrid(playlists, { onOpen } = {}) {
  if (!playlists || !playlists.length) {
    return { html: window.ui.tracklist.renderEmpty({ icon: 'radio', title: '暂无推荐歌单' }), bind() {} };
  }
  const cards = playlists.map(p => {
    const cover = p.coverImgUrl || (p.picUrl) || '';
    const count = p.trackCount != null ? `${p.trackCount} 首` : '';
    const creator = p.creator && p.creator.nickname ? `· ${window.ui.tracklist.escapeHtml(p.creator.nickname)}` : '';
    return `
      <div class="playlist-card flex flex-col" data-id="${p.id}">
        <div class="aspect-square overflow-hidden ${cover ? '' : 'skeleton'}">
          ${cover ? `<img src="${cover.replace(/http:/, 'https:')}?param=300x300" alt="${window.ui.tracklist.escapeHtml(p.name)}" class="w-full h-full object-cover">` : ''}
        </div>
        <div class="p-3 flex flex-col gap-1">
          <span class="text-sm font-medium truncate" style="color:var(--foreground);">${window.ui.tracklist.escapeHtml(p.name)}</span>
          <span class="text-xs" style="color:var(--muted-foreground);">${count} ${creator}</span>
        </div>
      </div>
    `;
  }).join('');

  const html = `
    <div class="grid gap-4 px-8 pb-8" style="grid-template-columns:repeat(auto-fill, minmax(160px, 1fr));">
      ${cards}
    </div>
  `;
  return {
    html,
    bind(container) {
      container.querySelectorAll('.playlist-card').forEach(card => {
        card.addEventListener('click', () => {
          const id = card.dataset.id;
          if (onOpen) onOpen(id);
        });
      });
    },
  };
}

window.ui = window.ui || {};
window.ui.playlistGrid = { renderPlaylistGrid };
