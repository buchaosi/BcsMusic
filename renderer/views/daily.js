// 「每日推荐」视图：与网易云「每日推荐」页 (/discover/recommend/taste) 完全一致
// 调用 /api/v3/discovery/recommend/songs —— 基于账号的红心与听歌历史生成
async function mountDaily(container) {
  const api = window.api;
  const ui = window.ui.tracklist;

  // 日期徽标：与网易云 App 一致，显示「今日 X月X日」
  const today = new Date();
  const dateBadge = `今日 ${today.getMonth() + 1}月${today.getDate()}日`;
  container.innerHTML = ui.renderHero({ cover: '', badge: dateBadge, title: '每日推荐', meta: '加载中…' });

  try {
    const session = await api.netease.getSession();
    // 必须有 MUSIC_U 才是真正登录，否则网易云会返回 demo 数据
    if (!session.cookie || !session.cookie.includes('MUSIC_U=')) {
      container.innerHTML = ui.renderEmpty({
        icon: 'sparkles', title: '登录后查看每日推荐',
        hint: '每日推荐基于你的网易云账号红心 + 听歌偏好生成，请先扫码登录',
      });
      return;
    }
    const songs = await api.netease.recommendSongs() || [];
    if (!songs.length) {
      container.innerHTML = ui.renderEmpty({ icon: 'sparkles', title: '今日暂无推荐' });
      return;
    }
    // IPC 已返回 body.data.dailySongs：[{ reason, song: {id, name, ar, al, dt} }]
    // 取出 song 字段作为 track，保留 reason 用于展示
    const tracks = songs.map(s => (s && s.song) || s);
    const cover = tracks[0] && tracks[0].al && tracks[0].al.picUrl;
    const meta = `根据你的红心歌曲与最近播放，每天 ${tracks.length} 首个性推荐 · 与网易云「每日推荐」同步`;
    container.innerHTML = ui.renderHero({ cover, badge: dateBadge, title: '', meta, tracks })
      + `<section class="px-8 pb-8" id="tracklist-wrap"></section>`;
    ui.bindPlayAll(container, tracks);
    const tl = ui.renderTracklist(tracks);
    const wrap = container.querySelector('#tracklist-wrap');
    wrap.innerHTML = tl.html;
    tl.bind(wrap);
    // 逐字标题
    const routeDelay = Math.round(280 * (window.animMult ? window.animMult() : 1));
    const titleEl = container.querySelector('h1');
    if (titleEl) ui.animateTextSwap(titleEl, '', '每日推荐', { delay: routeDelay });
  } catch (err) {
    container.innerHTML = ui.renderError(err.message);
  }
}

window.views = window.views || {};
window.views.daily = { mount: mountDaily };
