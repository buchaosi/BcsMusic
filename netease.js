// NetEase API 客户端：薄封装 NeteaseCloudMusicApi，统一 cookie 注入和错误处理
// 该包以函数形式导出（不是 HTTP server），调用约定：
//   await fn({ cookie, ...params }) -> { status, body, cookie }
// 打包后 asar 解包到 app.asar.unpacked/node_modules/NeteaseCloudMusicApi
// 开发态用 require('NeteaseCloudMusicApi')；打包态兜底从 process.resourcesPath 加载
let neteaseApi;
try {
  neteaseApi = require('NeteaseCloudMusicApi');
} catch (err) {
  // 打包后兜底：尝试从 app.asar.unpacked 加载
  try {
    const path = require('path');
    const { app } = require('electron');
    const candidate = path.join(
      app.getAppPath(),
      '..', 'app.asar.unpacked', 'node_modules', 'NeteaseCloudMusicApi'
    );
    neteaseApi = require(candidate);
  } catch (err2) {
    console.error('[netease] 加载 NeteaseCloudMusicApi 失败:', err2);
    neteaseApi = {};
  }
}
const { loadSession, saveSession } = require('./store');

// NeteaseCloudMusicApi 把所有路由函数挂在 default 导出上，名字用下划线分隔
// 例如 login/qr/key 对应 login_qr_key
function resolveFn(name) {
  // 兼容 v4 多种导出形式
  const direct = neteaseApi[name];
  if (direct) return direct;
  const def = neteaseApi.default;
  if (def && def[name]) return def[name];
  return null;
}

// 仅这些登录类接口的 res.cookie 才值得持久化。
// 其他接口（recommend_songs / song_url_v1 / cloudsearch …）的 set-cookie 只含
// 匿名/追踪 cookie（无 MUSIC_U），如果也存下来会覆盖真实登录 cookie，导致
// 后续 301、每日推荐显示 demo 数据、VIP 曲拿不到 URL 等一系列问题。
const LOGIN_ENDPOINTS = new Set([
  'login_qr_key',
  'login_qr_create',
  'login_qr_check',
  'login_status',
  'logout',
  'login_cellphone',
  'login_email',
  'refresh_login',
]);

async function call(name, params = {}) {
  const fn = resolveFn(name);
  if (!fn || typeof fn !== 'function') {
    throw new Error(`NetEase 接口不存在: ${name}`);
  }
  const session = loadSession();
  const merged = { ...params };
  if (session.cookie) merged.cookie = session.cookie;

  let res;
  try {
    res = await fn(merged);
  } catch (err) {
    // 包内某些版本抛 string，且 reject 的对象可能就是 answer（含 status/body/cookie）
    if (err && typeof err === 'object' && typeof err.status === 'number') {
      res = err;
    } else {
      const msg = err && err.message ? err.message : String(err);
      throw new Error(`NetEase 调用 ${name} 失败: ${msg}`);
    }
  }

  if (!res || typeof res.status !== 'number') {
    throw new Error(`NetEase 调用 ${name} 无响应`);
  }
  // 仅登录类接口回写 cookie，避免匿名 cookie 覆盖真实登录态
  if (LOGIN_ENDPOINTS.has(name) && Array.isArray(res.cookie) && res.cookie.length) {
    const cookieStr = res.cookie.filter(Boolean).join('; ');
    if (cookieStr && cookieStr !== session.cookie) {
      saveSession({ ...session, cookie: cookieStr });
    }
  }
  if (res.status !== 200) {
    // 301 = 未登录或 cookie 失效，清掉污染的 session 让用户重新登录
    if (res.status === 301) {
      try {
        const s = loadSession();
        if (s.cookie && !s.cookie.includes('MUSIC_U=')) {
          // cookie 不含 MUSIC_U，是匿名 cookie，清掉
          const { clearSession } = require('./store');
          clearSession();
        }
      } catch {}
    }
    const code = res.body && res.body.code;
    const msg = (res.body && (res.body.msg || res.body.message)) || `HTTP ${res.status}`;
    throw new Error(`NetEase ${name} 错误: ${msg}${code ? ` (code=${code})` : ''}`);
  }
  return res.body;
}

// ========== 登录 ==========
async function qrKey() {
  return call('login_qr_key');
}

async function qrCreate(key) {
  return call('login_qr_create', { key, qrimg: true });
}

async function qrCheck(key) {
  // 800=过期, 801=等待扫码, 802=待确认, 803=授权成功
  return call('login_qr_check', { key });
}

async function loginStatus() {
  return call('login_status');
}

async function logout() {
  return call('logout');
}

