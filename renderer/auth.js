// 扫码登录模态：用网易云 QR 接口拉二维码并轮询扫码状态
// 流程：qr/key 取 key → qr/create 用 key 生成二维码图（base64）→ qr/check 轮询
//      code 803=登录成功，返回 cookie 并由主进程落地

const modalRoot = document.getElementById('modal-root');
let pollTimer = null;
let pollKey = null;

function openQrModal({ onSuccess, onClose } = {}) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal-card">
      <div class="flex items-center justify-between mb-5">
        <div class="flex items-center gap-2.5">
          <img src="../main/icon.png" alt="BcsMusic" class="w-8 h-8 rounded-lg" style="object-fit:cover;">
          <div>
            <h2 class="text-base font-semibold leading-tight" style="color:var(--foreground);">扫码登录</h2>
            <p class="text-xs mt-0.5" style="color:var(--muted-foreground);">网易云音乐账号</p>
          </div>
        </div>
        <button id="qr-close" class="p-1.5 rounded-full hover:bg-black/5 transition-colors" aria-label="关闭" title="关闭">
          <i data-lucide="x" class="w-4 h-4" style="color:var(--muted-foreground);"></i>
        </button>
      </div>
      <div id="qr-stage" class="flex flex-col items-center gap-3 py-2">
        <div class="w-44 h-44 rounded-2xl skeleton"></div>
        <p class="text-sm" style="color:var(--muted-foreground);">正在生成二维码…</p>
      </div>
      <p class="text-xs text-center mt-4 pt-3" style="color:var(--muted-foreground); border-top:1px solid color-mix(in srgb, var(--foreground) 6%, transparent);">使用网易云音乐 App 扫描二维码完成登录</p>
    </div>
  `;
  modalRoot.appendChild(backdrop);
  if (window.lucide) lucide.createIcons();

  function close() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    backdrop.remove();
    if (typeof onClose === 'function') onClose();
  }

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('#qr-close').addEventListener('click', close);

  startQrFlow(backdrop.querySelector('#qr-stage'), close, onSuccess);
}

async function startQrFlow(stageEl, closeCb, onSuccess) {
  try {
    const key = await window.api.netease.qrKey();
    if (!key) {
      setStageError(stageEl, '获取二维码 key 失败');
      return;
    }
    const qr = await window.api.netease.qrCreate(key);
    if (!qr || !qr.qrimg) {
      setStageError(stageEl, '生成二维码失败');
      return;
    }
    renderQr(stageEl, qr.qrimg);
    pollKey = key;
    pollQr(stageEl, key, closeCb, onSuccess);
  } catch (err) {
    setStageError(stageEl, err.message || '登录初始化失败');
  }
}

function renderQr(stageEl, qrImgDataUrl) {
  stageEl.innerHTML = `
    <div class="w-44 h-44 rounded-2xl overflow-hidden bg-white flex items-center justify-center" style="border:1px solid color-mix(in srgb, var(--foreground) 8%, transparent);">
      <img src="${qrImgDataUrl}" alt="登录二维码" class="w-full h-full object-contain">
    </div>
    <p class="text-sm" style="color:var(--muted-foreground);">请使用网易云音乐 App 扫码</p>
  `;
}

function setStageError(stageEl, msg) {
  stageEl.innerHTML = `
    <div class="w-44 h-44 rounded-2xl flex items-center justify-center" style="background:color-mix(in srgb, var(--destructive) 10%, transparent); border:1px solid color-mix(in srgb, var(--destructive) 20%, transparent);">
      <i data-lucide="triangle-alert" class="w-10 h-10" style="color:var(--destructive);"></i>
    </div>
    <p class="text-sm" style="color:var(--destructive);">${msg}</p>
    <button id="qr-retry" class="btn btn-primary h-8 px-4 text-xs">重试</button>
  `;
  if (window.lucide) lucide.createIcons();
  stageEl.querySelector('#qr-retry')?.addEventListener('click', () => {
    stageEl.innerHTML = `<div class="w-44 h-44 rounded-2xl skeleton"></div><p class="text-sm" style="color:var(--muted-foreground);">正在重新生成…</p>`;
    startQrFlow(stageEl, () => {}, null);
  });
}

async function pollQr(stageEl, key, closeCb, onSuccess) {
  async function tick() {
    try {
      const res = await window.api.netease.qrCheck(key);
      const code = res && res.code;
      if (code === 800) {
        setStageMessage(stageEl, '二维码已过期', true);
        return;
      }
      if (code === 801) {
        setStageMessage(stageEl, '等待扫码…');
      } else if (code === 802) {
        setStageMessage(stageEl, '在 App 中确认登录…');
      } else if (code === 803) {
        // 登录成功
        setStageMessage(stageEl, '登录成功！', false, true);
        setTimeout(() => {
          closeCb();
          if (typeof onSuccess === 'function') onSuccess();
        }, 800);
        return;
      }
      pollTimer = setTimeout(tick, 1500);
    } catch (err) {
      setStageMessage(stageEl, `轮询失败：${err.message}`, true);
    }
  }
  tick();
}

function setStageMessage(stageEl, msg, isError = false, isOk = false) {
  // 只更新底部状态文本，保留二维码图
  const p = stageEl.querySelector('p');
  if (p) {
    p.textContent = msg;
    p.style.color = isError ? 'var(--destructive)' : (isOk ? 'var(--success)' : 'var(--muted-foreground)');
  }
}

function closeModal() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  modalRoot.innerHTML = '';
}

window.auth = { openQrModal, closeModal };
