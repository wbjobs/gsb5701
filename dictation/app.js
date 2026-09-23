'use strict';

/* ================= 常量 ================= */
const MAX_SESSION_MS = 30 * 60 * 1000;   // 单次最长听写 30 分钟
const PARAGRAPH_GAP_MS = 2500;           // 两段最终结果间隔超过该值则分段
const AUTOSAVE_INTERVAL_MS = 5000;       // 听写中定期自动保存
const MAX_RESTART_DELAY_MS = 10000;      // 自动重启最大退避

/* ================= DOM ================= */
const $ = (id) => document.getElementById(id);
const els = {
  btnStart: $('btnStart'), btnStop: $('btnStop'), btnClear: $('btnClear'), btnCopy: $('btnCopy'),
  langBtns: Array.from(document.querySelectorAll('.lang-btn')),
  banner: $('banner'), statusDot: $('statusDot'), statusText: $('statusText'),
  elapsed: $('elapsed'), restartInfo: $('restartInfo'),
  finalText: $('finalText'), interimText: $('interimText'), placeholder: $('placeholder'),
  transcript: $('transcript'), historyList: $('historyList'), btnRefreshHistory: $('btnRefreshHistory'),
};

/* ================= IndexedDB ================= */
const DB_NAME = 'dictation-db';
const DB_VERSION = 1;
const STORE = 'sessions';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(session) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(session);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

async function dbAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

/* ================= 状态 ================= */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const state = {
  recognition: null,
  listening: false,        // 用户意图：是否应处于听写中
  lang: 'zh-CN',
  segments: [],            // 已确认的最终结果段落（字符串数组）
  interim: '',             // 临时结果
  sessionId: null,         // 当前会话在 IndexedDB 中的 id
  sessionStart: 0,         // 本次听写开始时间戳
  lastFinalAt: 0,          // 最近一次最终结果时间（用于分段）
  restartCount: 0,         // 自动重启次数
  restartAttempts: 0,      // 连续重启失败次数（退避用）
  elapsedTimer: null,
  autosaveTimer: null,
  limitTimer: null,
};

/* ================= 提示 ================= */
function showBanner(msg, type = 'warn') {
  els.banner.textContent = msg;
  els.banner.className = 'banner' + (type === 'error' ? ' error' : type === 'info' ? ' info' : '');
}
function hideBanner() { els.banner.className = 'banner hidden'; }

function setStatus(text, level = 'idle') {
  els.statusText.textContent = text;
  els.statusDot.className = 'dot dot-' + level;
}

/* ================= 工具 ================= */
function pad(n) { return String(n).padStart(2, '0'); }

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* 简单规则自动标点：中文补句号、英文首字母大写并补句点 */
function punctuate(text, lang) {
  let t = text.trim();
  if (!t) return t;
  if (lang.startsWith('zh')) {
    if (!/[。！？；，、：…,.!?;:]$/.test(t)) t += '。';
  } else {
    t = t.charAt(0).toUpperCase() + t.slice(1);
    if (!/[.!?;:]$/.test(t)) t += '.';
  }
  return t;
}

function fullText() {
  return state.segments.join('\n');
}