// ========== 用户 ==========
async function userPlaylist(uid) {
  return call('user_playlist', { uid });
}

async function userRecord(uid, type = 1) {
  // type=1 最近一周, type=0 全部
  return call('user_record', { uid, type });
}

// ========== 推荐 ==========
// 每日推荐：网易云「每日推荐」页 /discover/recommend/taste 的同款接口
// /api/v3/discovery/recommend/songs——基于账号的听歌偏好和红心做个性化推荐
// 必须带 cookie 调用，未登录时返回的是 demo 数据（与 taste 页一致）
async function recommendSongs() {
  return call('recommend_songs');
}

// 推荐歌单：网易云「每日推荐歌单」
// 基于账号的听歌偏好生成，需登录态
async function recommendResource() {
  const body = await call('recommend_resource');
  return (body && body.recommend) || [];
}

// ========== 歌单详情 ==========
async function playlistDetail(id) {
  return call('playlist_detail', { id });
}

// ========== 歌曲 URL ==========
// level: standard | exhigh | lossless | hires
async function songUrl(id, level = 'exhigh') {
  return call('song_url_v1', { id, level });
}

// 批量取 URL（id 逗号分隔的字符串或数组）
async function songUrlBatch(ids, level = 'exhigh') {
  return call('song_url_v1', { id: Array.isArray(ids) ? ids.join(',') : ids, level });
}

// 取 MV 播放地址——VIP 曲目 song_url 可能只回 30s 试听版，
// 此时回退到 MV 音轨（多数 VIP 曲目都有 MV，且音轨完整不截断）
async function mvUrl(id, r = 1080) {
  return call('mv_url', { id, r });
}

// 智能 songUrl：优先 song_url；返回试听版（含 freeTrialInfo）或 null 时回退 MV
// 返回 { url, durationMs, source: 'song' | 'mv' | null }
// ===== 根因修复：song_url_v1 的 item.time 单位不可信（不同 level / 不同服务端版本既可能返回秒，
// 也可能返回毫秒），必须像 tracklist.js 里 getDurationMs 一样做单位纠正；
// 试听版更是要优先采用 freeTrialInfo.start/end（这俩明确是秒数）。
// 否则传回 player 的 durationMs 可能是 240（本该是 240 秒却被当 240ms = 0.24s），
// 导致 getDurationSec 丢弃元数据、退化到 audio.duration=1，出现"全部显示 1/1"。*/
function _normalizeTimeMs(time) {
  if (time == null) return 0;
  const n = typeof time === 'number' ? time : parseFloat(time);
  if (!isFinite(n) || n <= 0) return 0;
  // 阈值 < 1e5 视为秒：一般歌曲毫秒数 >= 60000（1分钟）
  return n < 100000 ? n * 1000 : n;
}
async function songUrlSmart(id) {
  // 试多个音质——非 VIP 账号对部分 VIP 曲在某些音质会回试听版
  const levels = ['exhigh', 'standard', 'lossless'];
  let trialUrl = null;
  let trialDurationMs = null;
  for (const level of levels) {
    try {
      const body = await call('song_url_v1', { id, level });
      const arr = body && body.data;
      if (Array.isArray(arr) && arr.length) {
        const item = arr[0];
        // 试听版字段：网易云在试听 URL 上挂 freeTrialInfo = { start, end }（单位：秒）
        const isTrial = !!item.freeTrialInfo;
        // ===== 时长计算：试听版优先用 freeTrialInfo.end - start（秒数），再回退到 item.time =====
        let durMs = 0;
        if (item.freeTrialInfo && typeof item.freeTrialInfo.end === 'number') {
          const s = item.freeTrialInfo.start || 0;
          const e = item.freeTrialInfo.end;
          if (e > s) durMs = Math.round((e - s) * 1000);
        }
        if (!durMs) durMs = _normalizeTimeMs(item.time);
        if (item.url && !isTrial) {
          return { url: item.url, durationMs: durMs || null, source: 'song' };
        }
        if (item.url && isTrial && !trialUrl) {
          // 记录试听 URL 作为兜底，先试 MV
          trialUrl = item.url;
          trialDurationMs = durMs;
          break;
        }
      }
    } catch (err) {
      // 单个 level 失败继续尝试下一个
    }
  }
  // 回退到 MV
  try {
    const body = await mvUrl(id);
    const data = body && body.data;
    if (data && data.url) {
      // MV 接口不返回时长，durationMs 保留 null；player 会用元数据 track.durationMs 兜底
      return { url: data.url, durationMs: null, source: 'mv' };
    }
  } catch (err) {
    // MV 也失败
  }
  // 最后兜底：试听版（有总比没有好，至少能放出声音）
  if (trialUrl) {
    return { url: trialUrl, durationMs: trialDurationMs || null, source: 'song' };
  }
  return null;
}

