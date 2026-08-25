// 通用工具函数（在 mountSettings 外也可复用）
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 通用确认弹窗：统一 UI 风格的模态框，替代原生 confirm()
function showConfirmModal({ title = '确认操作', message = '', confirmText = '确定', cancelText = '取消', destructive = false } = {}) {
  return new Promise((resolve) => {
    const modalRoot = document.getElementById('modal-root');
    if (!modalRoot) { resolve(confirm(message)); return; }
    
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-card" style="width: 360px;">
        <div class="flex flex-col items-center text-center py-2">
          <div class="w-12 h-12 rounded-full flex items-center justify-center mb-4" style="background:${destructive ? 'color-mix(in srgb, var(--destructive) 12%, transparent)' : 'color-mix(in srgb, var(--primary) 12%, transparent)'};">
            <i data-lucide="${destructive ? 'alert-triangle' : 'help-circle'}" class="w-6 h-6" style="color:${destructive ? 'var(--destructive)' : 'var(--primary)'};"></i>
          </div>
          <h3 class="text-lg font-semibold mb-2" style="color:var(--foreground);">${escapeHtml(title)}</h3>
          <p class="text-sm" style="color:var(--muted-foreground);">${escapeHtml(message)}</p>
        </div>
        <div class="flex gap-3 mt-5">
          <button id="confirm-cancel" class="flex-1 h-10 rounded-xl text-sm font-medium" style="background:color-mix(in srgb, #000000 6%, transparent); color:var(--foreground);">${escapeHtml(cancelText)}</button>
          <button id="confirm-ok" class="flex-1 h-10 rounded-xl text-sm font-medium" style="background:${destructive ? 'var(--destructive)' : 'var(--primary)'}; color:${destructive ? 'white' : 'var(--primary-foreground)'};">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;
    modalRoot.appendChild(backdrop);
    if (window.lucide) window.lucide.createIcons();
    
    const cleanup = (result) => {
      backdrop.style.transition = 'opacity 0.15s ease-out';
      backdrop.style.opacity = '0';
      setTimeout(() => {
        backdrop.remove();
        resolve(result);
      }, 150);
    };
    
    backdrop.querySelector('#confirm-cancel').addEventListener('click', () => cleanup(false));
    backdrop.querySelector('#confirm-ok').addEventListener('click', () => cleanup(true));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(false); });
  });
}