/* ================= 渲染 ================= */
function render() {
  els.placeholder.style.display = (state.segments.length || state.interim) ? 'none' : '';
  els.finalText.innerHTML = '';
  for (const seg of state.segments) {
    const p = document.createElement('p');
    p.textContent = seg;
    els.finalText.appendChild(p);
  }
  els.interimText.textContent = state.interim;
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function updateRestartInfo() {
  els.restartInfo.textContent = state.restartCount > 0 ? `已自动重连 ${state.restartCount} 次` : '';
}

/* ================= 识别 ================= */
function createRecognition() {
  const rec = new SpeechRecognition();
  rec.continuous = true;          // 连续识别
  rec.interimResults = true;      // 临时结果
  rec.lang = state.lang;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    state.restartAttempts = 0;
    setStatus('正在聆听…', 'live');
  };

  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const text = res[0].transcript;
      if (res.isFinal) {
        appendFinal(text);
      } else {
        interim += text;
      }
    }
    state.interim = interim;
    render();
  };

  rec.onerror = (event) => {
    const err = event.error;
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      showBanner('麦克风权限被拒绝。请在浏览器地址栏的站点设置中允许麦克风权限后重试。', 'error');
      setStatus('权限被拒', 'error');
      stopSession(false);
    } else if (err === 'network') {
      showBanner('网络连接中断，识别服务不可用。网络恢复后将自动重连…', 'error');
      setStatus('网络中断，等待重连', 'warn');
      // 保持 listening=true，onend 会触发自动重启
    } else if (err === 'no-speech') {
      setStatus('未检测到语音，继续聆听…', 'warn');
    } else if (err === 'audio-capture') {
      showBanner('未检测到可用的麦克风设备，请检查设备连接。', 'error');
      setStatus('无麦克风', 'error');
      stopSession(false);
    } else if (err === 'aborted') {
      // 主动 stop/abort 导致，忽略
    } else {
      showBanner(`识别出错：${err}，将尝试自动重启…`);
      setStatus('识别异常，准备重启', 'warn');
    }
  };

  rec.onend = () => {
    // 浏览器一次识别会话通常只能持续约 1 分钟，结束后若仍处于听写意图则自动重启
    if (state.listening) {
      const delay = Math.min(500 * Math.pow(2, state.restartAttempts), MAX_RESTART_DELAY_MS);
      state.restartAttempts++;
      state.restartCount++;
      updateRestartInfo();
      setStatus('识别中断，正在自动重启…', 'warn');
      setTimeout(() => {
        if (state.listening) safeStart();
      }, delay);
    }
  };

  return rec;
}

function safeStart() {
  try {
    state.recognition.start();
  } catch (e) {
    // start() 在已启动状态下会抛 InvalidStateError，稍后重试
    setTimeout(() => { if (state.listening) safeStart(); }, 500);
  }
}

/* 追加一段最终结果：自动标点 + 按停顿分段 */
function appendFinal(rawText) {
  const text = punctuate(rawText, state.lang);
  if (!text) return;
  const now = Date.now();
  const isZh = state.lang.startsWith('zh');
  const joiner = isZh ? '' : ' ';
  if (state.segments.length && now - state.lastFinalAt <= PARAGRAPH_GAP_MS) {
    state.segments[state.segments.length - 1] += joiner + text;
    if (!isZh) state.segments[state.segments.length - 1] = state.segments[state.segments.length - 1].replace(/\s+/g, ' ');
  } else {
    state.segments.push(text);
  }
  state.lastFinalAt = now;
}

/* ================= 会话控制 ================= */
function startSession() {
  if (!SpeechRecognition) return;
  hideBanner();
  state.listening = true;
  state.sessionStart = Date.now();
  state.lastFinalAt = 0;
  state.restartCount = 0;
  state.restartAttempts = 0;
  state.sessionId = null;
  state.recognition = createRecognition();
  safeStart();

  els.btnStart.disabled = true;
  els.btnStop.disabled = false;
  updateRestartInfo();

  state.elapsedTimer = setInterval(() => {
    els.elapsed.textContent = fmtElapsed(Date.now() - state.sessionStart);
  }, 1000);

  // 30 分钟上限保护
  state.limitTimer = setTimeout(() => {
    showBanner('已达到单次最长听写时长 30 分钟，已自动停止并保存。', 'info');
    stopSession(true);
  }, MAX_SESSION_MS);

  // 定期自动保存，防止意外崩溃丢失
  state.autosaveTimer = setInterval(() => saveSession(), AUTOSAVE_INTERVAL_MS);
}

function stopSession(save = true) {
  state.listening = false;
  clearInterval(state.elapsedTimer);
  clearInterval(state.autosaveTimer);
  clearTimeout(state.limitTimer);
  if (state.recognition) {
    try { state.recognition.stop(); } catch (e) { /* 忽略 */ }
  }
  els.btnStart.disabled = !SpeechRecognition;
  els.btnStop.disabled = true;
  setStatus('已停止', 'idle');
  state.interim = '';
  render();
  if (save) saveSession().then(loadHistory);
}

