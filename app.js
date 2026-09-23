'use strict';

/* ============ 特性检测 ============ */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const supported = Boolean(SpeechRecognition);

const $ = (id) => document.getElementById(id);
const els = {
  unsupported: $('unsupported'),
  statusBanner: $('status-banner'),
  btnStart: $('btn-start'),
  btnStop: $('btn-stop'),
  btnClear: $('btn-clear'),
  btnCopy: $('btn-copy'),
  langBtns: Array.from(document.querySelectorAll('.lang-btn')),
  micState: $('mic-state'),
  statusText: $('status-text'),
  timer: $('timer'),
  finalSegments: $('final-segments'),
  interim: $('interim'),
  placeholder: $('placeholder'),
  transcript: $('transcript'),
  historyList: $('history-list'),
  btnClearHistory: $('btn-clear-history'),
};

/* ============ 状态 ============ */
let recognition = null;
let shouldListen = false;      // 用户意图：是否处于听写中
let restartDelay = 0;          // 自动重启退避（ms）
let restartTimer = null;
let segments = [];             // 最终识别结果分段
let currentLang = 'zh-CN';
let startedAt = null;
let timerInterval = null;
let dirty = false;             // 有未保存内容

/* ============ 标点自动补全（简单规则） ============ */
function punctuate(text, lang) {
  let t = text.trim();
  if (!t) return t;
  if (lang.startsWith('zh')) {
    // 末尾无终止标点则补句号；逗号结尾升级为句号
    if (/[，、]$/.test(t)) t = t.slice(0, -1) + '。';
    else if (!/[。！？；…!?;.]$/.test(t)) t += '。';
  } else {
    t = t.charAt(0).toUpperCase() + t.slice(1);
    if (/[,]$/.test(t)) t = t.slice(0, -1) + '.';
    else if (!/[.!?;]$/.test(t)) t += '.';
  }
  return t;
}

/* ============ 渲染 ============ */
function renderSegments() {
  els.finalSegments.innerHTML = '';
  for (const seg of segments) {
    const p = document.createElement('p');
    p.className = 'segment';
    p.textContent = seg;
    els.finalSegments.appendChild(p);
  }
  els.placeholder.style.display = segments.length || els.interim.textContent ? 'none' : 'block';
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function renderInterim(text) {
  els.interim.textContent = text;
  els.placeholder.style.display = segments.length || text ? 'none' : 'block';
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function setStatus(text, live) {
  els.statusText.textContent = text;
  els.micState.className = 'dot ' + (live ? 'dot-live' : 'dot-idle');
}

function showBanner(msg) {
  els.statusBanner.textContent = msg;
  els.statusBanner.classList.remove('hidden');
}
function hideBanner() {
  els.statusBanner.classList.add('hidden');
}

/* ============ 计时器 ============ */
function startTimer() {
  startedAt = Date.now();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    els.timer.textContent = `${mm}:${ss}`;
  }, 1000);
}
function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  els.timer.textContent = '00:00';
}

/* ============ 识别核心 ============ */
function createRecognition() {
  const rec = new SpeechRecognition();
  rec.continuous = true;        // 连续识别
  rec.interimResults = true;    // 临时结果
  rec.lang = currentLang;
  rec.maxAlternatives = 1;

  rec.onresult = (event) => {
    let interimText = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript;
      if (result.isFinal) {
        // 最终结果：标点补全后作为独立分段，临时结果不并入，避免重复
        const seg = punctuate(text, currentLang);
        if (seg) {
          segments.push(seg);
          dirty = true;
        }
      } else {
        interimText += text;
      }
    }
    renderSegments();
    renderInterim(interimText);
  };

  rec.onerror = (event) => {
    switch (event.error) {
      case 'not-allowed':
      case 'service-not-allowed':
        shouldListen = false;
        setStatus('麦克风权限被拒', false);
        showBanner('麦克风权限被拒绝。请在浏览器地址栏的站点设置中允许麦克风后重试。');
        updateButtons();
        stopTimer();
        break;
      case 'network':
        showBanner('网络中断，识别服务不可用。网络恢复后将自动继续…');
        // onend 会随后触发，由重启逻辑接管
        break;
      case 'no-speech':
        // 静默处理，自动重启
        break;
      case 'audio-capture':
        showBanner('未检测到麦克风设备，请检查设备连接。');
        break;
      case 'aborted':
        break;
      default:
        showBanner(`识别错误：${event.error}`);
    }
  };

  rec.onend = () => {
    // 识别中断（静音超时、网络抖动、浏览器内部限制）时自动重启，支撑长时听写
    if (!shouldListen) {
      setStatus('已停止', false);
      return;
    }
    setStatus('识别中断，正在自动重启…', false);
    restartTimer = setTimeout(() => {
      if (!shouldListen) return;
      try {
        recognition.start();
        setStatus('正在听写…', true);
        hideBanner();
        restartDelay = 0;
      } catch (e) {
        // start() 在已启动状态下会抛 InvalidStateError，忽略即可
      }
    }, restartDelay);
    restartDelay = Math.min(restartDelay + 500, 5000); // 退避上限 5s
  };

  rec.onstart = () => {
    setStatus('正在听写…', true);
  };

  return rec;
}