// 设置视图：3 个选项卡（账号 / 常规 / 快捷键）+ 字体选择子页
// - 账号：头像、昵称、会员状态、退出登录
// - 常规：字体、开机自启动、最小化到托盘、背景图（无缩略图框）、不透明度（1% 步进）、模糊度
//         选择图片 / 应用背景时显示居中转圈遮罩
// - 快捷键：播放暂停、上一首、下一首、音量加/减、唤出隐藏
// 字体选择：点击进入子页，列出可用字体供切换（含「使用系统默认」与「自定义字体」）
async function mountSettings(container) {
  const api = window.api;
  const ui = window.ui.tracklist;

  let settings = await api.settings.get();
  // 当前激活的选项卡：account / general / hotkey
  let activeTab = 'general';
  // 字体选择子页：null=未进入子页
  let fontSubPage = false;
  // 选项卡切换动画锁：防止动画进行中重复切换导致跳回
  let _tabSwitching = false;
  // 选项卡切换超时句柄
  let _tabSwitchTimer = null;

  // 快捷键录制状态：录制中 + 录制的目标字段名（如 hotkeyPlay）
  let recording = null; // { key } | null

  // 账号信息：预取，避免首次点击 account tab 时骨架→真实数据闪一下
  // 用 _accountLoading 标记预取状态，区分「还没拉」与「拉完是 null（未登录）」
  let account = null;
  let _accountLoading = false;
  function ensureAccountLoaded() {
    if (_accountLoading || account !== null) return;
    _accountLoading = true;
    api.netease.loginStatus().then((body) => {
      account = body && body.data;
    }).catch((err) => {
      console.warn('[settings] 预取 account 失败:', err);
      account = null;
    }).finally(() => {
      _accountLoading = false;
      // 如果用户此时已切到 account tab，刷新一次让骨架变成真实数据
      if (activeTab === 'account' && !fontSubPage) render();
    });
  }

  // 内置可选字体：内置 + 系统默认 + 用户自定义
  const FONT_OPTIONS = [
    { id: '', name: '系统默认', family: `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`, sample: 'The quick brown fox / 中文示例 0123' },
    { id: 'serif', name: '衬线（Serif）', family: `'Georgia', 'DM Serif Display', 'Times New Roman', serif`, sample: 'The quick brown fox / 中文示例 0123' },
    { id: 'mono', name: '等宽（Mono）', family: `ui-monospace, 'SF Mono', Menlo, monospace`, sample: 'The quick brown fox / 中文示例 0123' },
  ];

  function comboLabel(acc) { return acc || '未设置'; }

  // === 主渲染入口：根据子页状态决定渲染内容 ===
  function render() {
    if (fontSubPage) return renderFontPicker();
    return renderMain();
  }

  // === 字体选择子页 ===
  function renderFontPicker() {
    container.innerHTML = `
      <section class="px-8 py-6 flex items-center gap-3">
        <button id="fp-back" class="p-2 rounded-full hover:bg-black/5" aria-label="返回"><i data-lucide="arrow-left" class="w-4 h-4" style="color:var(--foreground);"></i></button>
        <div class="flex flex-col gap-1">
          <span class="text-xs font-semibold uppercase tracking-wider" style="color:var(--primary);">常规 / 字体</span>
          <h1 class="text-2xl font-semibold tracking-tight" style="color:var(--foreground);">UI 字体</h1>
        </div>
      </section>
      <section class="px-8 pb-8">
        <div class="font-picker">
          ${FONT_OPTIONS.map(f => `
            <div class="font-card" data-font-id="${escapeAttr(f.id)}">
              <div class="flex flex-col gap-1">
                <div class="font-name" style="font-family:${f.family};">${escapeHtml(f.name)}</div>
                <div class="font-sample" style="font-family:${f.family};">${escapeHtml(f.sample)}</div>
              </div>
              ${settings.customFontName === f.id || (!settings.customFontName && f.id === '') ? `<i data-lucide="check" class="w-4 h-4" style="color:var(--primary);"></i>` : ''}
            </div>
          `).join('')}
        </div>
        <div class="mt-4 font-picker">
          <div class="font-card" id="fp-custom">
            <div class="flex flex-col gap-1">
              <div class="font-name">${settings.customFont ? escapeHtml(settings.customFontName || '已加载自定义字体') : '自定义字体（.ttf / .otf / .woff2）'}</div>
              <div class="font-sample">${settings.customFont ? '点击右侧按钮替换字体文件' : '从本地选择字体文件加载到 UI'}</div>
            </div>
            <div class="flex items-center gap-2">
              ${settings.customFont ? `<button id="fp-clear" class="px-3 h-8 rounded-lg text-xs" style="background:color-mix(in srgb, var(--destructive) 8%, transparent); color:var(--destructive); border:1px solid color-mix(in srgb, var(--destructive) 25%, transparent);">清除自定义</button>` : ''}
              <button id="fp-pick" class="px-3 h-8 rounded-lg text-xs flex items-center gap-1.5" style="background:var(--primary); color:var(--primary-foreground);">
                <i data-lucide="upload" class="w-3 h-3"></i>选择字体文件
              </button>
            </div>
          </div>
        </div>
      </section>
    `;
    refreshIcons();

    container.querySelector('#fp-back').addEventListener('click', () => {
      fontSubPage = false;
      render();
    });
    container.querySelectorAll('.font-card[data-font-id]').forEach(card => {
      card.addEventListener('click', async () => {
        const id = card.dataset.fontId;
        // 选中内置字体 → 清掉 customFont，用 customFontName=id 标记
        settings = await api.settings.save({ customFont: '', customFontName: id });
        if (window.applyCustomFont) window.applyCustomFont(settings);
        // 重新应用：对内置字体也要走 applyCustomFont 路径，这里用一个特殊分支：
        applyFontChoice(id);
        window.toast(`字体已切换为「${FONT_OPTIONS.find(f => f.id === id).name}」`);
        render();
      });
    });

    const fpPick = container.querySelector('#fp-pick');
    if (fpPick) {
      fpPick.addEventListener('click', async () => {
        const res = await api.settings.pickFont();
        if (!res) return;
        if (res.error) { window.toast('读取失败: ' + res.error); return; }
        settings = await api.settings.save({ customFont: res.dataUrl, customFontName: res.name || '自定义字体' });
        applyFontChoice('custom', res);
        window.toast('已应用自定义字体');
        render();
      });
    }
    const fpClear = container.querySelector('#fp-clear');
    if (fpClear) {
      fpClear.addEventListener('click', async () => {
        settings = await api.settings.save({ customFont: '', customFontName: '' });
        applyFontChoice('');
        window.toast('已清除自定义字体');
        render();
      });
    }
  }

  // 应用字体选择：根据 id 处理内置/自定义
  // - id=''  使用系统默认
  // - id='serif' / 'mono'  使用对应字体
  // - id='custom'  使用 settings.customFont dataURL
  function applyFontChoice(id, customRes) {
    if (window.applyCustomFont) {
      // 通过临时构造 settings 让 applyCustomFont 工作：内置字体也走 @font-face 注入路径
      // 但内置字体没有 dataUrl，需要单独处理：直接设置 body font-family
      const tmpStyle = document.getElementById('bcsm-builtin-font');
      if (tmpStyle) tmpStyle.remove();
      if (id === '' || id === 'serif' || id === 'mono') {
        const opt = FONT_OPTIONS.find(f => f.id === id);
        if (opt) {
          const style = document.createElement('style');
          style.id = 'bcsm-builtin-font';
          style.textContent = `body, body * { font-family: ${opt.family}; }`;
          document.head.appendChild(style);
        }
      } else if (id === 'custom') {
        // 清掉内置字体样式，让 applyCustomFont 接管
        window.applyCustomFont(settings);
      }
    }
  }

  // === 主页：选项卡 + 各 tab 内容 ===
  function renderMain() {
    container.innerHTML = `
      <section class="px-8 py-8">
        <div class="flex flex-col gap-3">
          <span class="text-xs font-semibold uppercase tracking-wider" style="color:var(--primary);">偏好设置</span>
          <h1 class="text-3xl font-semibold tracking-tight" style="color:var(--foreground);">设置</h1>
          <p class="text-sm max-w-xl" style="color:var(--muted-foreground);">管理账号、常规偏好与全局快捷键</p>
        </div>
      </section>

      <section class="px-8 pb-6">
        <div class="settings-tabs" style="position:relative;">
          <button class="settings-tab" data-tab="account" data-active="${activeTab === 'account'}">账号设置</button>
          <button class="settings-tab" data-tab="general" data-active="${activeTab === 'general'}">常规设置</button>
          <button class="settings-tab" data-tab="hotkey" data-active="${activeTab === 'hotkey'}">快捷键设置</button>
          ${settings.showDebugLog === true ? `<button class="settings-tab" data-tab="debug" data-active="${activeTab === 'debug'}">调试日志</button>` : ''}
          <div class="settings-tab-slider" id="settings-tab-slider"></div>
        </div>
      </section>

      <section class="px-8 pb-8">
        <div id="settings-body-wrapper" style="position:relative; min-height:200px;">
          <div id="settings-body">
            ${activeTab === 'account' ? renderAccountTab() : ''}
            ${activeTab === 'general' ? renderGeneralTab() : ''}
            ${activeTab === 'hotkey' ? renderHotkeyTab() : ''}
            ${(activeTab === 'debug' && settings.showDebugLog === true) ? renderDebugTab() : ''}
          </div>
        </div>
      </section>
    `;
    bind();
    // 计算并设置滑动条位置（同步设置，避免 rAF 延迟导致 slider 跳动闪一下）
    const activeTabBtn = container.querySelector(`.settings-tab[data-active="true"]`);
    const slider = container.querySelector('#settings-tab-slider');
    if (activeTabBtn && slider) {
      slider.style.left = activeTabBtn.offsetLeft + 'px';
      slider.style.width = activeTabBtn.offsetWidth + 'px';
    }
  }

  // === 账号 tab ===
  function renderAccountTab() {
    if (!account) {
      // 占位骨架
      return `
        <div class="settings-card">
          <div class="account-card">
            <div class="account-avatar"><div class="skeleton w-16 h-16 rounded-full"></div></div>
            <div class="account-info">
              <div class="skeleton h-6 w-40 rounded"></div>
              <div class="skeleton h-4 w-24 mt-2 rounded"></div>
            </div>
          </div>
        </div>
      `;
    }
    const profile = account && account.profile;
    if (!profile) {
      // 未登录
      return `
        <div class="settings-card">
          <div class="account-card">
            <div class="account-avatar">U</div>
            <div class="account-info">
              <div class="account-name">未登录</div>
              <div class="account-meta">登录后可同步网易云账号</div>
            </div>
            <button id="acc-login" class="px-4 h-9 rounded-lg text-sm" style="background:var(--primary); color:var(--primary-foreground);">扫码登录</button>
          </div>
        </div>
      `;
    }
    const acc = account.account || {};
    const vipType = acc.vipType || 0;
    const isVip = vipType === 11 || vipType === 13;
    const vipLabel = vipType === 11 ? '黑胶 VIP' : (vipType === 13 ? 'SVIP' : '普通用户');
    const userId = profile.userId || '';
    const nickname = profile.nickname || '网易云用户';
    const avatarUrl = profile.avatarUrl ? `${profile.avatarUrl.replace('http://', 'https://')}?param=120x120` : '';
    return `
      <div class="settings-card">
        <div class="account-card">
          <div class="account-avatar">
            ${avatarUrl ? `<img src="${escapeAttr(avatarUrl)}" alt="头像">` : escapeHtml(nickname.slice(0, 1).toUpperCase())}
          </div>
          <div class="account-info">
            <div class="account-name">${escapeHtml(nickname)}</div>
            <div class="account-meta">
              <span class="vip-badge ${isVip ? '' : 'none'}">${isVip ? `<i data-lucide="crown" class="w-3 h-3"></i> ${vipLabel}` : vipLabel}</span>
              ${userId ? `<span style="margin-left:0.5rem;">UID: ${escapeHtml(String(userId))}</span>` : ''}
            </div>
          </div>
          <button id="acc-logout" class="logout-btn">退出登录</button>
        </div>
      </div>
      <div class="mt-3 p-4 rounded-xl text-xs leading-relaxed" style="background:color-mix(in srgb, var(--primary) 5%, transparent); color:var(--muted-foreground);">
        <p class="font-medium mb-1" style="color:var(--foreground);">账号说明</p>
        <p>登录后可同步「我喜欢的音乐」、每日推荐、最近播放等网易云账号数据。退出登录将清除本地 cookie 与会话。</p>
      </div>
    `;
  }

  // === 常规 tab ===
  function renderGeneralTab() {
    const opVal = settings.backgroundOpacity != null ? settings.backgroundOpacity : 0.4;
    const blurVal = settings.backgroundBlur != null ? settings.backgroundBlur : 0;
    return `
      <div class="settings-card">
        <!-- 字体设置：点击进入字体选择子页 -->
        <div class="settings-row" id="row-font">
          <div class="settings-row-label">
            <span class="settings-row-title">UI 字体</span>
            <span class="settings-row-hint">点击进入字体选择页面切换应用字体</span>
          </div>
          <div class="settings-row-control">
            <button id="font-open" class="px-3 h-9 rounded-lg text-sm flex items-center gap-1.5" style="background:color-mix(in srgb, var(--primary) 10%, transparent); border:1px solid color-mix(in srgb, var(--primary) 30%, transparent); color:var(--primary);">
              <span>${settings.customFont ? escapeHtml(settings.customFontName || '自定义') : (FONT_OPTIONS.find(f => f.id === settings.customFontName)?.name || '系统默认')}</span>
              <i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>

        <!-- 开机自启动 -->
        ${renderToggleRow({
          id: 'launch-at-login',
          title: '开机自启动',
          hint: '系统开机时自动启动应用',
          checked: settings.launchAtLogin !== false,
        })}

        <!-- 最小化到托盘 -->
        ${renderToggleRow({
          id: 'tray-toggle',
          title: '最小化到托盘',
          hint: '关闭窗口时隐藏到系统托盘，而非退出应用',
          checked: settings.minimizeToTray !== false,
        })}

        <!-- 启动时显示主窗口 -->
        ${renderToggleRow({
          id: 'show-toggle',
          title: '启动时显示主窗口',
          hint: '关闭后应用启动时仅在托盘图标显示',
          checked: settings.showOnLaunch !== false,
        })}

        <!-- 动画速度倍率（数字填写） -->
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-title">动画速度</span>
            <span class="settings-row-hint">数字填写：1.0 = 默认，0.5 = 更快，2 = 更慢（越小越快）</span>
          </div>
          <div class="settings-row-control">
            <input id="anim-speed" type="number" min="0.1" max="5" step="0.1" value="${settings.animationSpeed != null ? settings.animationSpeed : 1.0}" class="h-9 px-3 rounded-lg text-sm w-20 text-center" style="background:color-mix(in srgb, #ffffff 70%, transparent); border:1px solid color-mix(in srgb, #000000 10%, transparent); color:var(--foreground);">
          </div>
        </div>

        <!-- 逐字动画速度（数字填写） -->
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-title">逐字动画速度</span>
            <span class="settings-row-hint">数字填写：0.6 = 默认，0.3 = 更快，2 = 更慢（越小越快）</span>
          </div>
          <div class="settings-row-control">
            <input id="text-anim-speed" type="number" min="0.1" max="5" step="0.1" value="${settings.textAnimSpeed != null ? settings.textAnimSpeed : 0.6}" class="h-9 px-3 rounded-lg text-sm w-20 text-center" style="background:color-mix(in srgb, #ffffff 70%, transparent); border:1px solid color-mix(in srgb, #000000 10%, transparent); color:var(--foreground);">
          </div>
        </div>

        <!-- 显示调试日志开关：默认关闭，开启后设置页才显示「调试日志」选项卡 -->
        ${renderToggleRow({
          id: 'show-debug-log',
          title: '显示调试日志',
          hint: '开启后，设置页将出现「调试日志」选项卡（用于排查问题）。默认关闭。',
          checked: settings.showDebugLog === true,
        })}
      </div>

      <!-- 背景图设置：去掉缩略图框，只保留选择/清除/不透明度/模糊度 -->
      <div class="settings-card mt-4">
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-title">应用背景图</span>
            <span class="settings-row-hint">本地图片或图片 URL；不设则使用默认渐变</span>
          </div>
          <div class="settings-row-control">
            <button id="bg-upload" class="px-3 h-9 rounded-lg text-xs flex items-center gap-1.5" style="background:color-mix(in srgb, var(--primary) 10%, transparent); border:1px solid color-mix(in srgb, var(--primary) 30%, transparent); color:var(--primary);">
              <i data-lucide="upload" class="w-3 h-3"></i>选择本地
            </button>
            ${settings.backgroundImage ? `<button id="bg-clear" class="px-3 h-9 rounded-lg text-xs" style="background:color-mix(in srgb, #000000 5%, transparent); color:var(--muted-foreground);">清除</button>` : ''}
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-title">图片 URL</span>
            <span class="settings-row-hint">或粘贴图片 URL（https://...）</span>
          </div>
          <div class="settings-row-control">
            <input id="bg-url" type="text" placeholder="https://..." class="h-9 px-3 rounded-lg text-sm" value="${escapeAttr(settings.backgroundImage && settings.backgroundImage.startsWith('http') ? settings.backgroundImage : '')}" style="background:color-mix(in srgb, #ffffff 70%, transparent); border:1px solid color-mix(in srgb, #000000 10%, transparent); color:var(--foreground); width:280px;">
            <button id="bg-url-apply" class="px-3 h-9 rounded-lg text-xs" style="background:var(--primary); color:var(--primary-foreground);">应用</button>
          </div>
        </div>
        <!-- 不透明度：1% 步进 -->
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-title">不透明度</span>
            <span class="settings-row-hint">调整背景图的不透明度，精确到 1%</span>
          </div>
          <div class="settings-row-control">
            <input id="bg-opacity" type="range" min="0" max="1" step="0.01" value="${opVal}" class="w-48" style="accent-color:var(--primary);">
            <span id="bg-opacity-val" class="text-xs w-12 text-right font-variant-numeric" style="color:var(--muted-foreground);">${Math.round(opVal * 100)}%</span>
          </div>
        </div>
        <!-- 模糊度调整 -->
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-title">背景模糊度</span>
            <span class="settings-row-hint">0-40px，给背景增加高斯模糊</span>
          </div>
          <div class="settings-row-control">
            <input id="bg-blur" type="range" min="0" max="40" step="1" value="${blurVal}" class="w-48" style="accent-color:var(--primary);">
            <span id="bg-blur-val" class="text-xs w-12 text-right font-variant-numeric" style="color:var(--muted-foreground);">${blurVal}px</span>
          </div>
        </div>
        <!-- 填充方式 -->
        <div class="settings-row">
          <div class="settings-row-label">
            <span class="settings-row-title">填充方式</span>
            <span class="settings-row-hint">cover 裁剪填充 / contain 完整显示 / center 原始居中</span>
          </div>
          <div class="settings-row-control">
            <select id="bg-fit" class="h-9 px-2 rounded-lg text-xs" style="background:color-mix(in srgb, #ffffff 70%, transparent); border:1px solid color-mix(in srgb, #000000 10%, transparent); color:var(--foreground);">
              <option value="cover" ${settings.backgroundFit === 'cover' ? 'selected' : ''}>填充裁剪（cover）</option>
              <option value="contain" ${settings.backgroundFit === 'contain' ? 'selected' : ''}>完整显示（contain）</option>
              <option value="center" ${settings.backgroundFit === 'center' ? 'selected' : ''}>原始尺寸居中</option>
            </select>
          </div>
        </div>
      </div>
    `;
  }

  // === 快捷键 tab ===
  function renderHotkeyTab() {
    const items = [
      { key: 'hotkeyPlay', title: '播放 / 暂停', hint: '默认 Ctrl+Alt+P', default: 'Ctrl+Alt+P' },
      { key: 'hotkeyPrev', title: '上一首', hint: '默认 Ctrl+Alt+Left', default: 'Ctrl+Alt+Left' },
      { key: 'hotkeyNext', title: '下一首', hint: '默认 Ctrl+Alt+Right', default: 'Ctrl+Alt+Right' },
      { key: 'hotkeyVolUp', title: '音量加', hint: '默认 Ctrl+Alt+Up', default: 'Ctrl+Alt+Up' },
      { key: 'hotkeyVolDown', title: '音量减', hint: '默认 Ctrl+Alt+Down', default: 'Ctrl+Alt+Down' },
      { key: 'hotkey', title: '唤出 / 隐藏', hint: '默认 Shift+Alt+A', default: 'Shift+Alt+A' },
    ];
    const rows = items.map(it => `
      <div class="settings-row">
        <div class="settings-row-label">
          <span class="settings-row-title">${escapeHtml(it.title)}</span>
          <span class="settings-row-hint">${escapeHtml(it.hint)}</span>
        </div>
        <div class="settings-row-control">
          <button class="hotkey-btn" data-hotkey="${escapeAttr(it.key)}" data-recording="${recording && recording.key === it.key ? 'true' : 'false'}">
            ${recording && recording.key === it.key ? '按下组合键…' : comboLabel(settings[it.key] || it.default)}
          </button>
        </div>
      </div>
    `).join('');
    return `
      <div class="settings-card">${rows}</div>
      <div class="mt-3 p-4 rounded-xl text-xs leading-relaxed" style="background:color-mix(in srgb, var(--primary) 5%, transparent); color:var(--muted-foreground);">
        <p class="font-medium mb-1" style="color:var(--foreground);">快捷键录制</p>
        <p>点击右侧按钮进入录制状态，按下任意组合键（需含至少一个修饰键 Ctrl/Alt/Shift/Cmd + 普通键）。</p>
        <p class="mt-1">例如：Ctrl+Shift+M、Alt+P、CmdOrCtrl+Shift+L。按 Esc 取消录制。</p>
      </div>
    `;
  }

  // === 调试日志 tab：显示 window.__bcsLogs 环形缓冲，用于追踪「时长 1/1」根因 ===
  // 状态：过滤关键字、是否自动滚动到底
  let _debugFilter = '';
  let _debugAutoScroll = true;
  // bcslog:append 事件订阅句柄（离开页面时清理，避免重复绑定）
  let _debugAppendHandler = null;

  function renderDebugTab() {
    const logs = (window.__bcsLogs) ? window.__bcsLogs.slice() : [];
    return `
      <div class="settings-card" style="padding:0;overflow:hidden;">
        <div class="flex items-center gap-2 p-3" style="border-bottom:1px solid color-mix(in srgb, #000000 8%, transparent);">
          <input id="dbg-filter" type="text" placeholder="过滤（source 关键字，如 getDurationSec / timeupdate）" class="flex-1 h-9 px-3 rounded-lg text-sm" value="${escapeAttr(_debugFilter)}" style="background:color-mix(in srgb, #ffffff 70%, transparent); border:1px solid color-mix(in srgb, #000000 10%, transparent); color:var(--foreground);">
          <label class="flex items-center gap-1.5 text-xs" style="color:var(--muted-foreground); cursor:pointer;">
            <input id="dbg-autoscroll" type="checkbox" ${_debugAutoScroll ? 'checked' : ''} class="accent-[var(--primary)]">
            自动滚动
          </label>
          <button id="dbg-clear" class="px-3 h-9 rounded-lg text-xs" style="background:color-mix(in srgb, var(--destructive) 8%, transparent); color:var(--destructive); border:1px solid color-mix(in srgb, var(--destructive) 25%, transparent);">清空</button>
          <span id="dbg-count" class="text-xs px-2" style="color:var(--muted-foreground);">${logs.length} 条</span>
        </div>
        <div id="dbg-list" class="debug-log-list">
          ${renderDebugLogEntries(logs, _debugFilter)}
        </div>
      </div>
      <div class="mt-3 p-4 rounded-xl text-xs leading-relaxed" style="background:color-mix(in srgb, var(--primary) 5%, transparent); color:var(--muted-foreground);">
        <p class="font-medium mb-1" style="color:var(--foreground);">调试日志说明</p>
        <p>用于追踪「时长显示 1/1」问题的根因。播放歌曲或刷新列表后，这里会记录每一条影响时长显示的代码路径：</p>
        <p class="mt-1"><code style="background:color-mix(in srgb,#000 6%,transparent); padding:1px 4px; border-radius:3px;">tracklist.getDurationMs</code> 列表时长字段解析 ·
        <code style="background:color-mix(in srgb,#000 6%,transparent); padding:1px 4px; border-radius:3px;">player.ensureUrl</code> URL 接口返回的 durationMs 决策 ·
        <code style="background:color-mix(in srgb,#000 6%,transparent); padding:1px 4px; border-radius:3px;">player.getDurationSec</code> 最终取值逻辑 ·
        <code style="background:color-mix(in srgb,#000 6%,transparent); padding:1px 4px; border-radius:3px;">player.updateNowPlaying</code> 底栏显示 ·
        <code style="background:color-mix(in srgb,#000 6%,transparent); padding:1px 4px; border-radius:3px;">audio.loadedmetadata/timeupdate</code> 音频事件 ·
        <code style="background:color-mix(in srgb,#000 6%,transparent); padding:1px 4px; border-radius:3px;">nowplaying.refreshPlayback</code> 播放页显示</p>
        <p class="mt-1">可疑行（时长 < 5s 或显示成 0:01）会标黄，便于定位「1/1」是从哪一层开始出错的。</p>
      </div>
    `;
  }

  // 把日志条目渲染成 HTML（应用过滤）
  function renderDebugLogEntries(logs, filter) {
    if (!logs || !logs.length) {
      return `<div class="debug-log-empty">暂无日志，播放一首歌后这里会出现时长相关记录</div>`;
    }
    const f = (filter || '').trim().toLowerCase();
    const filtered = f ? logs.filter(e => {
      if (e.source && e.source.toLowerCase().includes(f)) return true;
      try { return JSON.stringify(e.data).toLowerCase().includes(f); } catch { return false; }
    }) : logs;
    // 最新的在底部
    const rows = filtered.slice(-500).map(e => {
      const d = new Date(e.t);
      const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
      let dataStr;
      try { dataStr = (typeof e.data === 'string') ? e.data : JSON.stringify(e.data); } catch { dataStr = String(e.data); }
      // 可疑判定：data 含 suspicious:true 或 chosen/final < 5
      let suspicious = false;
      if (e.data && typeof e.data === 'object') {
        if (e.data.suspicious === true) suspicious = true;
        else if (typeof e.data.chosen === 'number' && e.data.chosen > 0 && e.data.chosen < 5) suspicious = true;
        else if (typeof e.data.final === 'number' && e.data.final === 0) suspicious = true;
      }
      return `<div class="debug-log-row${suspicious ? ' suspicious' : ''}">
        <span class="debug-log-ts">${escapeHtml(ts)}</span>
        <span class="debug-log-src" title="${escapeAttr(e.source)}">${escapeHtml(e.source)}</span>
        <span class="debug-log-data">${escapeHtml(dataStr)}</span>
      </div>`;
    }).join('');
    return rows || `<div class="debug-log-empty">无匹配「${escapeHtml(filter)}」的记录</div>`;
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function pad3(n) { return String(n).padStart(3, '0'); }

  // 绑定调试 tab 的交互：过滤、清空、自动滚动、实时追加
  function bindDebug() {
    const list = container.querySelector('#dbg-list');
    const filterInput = container.querySelector('#dbg-filter');
    const autoScrollChk = container.querySelector('#dbg-autoscroll');
    const clearBtn = container.querySelector('#dbg-clear');
    const countEl = container.querySelector('#dbg-count');

    if (filterInput) {
      filterInput.addEventListener('input', () => {
        _debugFilter = filterInput.value;
        if (list) list.innerHTML = renderDebugLogEntries(window.__bcsLogs || [], _debugFilter);
        if (countEl) countEl.textContent = `${(window.__bcsLogs || []).length} 条`;
        scrollDebugToBottom(list);
      });
    }
    if (autoScrollChk) {
      autoScrollChk.addEventListener('change', () => {
        _debugAutoScroll = autoScrollChk.checked;
        if (_debugAutoScroll) scrollDebugToBottom(list);
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (window.__bcsLogs) window.__bcsLogs.length = 0;
        if (window.__bcsLogSeq) window.__bcsLogSeq = 0;
        if (list) list.innerHTML = renderDebugLogEntries([], _debugFilter);
        if (countEl) countEl.textContent = '0 条';
      });
    }
    // 订阅 bcslog:append 实时追加（增量渲染，避免全量重渲染卡顿）
    if (_debugAppendHandler) {
      window.removeEventListener('bcslog:append', _debugAppendHandler);
    }
    _debugAppendHandler = (e) => {
      const entry = e && e.detail;
      if (!entry) return;
      const f = (_debugFilter || '').trim().toLowerCase();
      // 过滤命中检查
      let match = true;
      if (f) {
        match = (entry.source && entry.source.toLowerCase().includes(f));
        if (!match) { try { match = JSON.stringify(entry.data).toLowerCase().includes(f); } catch {} }
      }
      if (countEl) countEl.textContent = `${(window.__bcsLogs || []).length} 条`;
      if (!match) return;
      if (!list) return;
      // 增量追加单行（不全量重渲染）
      const d = new Date(entry.t);
      const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
      let dataStr;
      try { dataStr = (typeof entry.data === 'string') ? entry.data : JSON.stringify(entry.data); } catch { dataStr = String(entry.data); }
      let suspicious = false;
      if (entry.data && typeof entry.data === 'object') {
        if (entry.data.suspicious === true) suspicious = true;
        else if (typeof entry.data.chosen === 'number' && entry.data.chosen > 0 && entry.data.chosen < 5) suspicious = true;
        else if (typeof entry.data.final === 'number' && entry.data.final === 0) suspicious = true;
      }
      const emptyEl = list.querySelector('.debug-log-empty');
      if (emptyEl) emptyEl.remove();
      const row = document.createElement('div');
      row.className = `debug-log-row${suspicious ? ' suspicious' : ''}`;
      row.innerHTML = `
        <span class="debug-log-ts">${escapeHtml(ts)}</span>
        <span class="debug-log-src" title="${escapeAttr(entry.source)}">${escapeHtml(entry.source)}</span>
        <span class="debug-log-data">${escapeHtml(dataStr)}</span>
      `;
      list.appendChild(row);
      // 限制 DOM 节点数（环形缓冲上限 1000，DOM 也限 500）
      while (list.children.length > 500) list.removeChild(list.firstChild);
      if (_debugAutoScroll) scrollDebugToBottom(list);
    };
    window.addEventListener('bcslog:append', _debugAppendHandler);
    // 初次进入：自动滚到底
    scrollDebugToBottom(list);
  }

  function scrollDebugToBottom(list) {
    if (!list) return;
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  // toggle 行：复用通用 .toggle-track / .toggle-thumb 样式
  function renderToggleRow({ id, title, hint, checked }) {
    return `
      <div class="settings-row" data-toggle-row="${escapeAttr(id)}">
        <div class="settings-row-label">
          <span class="settings-row-title">${escapeHtml(title)}</span>
          <span class="settings-row-hint">${escapeHtml(hint)}</span>
        </div>
        <div class="settings-row-control">
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" id="${escapeAttr(id)}" class="sr-only" ${checked ? 'checked' : ''}>
            <div class="toggle-track" style="background-color:${checked ? 'var(--primary)' : 'color-mix(in srgb, #000000 15%, transparent)'};"></div>
            <div class="toggle-thumb" style="transform:translateX(${checked ? '1.25rem' : '0'});"></div>
          </label>
        </div>
      </div>
    `;
  }

  // === 事件绑定 ===
  function bind() {
    // 选项卡切换：带平滑过渡动画
    container.querySelectorAll('.settings-tab').forEach(tab => {
      tab.addEventListener('click', async () => {
        const targetTab = tab.dataset.tab;
        // 已经在该选项卡：阻止重复渲染
        if (activeTab === targetTab) return;
        
        activeTab = targetTab;
        _tabSwitching = true;
        clearTimeout(_tabSwitchTimer);
        
        const wrapper = container.querySelector('#settings-body-wrapper');
        const body = container.querySelector('#settings-body');
        if (!wrapper || !body) {
          render();
          if (activeTab === 'account') ensureAccountLoaded();
          _tabSwitching = false;
          return;
        }
        
        // 1) 旧内容淡出+向下滚动消失
        const fadeOutMs = 250;
        body.style.transition = `opacity ${fadeOutMs}ms ease-out, transform ${fadeOutMs}ms ease-out`;
        body.style.opacity = '0';
        body.style.transform = 'translateY(30px)';
        
        // 2) 等待淡出完成
        await new Promise(r => setTimeout(r, fadeOutMs));
        
        // 3) 确保 wrapper 还在 DOM 中
        if (!document.body.contains(container)) {
          _tabSwitching = false;
          return;
        }
        
        // 4) 只替换 body 内容（保留 wrapper，避免重建导致动画失效）
        const newContent = (activeTab === 'account' ? renderAccountTab() : '') +
          (activeTab === 'general' ? renderGeneralTab() : '') +
          (activeTab === 'hotkey' ? renderHotkeyTab() : '') +
          ((activeTab === 'debug' && settings.showDebugLog === true) ? renderDebugTab() : '');
        
        // 更新选项卡按钮状态
        container.querySelectorAll('.settings-tab').forEach(t => {
          t.dataset.active = (t.dataset.tab === activeTab) ? 'true' : 'false';
        });
        
        // 替换 body 内容
        body.innerHTML = newContent;
        
        // 更新 slider 位置
        const activeTabBtn = container.querySelector('.settings-tab[data-active="true"]');
        const slider = container.querySelector('#settings-tab-slider');
        if (activeTabBtn && slider) {
          slider.style.left = activeTabBtn.offsetLeft + 'px';
          slider.style.width = activeTabBtn.offsetWidth + 'px';
        }
        
        // 5) 设置初始状态（从上方滚入）
        body.style.transition = 'none';
        body.style.opacity = '0';
        body.style.transform = 'translateY(-30px)';
        // 强制重排
        body.getBoundingClientRect();
        
        // 6) 应用过渡并触发淡入
        const fadeInMs = 320;
        requestAnimationFrame(() => {
          body.style.transition = `opacity ${fadeInMs}ms ease-out, transform ${fadeInMs}ms cubic-bezier(0.22, 1, 0.36, 1)`;
          body.style.opacity = '1';
          body.style.transform = 'translateY(0)';
        });
        
        // 刷新图标
        refreshIcons();
        
        // 切到 account 时确保账号信息已加载
        if (activeTab === 'account') ensureAccountLoaded();
        
        // 7) 切换完成，延迟解锁
        _tabSwitchTimer = setTimeout(() => { _tabSwitching = false; }, 400);
      });
    });
    // 首次挂载如果是 account tab，确保账号信息已加载
    if (activeTab === 'account') ensureAccountLoaded();

    // 字体：点击进入子页
    const fontOpen = container.querySelector('#font-open');
    if (fontOpen) {
      fontOpen.addEventListener('click', () => {
        fontSubPage = true;
        render();
      });
    }

    // 通用 toggle
    container.querySelectorAll('[data-toggle-row]').forEach(row => {
      const id = row.dataset.toggleRow;
      const checkbox = row.querySelector(`#${id}`);
      if (!checkbox) return;
      const track = checkbox.parentElement.querySelector('.toggle-track');
      const thumb = checkbox.parentElement.querySelector('.toggle-thumb');
      checkbox.addEventListener('change', async () => {
        const checked = checkbox.checked;
        track.style.backgroundColor = checked ? 'var(--primary)' : 'color-mix(in srgb, #000000 15%, transparent)';
        thumb.style.transform = `translateX(${checked ? '1.25rem' : '0'})`;
        const patch = {};
        // 命名映射：id → settings 字段
        const map = {
          'launch-at-login': 'launchAtLogin',
          'tray-toggle': 'minimizeToTray',
          'show-toggle': 'showOnLaunch',
          'show-debug-log': 'showDebugLog',
        };
        const fieldName = map[id] || id;
        patch[fieldName] = checked;
        settings = await api.settings.save(patch);
        const labels = { 'launch-at-login': '开机自启动', 'tray-toggle': '最小化到托盘', 'show-toggle': '启动显示主窗口', 'show-debug-log': '显示调试日志' };
        window.toast(`${labels[id] || id}：${checked ? '已开启' : '已关闭'}`);
        // show-debug-log 特殊处理：同步 window.__bcsDebug 开关；关闭时若当前停在 debug tab，回退到常规 tab
        if (id === 'show-debug-log') {
          window.__bcsDebug = checked;
          if (!checked && activeTab === 'debug') {
            activeTab = 'general';
          }
          render();
        }
      });
    });

    // 账号 tab
    bindAccount();
    // 常规 tab
    bindGeneral();
    // 快捷键 tab
    bindHotkey();
    // 调试日志 tab
    bindDebug();
    // 离开页面时清理 bcslog:append 订阅，避免重复绑定 / 内存泄漏
    container._cleanup = () => {
      if (_debugAppendHandler) {
        window.removeEventListener('bcslog:append', _debugAppendHandler);
        _debugAppendHandler = null;
      }
    };
  }

  function bindAccount() {
    const loginBtn = container.querySelector('#acc-login');
    if (loginBtn) {
      loginBtn.addEventListener('click', () => {
        window.auth.openQrModal({
          onSuccess: async () => {
            account = null;
            await loadAccount();
            // 通知外层 app.js 刷新用户卡片
            if (window.refreshUserChip) await window.refreshUserChip();
            if (window.loadSidebarPlaylists) await window.loadSidebarPlaylists();
            render();
            window.toast('登录成功');
          },
        });
      });
    }
    const logoutBtn = container.querySelector('#acc-logout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        const confirmed = await showConfirmModal({
          title: '退出登录',
          message: '确定要退出网易云音乐登录吗？退出后将清除本地登录状态。',
          confirmText: '退出登录',
          cancelText: '取消',
          destructive: true
        });
        if (!confirmed) return;
        await api.netease.logout();
        account = null;
        if (window.refreshUserChip) await window.refreshUserChip();
        if (window.loadSidebarPlaylists) await window.loadSidebarPlaylists();
        render();
        window.toast('已退出登录');
      });
    }
  }

  async function loadAccount() {
    // 兼容旧调用点：触发预取流程，等待结果再渲染
    if (_accountLoading) {
      // 已在拉，等回调里的 render 即可
      return;
    }
    if (account !== null) return; // 已加载
    // 触发预取，并轮询等待结束（最多 3 秒）
    ensureAccountLoaded();
    const start = Date.now();
    while (_accountLoading && Date.now() - start < 3000) {
      await new Promise(r => setTimeout(r, 80));
    }
    render();
  }

  function bindGeneral() {
    // ---- 背景图 ----
    const bgUpload = container.querySelector('#bg-upload');
    const bgClear = container.querySelector('#bg-clear');
    const bgUrl = container.querySelector('#bg-url');
    const bgUrlApply = container.querySelector('#bg-url-apply');
    const bgOpacity = container.querySelector('#bg-opacity');
    const bgOpacityVal = container.querySelector('#bg-opacity-val');
    const bgBlur = container.querySelector('#bg-blur');
    const bgBlurVal = container.querySelector('#bg-blur-val');
    const bgFit = container.querySelector('#bg-fit');

    if (bgUpload) {
      bgUpload.addEventListener('click', async () => {
        if (window.showBgLoading) window.showBgLoading();
        const res = await api.settings.pickImage();
        if (!res) { if (window.hideBgLoading) window.hideBgLoading(); return; }
        if (res.error) { if (window.hideBgLoading) window.hideBgLoading(); window.toast('读取失败: ' + res.error); return; }
        settings = await api.settings.save({ backgroundImage: res.dataUrl });
        if (window.applyBackground) await window.applyBackground();
        window.toast('背景图已设置');
        render();
      });
    }
    if (bgClear) {
      bgClear.addEventListener('click', async () => {
        settings = await api.settings.save({ backgroundImage: '' });
        if (window.applyBackground) await window.applyBackground();
        window.toast('已恢复默认背景');
        render();
      });
    }
    if (bgUrlApply) {
      bgUrlApply.addEventListener('click', async () => {
        const url = (bgUrl.value || '').trim();
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          window.toast('请输入完整的 http(s) URL');
          return;
        }
        if (window.showBgLoading) window.showBgLoading();
        settings = await api.settings.save({ backgroundImage: url });
        if (window.applyBackground) await window.applyBackground();
        window.toast('背景图已设置');
      });
    }
    if (bgOpacity) {
      bgOpacity.addEventListener('input', () => {
        const v = parseFloat(bgOpacity.value);
        bgOpacityVal.textContent = Math.round(v * 100) + '%';
        // 拖动时实时预览
        const bgImageEl = document.getElementById('bg-image');
        if (bgImageEl && settings.backgroundImage) {
          bgImageEl.style.opacity = String(v);
        }
      });
      bgOpacity.addEventListener('change', async () => {
        const v = parseFloat(bgOpacity.value);
        settings = await api.settings.save({ backgroundOpacity: v });
      });
    }
    if (bgBlur) {
      bgBlur.addEventListener('input', () => {
        const v = parseInt(bgBlur.value, 10);
        bgBlurVal.textContent = v + 'px';
        const bgImageEl = document.getElementById('bg-image');
        if (bgImageEl && settings.backgroundImage) {
          bgImageEl.style.filter = v > 0 ? `blur(${v}px)` : 'none';
        }
      });
      bgBlur.addEventListener('change', async () => {
        const v = parseInt(bgBlur.value, 10);
        settings = await api.settings.save({ backgroundBlur: v });
      });
    }
    if (bgFit) {
      bgFit.addEventListener('change', async () => {
        settings = await api.settings.save({ backgroundFit: bgFit.value });
        if (window.applyBackground) await window.applyBackground();
      });
    }
    // ---- 动画速度 ----
    const animSpeed = container.querySelector('#anim-speed');
    if (animSpeed) {
      animSpeed.addEventListener('change', async () => {
        let v = parseFloat(animSpeed.value);
        if (!isFinite(v) || v <= 0) v = 1.0;
        if (v > 5) v = 5;
        animSpeed.value = v;
        settings = await api.settings.save({ animationSpeed: v });
        // 实时应用到全局 CSS 变量 + JS 缓存
        if (window.applyAnimMult) window.applyAnimMult(v);
        window.toast(`动画速度已设为 ${v}（${v < 1 ? '更快' : v > 1 ? '更慢' : '默认'}）`);
      });
    }
    // ---- 逐字动画速度 ----
    const textAnimSpeed = container.querySelector('#text-anim-speed');
    if (textAnimSpeed) {
      textAnimSpeed.addEventListener('change', async () => {
        let v = parseFloat(textAnimSpeed.value);
        if (!isFinite(v) || v <= 0) v = 1.0;
        if (v > 5) v = 5;
        textAnimSpeed.value = v;
        settings = await api.settings.save({ textAnimSpeed: v });
        if (window.applyTextAnimMult) window.applyTextAnimMult(v);
        window.toast(`逐字动画速度已设为 ${v}（${v < 1 ? '更快' : v > 1 ? '更慢' : '默认'}）`);
      });
    }
  }

  function bindHotkey() {
    container.querySelectorAll('.hotkey-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        recording = { key: btn.dataset.hotkey };
        btn.textContent = '按下组合键…';
        btn.dataset.recording = 'true';
        btn.focus();
      });
      btn.addEventListener('keydown', (e) => {
        if (!recording || recording.key !== btn.dataset.hotkey) return;
        e.preventDefault(); e.stopPropagation();

        if (e.key === 'Escape') {
          recording = null;
          btn.dataset.recording = 'false';
          render();
          return;
        }

        const mods = [];
        if (e.ctrlKey) mods.push('Ctrl');
        if (e.metaKey) mods.push('Cmd');
        if (e.altKey) mods.push('Alt');
        if (e.shiftKey) mods.push('Shift');
        const key = e.key;
        const isLetter = /^[a-zA-Z]$/.test(key);
        const isDigit = /^[0-9]$/.test(key);
        const isFn = /^F([1-9]|1[0-2])$/.test(key);
        const isSpecial = ['Enter','Space','Tab','Backspace','Insert','Delete','Home','End','PageUp','PageDown','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key);
        if (mods.length === 0) {
          btn.textContent = '需要至少一个修饰键（Ctrl/Alt/Shift/Cmd）';
          return;
        }
        if (isLetter || isDigit || isFn || isSpecial) {
          let accel = mods.join('+') + '+';
          if (isLetter) accel += key.toUpperCase();
          else if (isDigit) accel += key;
          else if (isFn) accel += key;
          else {
            const map = { ArrowLeft:'Left', ArrowRight:'Right', ArrowUp:'Up', ArrowDown:'Down' };
            accel += map[key] || key;
          }
          recording = null;
          api.settings.save({ [btn.dataset.hotkey]: accel }).then((s) => {
            settings = s;
            window.toast(`快捷键已设置为 ${accel}`);
            render();
          });
        } else {
          btn.textContent = mods.join('+') + '+…';
        }
      });
      btn.addEventListener('blur', () => {
        if (recording && recording.key === btn.dataset.hotkey) {
          recording = null;
          btn.dataset.recording = 'false';
          render();
        }
      });
    });
  }

  // ---------- 工具 ----------
  function escapeAttr(s) { return escapeHtml(s); }
  function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }

  // 预取账号信息：在用户切到 account tab 之前就开始拉，避免点击时骨架→数据闪一下
  ensureAccountLoaded();
  // 初始渲染
  render();
}

// 暴露全局工具
window.showConfirmModal = showConfirmModal;

window.views = window.views || {};
window.views.settings = { mount: mountSettings };