async function saveSession() {
  const text = fullText();
  if (!text.trim()) return;
  const record = {
    id: state.sessionId ?? undefined,
    startedAt: state.sessionStart,
    updatedAt: Date.now(),
    lang: state.lang,
    segments: state.segments.slice(),
    text,
  };
  try {
    state.sessionId = await dbPut(record);
  } catch (e) {
    console.error('保存失败', e);
  }
}

/* ================= 历史 ================= */
async function loadHistory() {
  let items = [];
  try {
    items = await dbAll();
  } catch (e) {
    console.error('读取历史失败', e);
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  els.historyList.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'history-empty';
    li.textContent = '暂无历史记录';
    els.historyList.appendChild(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'history-item';

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${fmtTime(item.startedAt)} · ${item.lang === 'zh-CN' ? '中文' : 'EN'}`;

    const preview = document.createElement('span');
    preview.className = 'preview';
    preview.textContent = item.text.slice(0, 80);

    const actions = document.createElement('span');
    actions.className = 'actions';

    const btnRestore = document.createElement('button');
    btnRestore.className = 'btn btn-small';
    btnRestore.textContent = '恢复';
    btnRestore.onclick = () => {
      if (state.listening) { showBanner('听写进行中，请先停止再恢复历史记录。'); return; }
      state.segments = item.segments.slice();
      state.interim = '';
      state.lang = item.lang;
      syncLangButtons();
      render();
      showBanner('已恢复历史记录到编辑区。', 'info');
    };

    const btnCopy = document.createElement('button');
    btnCopy.className = 'btn btn-small';
    btnCopy.textContent = '复制';
    btnCopy.onclick = () => copyText(item.text);

    const btnDel = document.createElement('button');
    btnDel.className = 'btn btn-small';
    btnDel.textContent = '删除';
    btnDel.onclick = async () => { await dbDelete(item.id); loadHistory(); };

    actions.append(btnRestore, btnCopy, btnDel);
    li.append(meta, preview, actions);
    els.historyList.appendChild(li);
  }
}

/* ================= 复制 ================= */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showBanner('已复制到剪贴板。', 'info');
  } catch (e) {
    // 降级方案
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showBanner('已复制到剪贴板。', 'info');
    } catch (e2) {
      showBanner('复制失败，请手动选择文本复制。', 'error');
    }
    document.body.removeChild(ta);
  }
}

/* ================= 语言 ================= */
function syncLangButtons() {
  for (const b of els.langBtns) b.classList.toggle('active', b.dataset.lang === state.lang);
}

/* ================= 事件绑定 ================= */
els.btnStart.onclick = startSession;
els.btnStop.onclick = () => stopSession(true);
els.btnClear.onclick = () => {
  state.segments = [];
  state.interim = '';
  state.sessionId = null;
  els.elapsed.textContent = '00:00';
  render();
  hideBanner();
};
els.btnCopy.onclick = () => {
  const text = fullText();
  if (!text.trim()) { showBanner('没有可复制的内容。'); return; }
  copyText(text);
};
els.btnRefreshHistory.onclick = loadHistory;
for (const b of els.langBtns) {
  b.onclick = () => switchLang(b.dataset.lang);
}

/* 切换语言；若正在听写，则结束当前识别会话并用新语言无缝重启 */
function switchLang(lang) {
  if (lang === state.lang) return;
  state.lang = lang;
  syncLangButtons();
  if (!state.listening) return;
  const old = state.recognition;
  state.recognition = createRecognition();
  old.onend = () => { if (state.listening) safeStart(); };
  old.onerror = null;
  try { old.stop(); } catch (e) { safeStart(); }
}

/* ================= 初始化 ================= */
(function init() {
  if (!SpeechRecognition) {
    showBanner('当前浏览器不支持 SpeechRecognition API，请使用 Chrome / Edge 最新版本。', 'error');
    els.btnStart.disabled = true;
    setStatus('浏览器不支持', 'error');
  }
  syncLangButtons();
  render();
  loadHistory();
})();