function startDictation() {
  if (!supported) return;
  shouldListen = true;
  hideBanner();
  if (!recognition) recognition = createRecognition();
  recognition.lang = currentLang;
  try {
    recognition.start();
  } catch (e) { /* 已启动时忽略 */ }
  setStatus('正在启动麦克风…', false);
  if (!timerInterval) startTimer();
  updateButtons();
}

function stopDictation() {
  shouldListen = false;
  clearTimeout(restartTimer);
  if (recognition) {
    try { recognition.stop(); } catch (e) { /* ignore */ }
  }
  stopTimer();
  setStatus('已停止', false);
  renderInterim('');
  updateButtons();
  saveSession(); // 停止时保存历史
}

function updateButtons() {
  els.btnStart.disabled = shouldListen;
  els.btnStop.disabled = !shouldListen;
}

/* ============ IndexedDB 历史 ============ */
const DB_NAME = 'dictation-db';
const STORE = 'sessions';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function saveSession() {
  if (!dirty || segments.length === 0) return;
  const session = {
    createdAt: Date.now(),
    lang: currentLang,
    segments: segments.slice(),
    text: segments.join('\n'),
  };
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add(session);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    dirty = false;
    loadHistory();
  } catch (e) {
    console.error('保存历史失败', e);
  }
}

async function loadHistory() {
  let items = [];
  try {
    const db = await openDB();
    items = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('读取历史失败', e);
  }
  items.sort((a, b) => b.createdAt - a.createdAt);
  renderHistory(items);
}

function renderHistory(items) {
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
    meta.className = 'history-meta';
    const d = new Date(item.createdAt);
    meta.textContent = `${d.toLocaleDateString()} ${d.toLocaleTimeString()} · ${item.lang === 'zh-CN' ? '中文' : 'EN'}`;

    const preview = document.createElement('span');
    preview.className = 'history-preview';
    preview.textContent = item.text.slice(0, 80);

    const del = document.createElement('button');
    del.className = 'history-delete';
    del.textContent = '删除';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(item.id);
    });

    li.appendChild(meta);
    li.appendChild(preview);
    li.appendChild(del);
    // 点击恢复历史到听写区
    li.addEventListener('click', () => {
      segments = item.segments.slice();
      renderSegments();
      renderInterim('');
      setStatus('已恢复历史记录', false);
    });
    els.historyList.appendChild(li);
  }
}

async function deleteSession(id) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    loadHistory();
  } catch (e) {
    console.error('删除失败', e);
  }
}

async function clearHistory() {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    loadHistory();
  } catch (e) {
    console.error('清空历史失败', e);
  }
}

/* ============ 复制 ============ */
async function copyTranscript() {
  const text = segments.join('\n');
  if (!text) {
    setStatus('没有可复制的内容', false);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setStatus('已复制到剪贴板', false);
  } catch (e) {
    // 回退方案
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      setStatus('已复制到剪贴板', false);
    } catch (err) {
      setStatus('复制失败，请手动选择文本复制', false);
    }
    document.body.removeChild(ta);
  }
}

/* ============ 事件绑定 ============ */
els.btnStart.addEventListener('click', startDictation);
els.btnStop.addEventListener('click', stopDictation);
els.btnClear.addEventListener('click', () => {
  segments = [];
  renderSegments();
  renderInterim('');
  setStatus('已清空', false);
});
els.btnCopy.addEventListener('click', copyTranscript);
els.btnClearHistory.addEventListener('click', clearHistory);

for (const btn of els.langBtns) {
  btn.addEventListener('click', () => {
    const lang = btn.dataset.lang;
    if (lang === currentLang) return;
    currentLang = lang;
    for (const b of els.langBtns) b.classList.toggle('active', b === btn);
    // 听写中切换语言：重启识别以应用新语言
    if (shouldListen && recognition) {
      recognition.lang = currentLang;
      try { recognition.stop(); } catch (e) { /* onend 中会自动以新语言重启 */ }
    } else if (recognition) {
      recognition.lang = currentLang;
    }
  });
}

// 页面隐藏/关闭前保存未落盘内容
window.addEventListener('pagehide', () => { saveSession(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSession();
});

/* ============ 初始化 ============ */
if (!supported) {
  els.unsupported.classList.remove('hidden');
  els.btnStart.disabled = true;
  els.btnStop.disabled = true;
  setStatus('浏览器不支持', false);
} else {
  loadHistory();
}