// ========== 歌词 ==========
async function lyric(id) {
  return call('lyric', { id });
}

// ========== 听歌打卡（同步到网易云最近播放）==========
// scrobble：把播放上报到网易云 /api/feedback/weblog，让最近播放列表与网易云同步
async function scrobble(id, sourceId, time) {
  return call('scrobble', { id, sourceid: sourceId || id, time: time || 0 });
}

// ========== 喜欢的歌曲 ==========
// 红心/取消红心单首：like=true 加红心，false 取消
// 注意：NeteaseCloudMusicApi 的 like 模块用 `query.like == 'false'` 判断取消，
// 仅匹配字符串 'false'，传布尔 false 会被当作 true（永远喜欢）。
// 因此这里显式转成字符串 'true'/'false'
async function likeSong(id, like = true) {
  return call('like', { id, like: like ? 'true' : 'false' });
}

// 取用户「喜欢的歌曲」ID 列表（无序）
async function likelist(uid) {
  const body = await call('likelist', { uid });
  return body && body.ids;
}

// 收藏单曲到歌单 / 从歌单删除歌曲
// op: 'add' | 'del'，pid: 歌单 ID，trackIds: 数组
async function playlistTracks(op, pid, trackIds) {
  const ids = Array.isArray(trackIds) ? trackIds : [trackIds];
  const body = await call('playlist_tracks', {
    op,
    pid,
    tracks: ids.join(','),
  });
  return body && body.body;
}

// ========== 歌手 / 专辑 ==========
// 歌手详情：返回标识、简介、头像等
async function artistDetail(id) {
  const body = await call('artist_detail', { id });
  return body && body.data;
}

// 歌手热门 50 首
async function artistTopSong(id) {
  const body = await call('artist_top_song', { id });
  return (body && body.songs) || [];
}

// 歌手全部歌曲（分页）
async function artistSongs(id, { limit = 100, offset = 0, order = 'hot' } = {}) {
  const body = await call('artist_songs', { id, limit, offset, order });
  return body;
}

// 歌手专辑列表
async function artistAlbum(id, { limit = 30, offset = 0 } = {}) {
  const body = await call('artist_album', { id, limit, offset });
  return body;
}

// 歌手 MV 列表
async function artistMv(id, { limit = 30, offset = 0 } = {}) {
  const body = await call('artist_mv', { id, limit, offset });
  return body;
}

// 专辑详情（含歌曲列表）
async function album(id) {
  return call('album', { id });
}

// 收藏 / 取消收藏专辑（t=1 收藏，t=0 取消收藏）
async function albumSub(id, t = 1) {
  return call('album_sub', { id, t });
}

// 已收藏的专辑列表
async function albumSublist({ limit = 50, offset = 0 } = {}) {
  return call('album_sublist', { limit, offset });
}

// 关注 / 取消关注歌手（t=1 关注，t=0 取消关注）
async function artistSub(id, t = 1) {
  return call('artist_sub', { id, t });
}

// 已关注的歌手列表
async function artistSublist({ limit = 50, offset = 0 } = {}) {
  return call('artist_sublist', { limit, offset });
}

// 私人 FM：心动模式的歌曲来源（每次返回 3 首，可刷新）
async function personalFm() {
  return call('personal_fm');
}

// ========== 搜索 ==========
// cloudsearch 是网易云新版搜索接口，返回结构更完整（含歌曲详情、歌手、专辑）
// type: 1=歌曲, 10=专辑, 100=歌手, 1000=歌单, 1002=用户, 1004=mv, 1006=歌词, 1009=主播电台
async function cloudsearch(keywords, { type = 1, limit = 30, offset = 0 } = {}) {
  return call('cloudsearch', { keywords, type, limit, offset });
}

// 热搜榜（含排名、热搜词、图标）
async function searchHotDetail() {
  return call('search_hot_detail');
}

// 搜索建议（输入时实时联想）
async function searchSuggest(keywords) {
  return call('search_suggest', { keywords });
}

module.exports = {
  qrKey, qrCreate, qrCheck, loginStatus, logout,
  userPlaylist, userRecord,
  recommendSongs, recommendResource,
  playlistDetail, songUrl, songUrlBatch, mvUrl, songUrlSmart,
  lyric, scrobble,
  likeSong, likelist, playlistTracks,
  artistDetail, artistTopSong, artistSongs, artistAlbum, artistMv, artistSub, artistSublist,
  album, albumSub, albumSublist,
  personalFm,
  cloudsearch, searchHotDetail, searchSuggest,
};
