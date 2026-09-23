// Tomatito for the web: the same tomato, installable as an app from Edge or Chrome.
'use strict';

// ?fast shrinks the timers to seconds for testing, like TOMATITO_FAST on the Mac.
const FAST = new URLSearchParams(location.search).has('fast');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

// ---------- storage ----------

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

// ---------- settings ----------

const DEFAULTS = { focusMinutes: 25, shortMinutes: 5, longMinutes: 15, longEvery: 4, chime: 'Glass', notify: true };
const settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
const saveSettings = () => store.set('settings', settings);

const focusLength = () => FAST ? 12 : settings.focusMinutes * 60;
const shortLength = () => FAST ? 10 : settings.shortMinutes * 60;
const longLength = () => FAST ? 16 : settings.longMinutes * 60;

// ---------- chimes, synthesised so there's nothing to download ----------

const CHIMES = ['Glass', 'Bell', 'Marimba', 'Bubble', 'Harp', 'Silent'];
let audio = null;

function wakeAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!audio && Ctx) audio = new Ctx();
  if (audio && audio.state === 'suspended') audio.resume();
}
// Browsers only allow sound after a click, so warm the audio up on the first one.
addEventListener('pointerdown', wakeAudio, true);
addEventListener('keydown', wakeAudio, true);

function tone(freq, start, dur, { type = 'sine', gain = 0.2, sweep } = {}) {
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (sweep) osc.frequency.exponentialRampToValueAtTime(sweep, start + dur * 0.6);
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.006);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(amp).connect(audio.destination);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

function playChime(name = settings.chime) {
  if (name === 'Silent') return;
  wakeAudio();
  if (!audio) return;
  const t = audio.currentTime + 0.03;
  switch (name) {
    case 'Glass':
      tone(1568, t, 1.5, { gain: 0.16 }); tone(2349, t, 1.0, { gain: 0.07 }); tone(3136, t, 0.6, { gain: 0.03 });
      break;
    case 'Bell':
      tone(880, t, 2.2, { gain: 0.18 }); tone(2429, t, 1.2, { gain: 0.05 }); tone(4752, t, 0.5, { gain: 0.02 });
      break;
    case 'Marimba':
      [1047, 1319, 1568].forEach((f, i) => { tone(f, t + i * 0.12, 0.5, { gain: 0.2 }); tone(f * 4, t + i * 0.12, 0.08, { gain: 0.03 }); });
      break;
    case 'Bubble':
      tone(380, t, 0.18, { gain: 0.28, sweep: 1100 }); tone(520, t + 0.16, 0.22, { gain: 0.22, sweep: 1400 });
      break;
    case 'Harp':
      [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, t + i * 0.09, 1.3, { type: 'triangle', gain: 0.11 }));
      break;
  }
}

// ---------- flavour text ----------

const lastPick = {};
function pickIndex(key, count) {
  if (count <= 1) return 0;
  let i;
  do { i = Math.floor(Math.random() * count); } while (i === lastPick[key]);
  lastPick[key] = i;
  return i;
}
const pick = (key, pool) => pool.length ? pool[pickIndex(key, pool.length)] : '';

// ---------- harvest bookkeeping ----------

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const harvestKey = d => 'harvest-' + (FAST ? 'test-' : '') + ymd(d);
const todayCount = () => store.get(harvestKey(new Date()), 0);

/** The last seven days, oldest first. */
function history() {
  const letter = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  return [6, 5, 4, 3, 2, 1, 0].map(back => {
    const day = new Date();
    day.setDate(day.getDate() - back);
    return { label: letter.format(day), count: store.get(harvestKey(day), 0), isToday: back === 0 };
  });
}

/** Days in a row with at least one tomato, counting today only once it has one. */
function streak() {
  const day = new Date();
  if (!store.get(harvestKey(day), 0)) day.setDate(day.getDate() - 1);
  let n = 0;
  while (n < 3650 && store.get(harvestKey(day), 0) > 0) {
    n++;
    day.setDate(day.getDate() - 1);
  }
  return n;
}

function allTime() {
  const pattern = FAST ? /^harvest-test-\d{4}-/ : /^harvest-\d{4}-/;
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (pattern.test(key)) total += store.get(key, 0);
    }
  } catch {}
  return total;
}

// ---------- model ----------

const m = {
  phase: 'idle',          // idle | focus | breakPending | rest | restDone
  running: false,
  remaining: focusLength(),
  endAt: 0,
  restLength: shortLength(),
  isLongBreak: false,
  line: '',
  stageKey: '',
  breakTitle: '', breakSub: '',
  welcomeTitle: '', welcomeSub: '',
  ideaIndex: 0, ideaSlot: -1,
  lastTick: Date.now(),
  lastRemaining: 0,
  endTimer: 0,
};

const clamp01 = x => Math.min(1, Math.max(0, x));

function progress() {
  switch (m.phase) {
    case 'breakPending': case 'restDone': return 1;
    case 'rest': return clamp01(1 - m.remaining / Math.max(1, m.restLength));
    default: return clamp01(1 - m.remaining / Math.max(1, focusLength()));
  }
}

/** How red the tomato is: it ripens while you focus and gets eaten during a break. */
const fill = () => m.phase === 'rest' ? clamp01(m.remaining / Math.max(1, m.restLength)) : progress();

function mood() {
  switch (m.phase) {
    case 'focus': return m.running ? 'awake' : 'sleepy';
    case 'breakPending': case 'restDone': return 'happy';
    case 'rest': return 'sleepy';
    default: return 'awake';
  }
}

function timeString() {
  const s = Math.ceil(m.remaining);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const breakLengthLabel = () => FAST ? `${Math.round(m.restLength)}s` : `${Math.max(1, Math.round(m.restLength / 60))} min`;

/** Picks a fresh line whenever the tomato reaches a new stage, never the same one twice in a row. */
function refreshLine() {
  let key;
  switch (m.phase) {
    case 'idle': key = 'idle'; break;
    case 'rest': key = 'rest'; break;
    case 'restDone': key = 'restDone'; break;
    case 'breakPending': key = 'pending'; break;
    default: {
      const p = progress();
      key = !m.running ? 'paused' : p < 0.2 ? 'focus0' : p < 0.45 ? 'focus1' : p < 0.7 ? 'focus2' : p < 0.9 ? 'focus3' : 'focus4';
    }
  }
  if (key === m.stageKey) return;
  m.stageKey = key;
  m.line = pick(key, LINES[key]);
}

function setLine(key) {
  m.stageKey = key;
  m.line = pick(key, LINES[key]);
}

function toggle() {
  if (m.phase === 'breakPending') return beginRest();
  m.running ? pause() : start();
}

function start() {
  askToNotify();
  if (m.phase === 'idle' || m.phase === 'restDone') {
    m.phase = 'focus';
    m.remaining = focusLength();
  }
  if (m.phase !== 'focus' && m.phase !== 'rest') return;
  run();
  refreshLine();
  render();
}

function startFocus() {
  stop();
  m.phase = 'focus';
  m.remaining = focusLength();
  run();
  refreshLine();
  render();
}

function pause() {
  if (!m.running) return;
  m.remaining = Math.max(0, (m.endAt - Date.now()) / 1000);
  stop();
  refreshLine();
  persist();
  render();
}

function reset() {
  stop();
  m.phase = 'idle';
  m.remaining = focusLength();
  refreshLine();
  persist();
  render();
}

function beginRest() {
  if (m.phase !== 'breakPending' && m.phase !== 'rest') return;
  m.phase = 'rest';
  m.remaining = m.restLength;
  m.ideaSlot = 0;
  m.ideaIndex = pickIndex('idea', LINES.ideas.length);
  run();
  refreshLine();
  persist();
  render();
}

// ---------- timer ----------

function run() {
  m.endAt = Date.now() + m.remaining * 1000;
  m.lastTick = Date.now();
  m.lastRemaining = m.remaining;
  m.running = true;
  scheduleEnd();
  persist();
}

function stop() {
  clearTimeout(m.endTimer);
  m.running = false;
  m.endAt = 0;
  persist();
}

/** One timeout straight to the finish: unlike the display tick, browsers barely throttle it in the background. */
function scheduleEnd() {
  clearTimeout(m.endTimer);
  m.endTimer = setTimeout(tick, Math.max(0, m.endAt - Date.now()) + 30);
}

function tick() {
  if (!m.running) return;
  const now = Date.now();
  const gap = now - m.lastTick;
  m.lastTick = now;
  // Ticks come every quarter second, so a gap this long means the computer slept.
  if (gap > 90_000) return handleGap();
  m.remaining = Math.max(0, (m.endAt - now) / 1000);
  m.lastRemaining = m.remaining;
  refreshLine();
  if (m.phase === 'rest') {
    const slot = Math.floor((m.restLength - m.remaining) / 55);
    if (slot !== m.ideaSlot) {
      m.ideaSlot = slot;
      m.ideaIndex = pickIndex('idea', LINES.ideas.length);
    }
  }
  if (m.remaining > 0) return render();
  stop();
  m.phase === 'focus' ? finishFocus() : finishRest();
}

/** The computer slept, or the window was frozen. Never punish that with an instant break. */
function handleGap() {
  if (m.phase === 'rest') {
    stop();
    return finishRest();  // being away from the desk is a break, after all
  }
  m.remaining = m.lastRemaining;
  stop();
  setLine('slept');
  render();
}

function finishFocus() {
  const today = todayCount() + 1;
  store.set(harvestKey(new Date()), today);
  m.isLongBreak = settings.longEvery > 1 && today % settings.longEvery === 0;
  m.restLength = m.isLongBreak ? longLength() : shortLength();
  m.breakTitle = m.isLongBreak ? pick('longTitle', LINES.longBreakTitles) : pick('breakTitle', LINES.breakTitles);
  m.breakSub = m.isLongBreak ? pick('longSub', LINES.longBreakSubs) : pick('breakSub', LINES.breakSubs);
  m.ideaSlot = -1;
  m.phase = 'breakPending';
  m.remaining = m.restLength;
  m.stageKey = '';
  refreshLine();
  persist();
  playChime();

  const title = m.isLongBreak ? 'Four tomatoes! Long break time 🌿' : 'Your tomato is ripe! 🍅';
  if (document.visibilityState === 'visible') {
    // In view: the break simply begins, just like on the Mac.
    if (!document.hasFocus()) notify(title, `Time for a ${breakLengthLabel()} break.`);
    beginRest();
  } else {
    // Out of sight: wait, so the break isn't spent before it's seen.
    notify(title, 'Click here to start your break.', true);
    render();
  }
}

function finishRest() {
  m.phase = 'restDone';
  const today = todayCount();
  m.welcomeTitle = pick('welcomeTitle', LINES.welcomeTitles);
  m.welcomeSub = today <= 1
    ? pick('welcomeFirst', LINES.welcomeFirst)
    : pick('welcomeMore', LINES.welcomeMore).replace('%d', today);
  m.stageKey = '';
  refreshLine();
  persist();
  playChime();
  if (!document.hasFocus()) notify(m.welcomeTitle, m.welcomeSub);
  render();
}

// Coming back to a waiting break starts it; that's what the notification click does too.
addEventListener('focus', () => { if (m.phase === 'breakPending') beginRest(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  tick();
  renderHarvest();
  if (m.phase === 'breakPending') beginRest();
});

// ---------- saving & restoring a session ----------

function persist() {
  if (FAST) return;
  store.set('state', {
    phase: m.phase, running: m.running, remaining: m.remaining, endAt: m.endAt,
    restLength: m.restLength, isLongBreak: m.isLongBreak,
    breakTitle: m.breakTitle, breakSub: m.breakSub,
  });
}

/** Pick up a session that was running when the window closed. */
function restore() {
  const s = FAST ? null : store.get('state', null);
  if (!s) return refreshLine();
  m.restLength = s.restLength > 0 ? s.restLength : shortLength();
  m.isLongBreak = !!s.isLongBreak;
  m.breakTitle = s.breakTitle || pick('breakTitle', LINES.breakTitles);
  m.breakSub = s.breakSub || pick('breakSub', LINES.breakSubs);
  const left = (s.endAt - Date.now()) / 1000;
  if (s.phase === 'focus' && s.running && left > 1) {
    m.phase = 'focus';
    m.remaining = left;
    run();
    setLine('restored');
  } else if (s.phase === 'focus' && !s.running && s.remaining > 1) {
    m.phase = 'focus';
    m.remaining = s.remaining;
    setLine('restored');
  } else if (s.phase === 'breakPending' || (s.phase === 'focus' && s.running)) {
    // A pending break, or one that ripened while the window was closed.
    m.phase = 'breakPending';
    m.remaining = m.restLength;
    refreshLine();
  } else if (s.phase === 'rest' && s.running && left > 1) {
    m.phase = 'rest';
    m.remaining = left;
    m.ideaIndex = pickIndex('idea', LINES.ideas.length);
    run();
    refreshLine();
  } else {
    refreshLine();
  }
  m.lastRemaining = m.remaining;
}

// ---------- notifications ----------

function askToNotify() {
  if (settings.notify && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(renderSettings);
  }
}

function notify(title, body, sticky = false) {
  if (!settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, icon: 'icons/icon-192.png', tag: 'tomatito', renotify: true, requireInteraction: sticky });
    n.onclick = () => { window.focus(); n.close(); if (m.phase === 'breakPending') beginRest(); };
  } catch {}
}

// ---------- icons ----------

const ICON = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  reset: 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
  gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z',
  back: 'M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  next: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  minus: 'M19 13H5v-2h14v2z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  chart: 'M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  pip: 'M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z',
  leaf: 'M6.05 8.05c-2.73 2.73-2.73 7.15-.02 9.88 1.47-3.4 4.09-6.24 7.36-7.93-2.77 2.34-4.71 5.61-5.39 9.32 2.6 1.23 5.8.78 7.95-1.37C19.43 14.47 20 4 20 4S9.53 4.57 6.05 8.05z',
  on: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
  off: 'M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
  sound: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  mute: 'M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a9 9 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z',
};
const icon = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[name]}"/></svg>`;

// ---------- the tomato ----------

// The Mac app's shapes, in a 100 x 92 box.
const BODY = 'M50 11.96C72 1.84 100 14.72 100 49.68C100 77.28 80 92 50 92C20 92 0 77.28 0 49.68C0 14.72 28 1.84 50 11.96Z';
const CALYX = (() => {
  const cx = 50, cy = 13.8, rx = 24, ry = 10, p = (a, k) => `${cx + Math.cos(a) * rx * k} ${cy + Math.sin(a) * ry * k}`;
  let d = '';
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + i * 2 * Math.PI / 5 + Math.PI / 5;
    d += `M${cx} ${cy}Q${p(a - 0.45, 0.55)} ${p(a, 1)}Q${p(a + 0.45, 0.55)} ${cx} ${cy}`;
  }
  return d;
})();

const INK = 'rgb(69,36,33)';

function faceMarkup(mood, lw) {
  const eyeY = 51.52, er = 4.2;
  let s = '';
  for (const x of [37, 63]) {
    if (mood === 'awake') {
      s += `<ellipse cx="${x}" cy="${eyeY}" rx="${er}" ry="${er * 1.2}" fill="${INK}"/>`;
      s += `<circle cx="${x + er * 0.275}" cy="${eyeY - er * 0.525}" r="${er * 0.425}" fill="#fff"/>`;
    } else {
      const dy = mood === 'sleepy' ? er * 1.3 : -er * 1.6;
      s += `<path d="M${x - er * 1.3} ${eyeY}Q${x} ${eyeY + dy} ${x + er * 1.3} ${eyeY}" fill="none" stroke="${INK}" stroke-width="${lw}" stroke-linecap="round"/>`;
    }
  }
  const my = 59.34;
  for (const x of [25, 75]) s += `<ellipse cx="${x}" cy="${my}" rx="6" ry="3" fill="rgb(255,128,153)" opacity=".5"/>`;
  s += mood === 'sleepy'
    ? `<ellipse cx="50" cy="${my + 1.25}" rx="1.5" ry="1.75" fill="${INK}"/>`
    : `<path d="M45.5 ${my}Q50 ${my + (mood === 'happy' ? 7.5 : 5)} 54.5 ${my}" fill="none" stroke="${INK}" stroke-width="${lw}" stroke-linecap="round"/>`;
  return s;
}

/** The red flesh: 0...1 progress mapped onto the visible body so "full" really looks full. */
function wavePath(p, t) {
  const level = p <= 0 ? 0 : p >= 1 ? 1 : 0.04 + p * 0.86;
  const amp = level <= 0.001 || level >= 0.999 ? 0 : 2.5;
  const y0 = 92 - level * 92;
  let d = 'M0 92';
  for (let x = 0; x <= 102; x += 2) d += `L${x} ${(y0 + Math.sin(x / 100 * Math.PI * 3 + t * 2.2) * amp).toFixed(2)}`;
  return d + 'L100 92Z';
}

let tomatoId = 0;
const liveTomatoes = new Set();

class Tomato {
  constructor(host, size, { animated = true } = {}) {
    const id = ++tomatoId, k = 100 / size;
    this.size = size;
    this.animated = animated;
    this.progress = 0;
    this.mood = '';
    this.bob = false;
    this.lw = Math.max(1, size * 0.02) * k;
    host.innerHTML = `
      <svg viewBox="0 0 100 92" width="${size}" height="${size * 0.92}" style="overflow:visible;display:block" aria-hidden="true">
        <defs>
          <clipPath id="tc${id}"><path d="${BODY}"/></clipPath>
          <linearGradient id="tg${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="92">
            <stop offset="0" stop-color="rgb(245,92,79)"/><stop offset="1" stop-color="rgb(209,51,51)"/>
          </linearGradient>
        </defs>
        <g class="bob">
          <path d="${BODY}" fill="rgb(255,232,224)"/>
          <path class="wave" clip-path="url(#tc${id})" fill="url(#tg${id})"/>
          <ellipse cx="25" cy="33.12" rx="8" ry="4" fill="#fff" opacity=".45" transform="rotate(-35 25 33.12)"/>
          <path d="${BODY}" fill="none" stroke="rgb(209,51,51)" stroke-opacity=".9" stroke-width="${Math.max(1, size * 0.022) * k}"/>
          <g class="face"></g>
          <rect x="49.75" y="-0.98" width="4.5" height="13" rx="2.25" fill="rgb(64,128,77)" transform="rotate(14 52 5.52)"/>
          <path d="${CALYX}" fill="rgb(102,179,102)" stroke="rgb(64,128,77)" stroke-width="${Math.max(0.5, size * 0.008) * k}"/>
          <g class="zzz" font-weight="900" fill="${INK}" text-anchor="middle" dominant-baseline="central">
            <text font-size="9">z</text><text font-size="12">z</text><text font-size="15">z</text>
          </g>
        </g>
      </svg>`;
    this.svg = host.firstElementChild;
    this.wave = this.svg.querySelector('.wave');
    this.face = this.svg.querySelector('.face');
    this.bobG = this.svg.querySelector('.bob');
    this.zzz = [...this.svg.querySelectorAll('.zzz text')];
    if (animated) liveTomatoes.add(this);
  }

  set(progress, mood, bob = false) {
    this.progress = progress;
    this.bob = bob;
    if (mood !== this.mood) {
      this.mood = mood;
      this.face.innerHTML = faceMarkup(mood, this.lw);
    }
    if (!this.animated || reduced.matches) this.frame(0);
    return this;
  }

  frame(t) {
    const still = !this.animated || reduced.matches;
    if (still) t = 0;
    this.wave.setAttribute('d', wavePath(this.progress, t));

    const sleepy = this.mood === 'sleepy' && !still;
    this.zzz.forEach((z, i) => {
      const q = (t * 0.35 + i / 3) % 1;
      z.setAttribute('x', 84 + 12 * q);
      z.setAttribute('y', 92 * (0.28 - 0.3 * q));
      z.setAttribute('opacity', sleepy ? 0.55 * Math.sin(q * Math.PI) : 0);
    });
    const s = this.bob && !still ? 1 + 0.018 * Math.sin(t * 2.4) : 1;
    this.bobG.setAttribute('transform', `translate(50 46) scale(${s}) translate(-50 -46)`);
  }
}

// ---------- elements ----------

const $ = id => document.getElementById(id);
const el = {
  primary: $('primary'), secondary: $('secondary'), setup: $('setup'), longChip: $('longChip'), ideaInline: $('ideaInline'),
  ambient: $('ambient'), dots: $('dots'), cycleText: $('cycleText'), openHarvest: $('openHarvest'), harvest: $('harvest'),
  todayNum: $('todayNum'), todayWord: $('todayWord'), weekTotal: $('weekTotal'), streak: $('streak'), allTime: $('allTime'),
  settings: $('settings'), scrim: $('scrim'), tomato: $('tomato'), time: $('time'), line: $('line'),
  focusControls: $('focusControls'), pendingControls: $('pendingControls'),
  toggle: $('toggle'), reset: $('reset'), takeBreak: $('takeBreak'),
  minutes: $('minutes'), basket: $('basket'), week: $('week'), summary: $('summary'),
  popOut: $('popOut'), openSettings: $('openSettings'),
  steps: $('steps'), chimeName: $('chimeName'),
  notifyCheck: $('notifyCheck'), notifyNote: $('notifyNote'), restore: $('restore'),
  brk: $('break'), bokeh: $('bokeh'), resting: $('resting'), welcome: $('welcome'), skip: $('skip'),
  longBadge: $('longBadge'), breakTitle: $('breakTitle'), breakSub: $('breakSub'), restTime: $('restTime'),
  breath: document.querySelector('.breath i'), breathWord: $('breathWord'), idea: $('idea'),
  welcomeTitle: $('welcomeTitle'), welcomeSub: $('welcomeSub'), done: $('done'), again: $('again'),
};

const bigTomato = new Tomato(el.tomato.firstElementChild, 290);
const restTomato = new Tomato($('restTomato'), 170).set(1, 'sleepy');
const welcomeTomato = new Tomato($('welcomeTomato'), 170).set(1, 'happy', true);

el.openSettings.innerHTML = icon('gear') + '<span class="desk-only">Settings</span>';
el.openHarvest.innerHTML = `<span class="desk-only hv">${icon('chart')}<span>Harvest</span><em class="num"></em></span>`
  + '<span class="phone-only hv"><span></span><span></span></span>';
const [harvestDesk, harvestPhone] = el.openHarvest.children;
const harvestTomato = new Tomato(harvestPhone.firstElementChild, 18, { animated: false });
el.popOut.innerHTML = icon('pip');
document.querySelectorAll('[data-close]').forEach(b => { b.innerHTML = icon('close'); });
el.reset.innerHTML = icon('reset');
el.takeBreak.innerHTML = icon('leaf') + '<span></span>';
el.again.innerHTML = icon('play') + 'Grow another tomato';
document.querySelectorAll('[data-chime="-1"]').forEach(b => { b.innerHTML = icon('back'); });
document.querySelectorAll('[data-chime="1"]').forEach(b => { b.innerHTML = icon('next'); });

// ---------- rendering ----------

let shownLine = '';
function renderLine() {
  if (m.line === shownLine) return;
  shownLine = m.line;
  if (reduced.matches || !el.line.textContent) { el.line.textContent = m.line; return; }
  el.line.classList.add('fade');
  setTimeout(() => { el.line.textContent = shownLine; el.line.classList.remove('fade'); }, 180);
}

function render() {
  const pending = m.phase === 'breakPending';
  bigTomato.set(fill(), mood(), m.running);
  el.time.textContent = pending ? breakLengthLabel() : timeString();
  renderLine();
  el.focusControls.hidden = pending;
  el.pendingControls.hidden = !pending;
  el.takeBreak.lastElementChild.textContent = `Take ${m.isLongBreak ? 'long break' : 'break'} now`;
  el.toggle.innerHTML = icon(m.running ? 'pause' : 'play') + (m.running ? 'Pause' : m.phase === 'focus' ? 'Resume' : 'Start focus');
  el.reset.disabled = m.phase === 'idle';
  el.summary.textContent = FAST ? 'fast test mode' : `${settings.focusMinutes} min focus · ${settings.shortMinutes} min break · ${settings.longMinutes} min long break`;
  renderCycle();
  renderPhone();
  document.title = m.running ? `${timeString()} · Tomatito` : 'Tomatito';
  renderBreak();
  drawMini();
  renderHarvest();
}

/** One dot per tomato in the set that earns a long break; the growing one fills up. */
let dotsShown = '';
function renderCycle() {
  const n = settings.longEvery;
  const pendingLong = m.phase === 'breakPending' && m.isLongBreak;
  const done = pendingLong ? n : todayCount() % n;
  const growing = m.phase === 'focus' ? done : -1;
  const pct = Math.round(progress() * 100);
  const sig = [phone.matches, n, done, growing, pct].join();
  if (sig !== dotsShown) {
    dotsShown = sig;
    if (phone.matches) {
      // On a phone, as in the iPhone app: little tomatoes, the growing one ripening.
      el.dots.textContent = '';
      for (let i = 0; i < n; i++) {
        const span = document.createElement('span');
        const now = i === growing;
        new Tomato(span, 22, { animated: false }).set(i < done ? 1 : now ? pct / 100 : 0, i < done ? 'happy' : 'awake');
        span.style.opacity = i < done || now ? 1 : 0.4;
        el.dots.append(span);
      }
    } else {
      let html = '';
      for (let i = 0; i < n; i++) {
        html += i < done ? '<b class="full"></b>' : i === growing ? `<b class="now" style="--p:${pct}%"></b>` : '<b></b>';
      }
      el.dots.innerHTML = html;
    }
  }
  const left = n - done;
  el.cycleText.textContent = pendingLong ? 'A long break, well earned 🌿'
    : left === 1 ? 'The next one earns a long break'
    : `${left} more for a long break`;
}

// ---------- phone ----------

const phone = matchMedia('(max-width: 600px)');
phone.addEventListener?.('change', () => { dotsShown = ''; render(); });

/** The one big button and the quiet one under it, as in the iPhone app. */
function phoneActions() {
  const n = settings.longEvery, round = todayCount() % n;
  switch (m.phase) {
    case 'idle':
      return [round > 0 ? `Start tomato ${round + 1} of ${n}` : 'Start', 'play', start, null, null];
    case 'focus':
      return [m.running ? 'Pause' : 'Keep going', m.running ? 'pause' : 'play', toggle, 'Stop', reset];
    case 'breakPending':
      return [`Start ${breakLengthLabel()} ${m.isLongBreak ? 'long break' : 'break'}`, 'leaf', beginRest, 'Skip the break', reset];
    case 'rest':
      return [m.running ? 'Pause' : 'Keep going', m.running ? 'pause' : 'play', toggle, 'Skip break', reset];
    default:
      return ['Start next tomato', 'play', startFocus, 'Stop for now', reset];
  }
}
let primaryAction = start, secondaryAction = null;

function renderPhone() {
  const resting = phone.matches && (m.phase === 'rest' || m.phase === 'breakPending');
  document.body.classList.toggle('resting', phone.matches && m.phase === 'rest');
  if (!phone.matches) return keepAwake();
  const [title, glyph, act, second, act2] = phoneActions();
  el.primary.innerHTML = icon(glyph) + title;
  el.primary.classList.toggle('green', resting);
  primaryAction = act;
  el.secondary.textContent = second || ' ';
  el.secondary.classList.toggle('none', !second);
  secondaryAction = act2;
  el.setup.hidden = m.phase !== 'idle';
  el.setup.textContent = FAST ? 'fast test mode' : `${settings.focusMinutes} min focus · ${settings.shortMinutes} min breaks`;
  el.longChip.hidden = !(m.isLongBreak && (m.phase === 'rest' || m.phase === 'breakPending'));
  el.ideaInline.hidden = m.phase !== 'rest';
  const [emoji, text] = LINES.ideas[m.ideaIndex % LINES.ideas.length];
  el.ideaInline.children[1].textContent = emoji;
  el.ideaInline.children[2].textContent = text;
  if (m.phase === 'restDone') el.time.textContent = '00:00';
  keepAwake();
}

// While a tomato grows, a propped-up phone stays readable across the room.
let wakeLock = null, wakeAsked = false;
async function keepAwake() {
  const want = phone.matches && m.running && document.visibilityState === 'visible' && 'wakeLock' in navigator;
  if (want && !wakeLock && !wakeAsked) {
    wakeAsked = true;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; wakeAsked = false; });
    } catch { wakeAsked = false; }
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

let harvestShown = '';
function renderHarvest() {
  const days = history(), today = days[6].count;
  const sig = JSON.stringify(days) + settings.focusMinutes;
  if (sig === harvestShown) return;
  harvestShown = sig;
  const focused = today * settings.focusMinutes;
  el.minutes.textContent = today > 0 ? (focused >= 60 ? `${Math.floor(focused / 60)} h ${focused % 60} min focused` : `${focused} min focused`) : '';
  el.todayNum.textContent = today;
  harvestDesk.lastElementChild.textContent = today;
  harvestPhone.lastElementChild.textContent = today ? `× ${today} today` : 'Harvest';
  harvestTomato.set(today ? 1 : 0, 'happy');
  el.todayWord.textContent = today === 1 ? 'tomato' : 'tomatoes';
  el.weekTotal.textContent = days.reduce((a, d) => a + d.count, 0);
  el.streak.textContent = streak();
  el.allTime.textContent = allTime();
  if (today === 0) {
    el.basket.textContent = pick('empty', LINES.emptyHarvest);
  } else {
    el.basket.textContent = '';
    for (let i = 0; i < Math.min(today, 12); i++) {
      const span = document.createElement('span');
      new Tomato(span, 30, { animated: false }).set(1, 'happy');
      el.basket.append(span);
    }
    if (today > 12) el.basket.insertAdjacentHTML('beforeend', `<b>+${today - 12}</b>`);
  }
  const peak = Math.max(1, ...days.map(d => d.count));
  el.week.innerHTML = days.map(d => `
    <div class="${d.isToday ? 'today' : d.count ? 'some' : ''}">
      <span class="n">${d.count || ''}</span>
      <span class="bar" style="height:${6 + 64 * d.count / peak}px"></span>
      <span class="d">${d.label}</span>
    </div>`).join('');
}

let ideaShown = -1;
function renderBreak() {
  // On a phone the break happens right on the main screen instead.
  const on = (m.phase === 'rest' || m.phase === 'restDone') && !phone.matches;
  if (el.brk.hidden === on) {
    el.brk.hidden = !on;
    if (on) sizeBokeh();
  }
  if (!on) return;
  const done = m.phase === 'restDone';
  el.resting.hidden = done;
  el.skip.hidden = done;
  el.welcome.hidden = !done;
  if (done) {
    el.welcomeTitle.textContent = m.welcomeTitle;
    el.welcomeSub.textContent = m.welcomeSub;
    return;
  }
  el.longBadge.hidden = !m.isLongBreak;
  el.longBadge.textContent = `LONG BREAK · ${breakLengthLabel()}`;
  el.breakTitle.textContent = m.breakTitle;
  el.breakSub.textContent = m.breakSub;
  el.restTime.textContent = timeString();
  if (m.ideaIndex !== ideaShown) {
    const first = ideaShown < 0;
    ideaShown = m.ideaIndex;
    const [emoji, text] = LINES.ideas[m.ideaIndex % LINES.ideas.length];
    const swap = () => {
      el.idea.firstElementChild.textContent = emoji;
      el.idea.lastElementChild.textContent = text;
      el.idea.classList.remove('fade');
    };
    if (first || reduced.matches) swap();
    else { el.idea.classList.add('fade'); setTimeout(swap, 400); }
  }
}


// ---------- settings panel ----------

const STEPS = [
  ['Focus', 'focusMinutes', 'min', 5, 90],
  ['Short break', 'shortMinutes', 'min', 1, 30],
  ['Long break', 'longMinutes', 'min', 5, 60],
  ['Long break after', 'longEvery', '🍅', 2, 8],
];

el.steps.innerHTML = STEPS.map(([label, key]) => `
  <div class="row"><span>${label}</span>
    <button class="mini press" data-step="${key}" data-by="-1" aria-label="Less">${icon('minus')}</button>
    <span class="val num" id="val-${key}"></span>
    <button class="mini press" data-step="${key}" data-by="1" aria-label="More">${icon('plus')}</button>
  </div>`).join('');

function renderSettings() {
  for (const [, key, unit, lo, hi] of STEPS) {
    $(`val-${key}`).textContent = `${settings[key]} ${unit}`;
    el.steps.querySelector(`[data-step="${key}"][data-by="-1"]`).disabled = settings[key] <= lo;
    el.steps.querySelector(`[data-step="${key}"][data-by="1"]`).disabled = settings[key] >= hi;
  }
  el.chimeName.innerHTML = icon(settings.chime === 'Silent' ? 'mute' : 'sound') + settings.chime;
  const supported = 'Notification' in window;
  const blocked = supported && Notification.permission === 'denied';
  const on = settings.notify && supported && !blocked;
  el.notifyCheck.classList.toggle('on', on);
  el.notifyCheck.firstElementChild.innerHTML = icon(on ? 'on' : 'off');
  el.notifyNote.textContent = !supported ? 'Not available in this browser'
    : blocked ? 'Blocked — allow notifications for this site to turn on'
    : 'A notification when it’s time for a break';
}

el.steps.addEventListener('click', e => {
  const b = e.target.closest('[data-step]');
  if (!b) return;
  const [, key, , lo, hi] = STEPS.find(s => s[1] === b.dataset.step);
  settings[key] = Math.min(hi, Math.max(lo, settings[key] + Number(b.dataset.by)));
  saveSettings();
  if (m.phase === 'idle') m.remaining = focusLength();
  renderSettings();
  render();
});

document.querySelectorAll('[data-chime]').forEach(b => b.addEventListener('click', () => {
  const i = CHIMES.indexOf(settings.chime);
  settings.chime = CHIMES[(i + Number(b.dataset.chime) + CHIMES.length) % CHIMES.length];
  saveSettings();
  renderSettings();
  playChime();  // hear what you picked
}));



el.notifyCheck.addEventListener('click', () => {
  if (!('Notification' in window) || Notification.permission === 'denied') return;
  settings.notify = !settings.notify;
  saveSettings();
  askToNotify();
  renderSettings();
});

el.restore.addEventListener('click', () => {
  Object.assign(settings, DEFAULTS);
  saveSettings();
  if (m.phase === 'idle') m.remaining = focusLength();
  renderSettings();
  render();
});

// Harvest and settings slide in from the side; one at a time.
const drawerOpen = () => document.body.classList.contains('drawer-open');
function showDrawer(drawer) {
  if (drawer === el.settings) renderSettings();
  for (const d of [el.harvest, el.settings]) {
    d.classList.toggle('open', d === drawer);
    d.inert = d !== drawer;
  }
  document.body.classList.toggle('drawer-open', !!drawer);
}
showDrawer(null);
el.openHarvest.addEventListener('click', () => showDrawer(el.harvest));
el.openSettings.addEventListener('click', () => showDrawer(el.settings));
el.scrim.addEventListener('click', () => showDrawer(null));
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => showDrawer(null)));

// ---------- mini timer: a floating video, so it stays on top in every browser ----------

// The timer is drawn onto a canvas that plays as a silent video; the browser's own
// picture-in-picture window then floats it above every other app. Its play/pause
// button starts and pauses the tomato.
const MINI_W = 600, MINI_H = 480;
const miniCanvas = document.createElement('canvas');
miniCanvas.width = MINI_W;
miniCanvas.height = MINI_H;
const miniVideo = document.createElement('video');
miniVideo.muted = true;
miniVideo.playsInline = true;
miniVideo.setAttribute('aria-hidden', 'true');
miniVideo.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0;pointer-events:none';

const BODY_PATH = new Path2D(BODY);
const CALYX_PATH = new Path2D(CALYX);
const miniOn = () => document.pictureInPictureElement === miniVideo;

function drawTomato2D(ctx, x, y, size, progress, mood) {
  const oval = (cx, cy, rx, ry) => { ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); };
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 100, size / 100);
  ctx.fillStyle = 'rgb(255,232,224)';
  ctx.fill(BODY_PATH);
  ctx.save();
  ctx.clip(BODY_PATH);
  const flesh = ctx.createLinearGradient(0, 0, 0, 92);
  flesh.addColorStop(0, 'rgb(245,92,79)');
  flesh.addColorStop(1, 'rgb(209,51,51)');
  ctx.fillStyle = flesh;
  ctx.fill(new Path2D(wavePath(progress, 0)));
  ctx.restore();
  ctx.save();
  ctx.translate(25, 33.12);
  ctx.rotate(-35 * Math.PI / 180);
  ctx.fillStyle = 'rgba(255,255,255,.45)';
  oval(0, 0, 8, 4);
  ctx.restore();
  ctx.strokeStyle = 'rgba(209,51,51,.9)';
  ctx.lineWidth = 2.2;
  ctx.stroke(BODY_PATH);

  // The face, as in faceMarkup.
  const ink = 'rgb(69,36,33)', eyeY = 51.52, er = 4.2, my = 59.34;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = ink;
  for (const ex of [37, 63]) {
    if (mood === 'awake') {
      ctx.fillStyle = ink;
      oval(ex, eyeY, er, er * 1.2);
      ctx.fillStyle = '#fff';
      oval(ex + er * 0.275, eyeY - er * 0.525, er * 0.425, er * 0.425);
    } else {
      ctx.beginPath();
      ctx.moveTo(ex - er * 1.3, eyeY);
      ctx.quadraticCurveTo(ex, eyeY + (mood === 'sleepy' ? er * 1.3 : -er * 1.6), ex + er * 1.3, eyeY);
      ctx.stroke();
    }
  }
  ctx.fillStyle = 'rgba(255,128,153,.5)';
  oval(25, my, 6, 3);
  oval(75, my, 6, 3);
  if (mood === 'sleepy') {
    ctx.fillStyle = ink;
    oval(50, my + 1.25, 1.5, 1.75);
  } else {
    ctx.beginPath();
    ctx.moveTo(45.5, my);
    ctx.quadraticCurveTo(50, my + (mood === 'happy' ? 7.5 : 5), 54.5, my);
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(52, 5.52);
  ctx.rotate(14 * Math.PI / 180);
  ctx.fillStyle = 'rgb(64,128,77)';
  ctx.beginPath();
  ctx.roundRect(-2.25, -6.5, 4.5, 13, 2.25);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = 'rgb(102,179,102)';
  ctx.fill(CALYX_PATH);
  ctx.strokeStyle = 'rgb(64,128,77)';
  ctx.lineWidth = 0.8;
  ctx.stroke(CALYX_PATH);
  ctx.restore();
}

/** Digits in fixed-width cells, so the countdown doesn't wobble as it ticks. */
function drawClock(ctx, text, cx, baseline) {
  const cell = ch => /\d/.test(ch) ? ctx.measureText('0').width : ctx.measureText(ch).width;
  const width = [...text].reduce((w, ch) => w + cell(ch), 0);
  let x = cx - width / 2;
  ctx.textAlign = 'center';
  for (const ch of text) {
    const w = cell(ch);
    ctx.fillText(ch, x + w / 2, baseline);
    x += w;
  }
}

/** Redraws only while the mini timer is showing, unless forced. */
function drawMini(force = false) {
  if (force !== true && !miniOn()) return;
  const ctx = miniCanvas.getContext('2d');
  const resting = m.phase === 'rest';
  const bg = ctx.createLinearGradient(0, 0, resting ? MINI_W : 0, MINI_H);
  bg.addColorStop(0, resting ? 'rgb(209,237,214)' : 'rgb(255,247,237)');
  bg.addColorStop(1, resting ? 'rgb(252,227,214)' : 'rgb(255,237,230)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, MINI_W, MINI_H);

  drawTomato2D(ctx, MINI_W / 2 - 110, 26, 220, fill(), mood());

  const ink = resting ? 'rgb(43,79,59)' : 'rgb(69,36,33)';
  ctx.fillStyle = ink;
  ctx.font = '800 138px Nunito, "Segoe UI", system-ui, sans-serif';
  if (m.phase === 'breakPending') {
    ctx.textAlign = 'center';
    ctx.font = '800 96px Nunito, "Segoe UI", system-ui, sans-serif';
    ctx.fillText('Break!', MINI_W / 2, 358);
  } else {
    drawClock(ctx, timeString(), MINI_W / 2, 368);
  }

  const note = m.phase === 'breakPending' ? 'Press play to start your break'
    : m.phase === 'idle' || m.phase === 'restDone' ? 'Press play to start'
    : !m.running ? 'Paused' : m.line;
  ctx.font = '700 30px Nunito, "Segoe UI", system-ui, sans-serif';
  ctx.globalAlpha = 0.6;
  ctx.textAlign = 'center';
  let line = note;
  while (line.length > 1 && ctx.measureText(line).width > MINI_W - 60) line = line.slice(0, -2) + '…';
  ctx.fillText(line, MINI_W / 2, 432);
  ctx.globalAlpha = 1;

  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = m.running ? 'playing' : 'paused';
}

async function openMini() {
  if (miniOn()) return document.exitPictureInPicture().catch(() => {});
  drawMini(true);
  try {
    if (miniVideo.paused) miniVideo.play().catch(() => {});
    await miniVideo.requestPictureInPicture();
    drawMini();
  } catch (err) {
    console.warn('Tomatito: mini timer unavailable', err);
  }
}

// The floating window's play/pause button starts and pauses the tomato.
let mediaPressed = 0;
function miniPlayPause() {
  mediaPressed = Date.now();
  if (m.phase === 'rest') return;
  toggle();
}
miniVideo.addEventListener('pause', () => {
  if (!miniOn()) return;
  // Safari's floating window pauses the video itself rather than asking us.
  if (Date.now() - mediaPressed > 500) miniPlayPause();
  miniVideo.play().catch(() => {});
});
miniVideo.addEventListener('enterpictureinpicture', drawMini);

if (document.pictureInPictureEnabled && miniCanvas.captureStream) {
  miniVideo.srcObject = miniCanvas.captureStream();
  document.body.append(miniVideo);
  drawMini(true);
  miniVideo.play().catch(() => {});
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: 'Tomatito', artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
      navigator.mediaSession.setActionHandler('play', miniPlayPause);
      navigator.mediaSession.setActionHandler('pause', miniPlayPause);
    } catch {}
  }
  el.popOut.hidden = false;
  document.fonts?.ready.then(() => drawMini(true));
}
el.popOut.addEventListener('click', openMini);

// ---------- controls ----------

el.toggle.addEventListener('click', toggle);
el.reset.addEventListener('click', reset);
el.takeBreak.addEventListener('click', beginRest);
el.again.addEventListener('click', startFocus);
el.done.addEventListener('click', reset);
el.primary.addEventListener('click', () => primaryAction?.());
el.secondary.addEventListener('click', () => secondaryAction?.());
el.setup.addEventListener('click', () => showDrawer(el.settings));

// The tomato wobbles like jelly when you poke it.
el.tomato.addEventListener('click', () => {
  if (phone.matches) primaryAction?.();  // on a phone the tomato is a big button too
  if (reduced.matches) return;
  const s = el.tomato.firstElementChild;
  s.classList.add('on');
  setTimeout(() => s.classList.remove('on'), 120);
});

// A springy pop and a ripple on release, so even the quickest click visibly lands.
document.addEventListener('pointerup', e => {
  const b = e.target.closest?.('.press');
  if (!b || b.disabled) return;
  b.classList.remove('pop');
  void b.offsetWidth;
  b.classList.add('pop');
});
document.addEventListener('animationend', e => { if (e.animationName === 'pop') e.target.classList.remove('pop'); });

addEventListener('keydown', e => {
  if (e.key === 'Enter' && m.phase === 'restDone' && !e.target.closest?.('button')) return startFocus();
  if (e.target.closest?.('button') && (e.key === ' ' || e.key === 'Enter')) return;
  if (e.key === 'Escape' && drawerOpen()) return showDrawer(null);
  if (drawerOpen() || !el.brk.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === ' ') { e.preventDefault(); toggle(); }
  if ((e.key === 'r' || e.key === 'R') && m.phase !== 'idle') reset();
});

// Skipping takes a deliberate four-second hold.
let holdTimer = 0;
function holdStart(e) {
  if (e.type === 'keydown' && (e.repeat || (e.key !== ' ' && e.key !== 'Enter'))) return;
  e.preventDefault();
  el.skip.classList.add('holding');
  el.skip.lastElementChild.textContent = 'Are you sure? Keep holding…';
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => { holdEnd(); reset(); }, 4000);
}
function holdEnd() {
  clearTimeout(holdTimer);
  el.skip.classList.remove('holding');
  el.skip.lastElementChild.textContent = 'Hold to skip break';
}
el.skip.addEventListener('pointerdown', holdStart);
el.skip.addEventListener('keydown', holdStart);
for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'keyup', 'blur']) el.skip.addEventListener(type, holdEnd);
el.skip.addEventListener('click', e => e.preventDefault());

// ---------- animation & clock ----------

function sizeBokeh() {
  const r = devicePixelRatio || 1;
  for (const c of [el.bokeh, el.ambient]) {
    c.width = innerWidth * r;
    c.height = innerHeight * r;
  }
}
addEventListener('resize', sizeBokeh);

const BOKEH_COLORS = ['245,92,79', '102,179,102', '255,255,255'];
const AMBIENT_COLORS = ['245,92,79', '252,190,160', '255,255,255'];
function drawBokeh(canvas, t, colors = BOKEH_COLORS, alpha = 0.1) {
  const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height, r0 = devicePixelRatio || 1;
  ctx.clearRect(0, 0, w, h);
  for (let i = 0; i < 16; i++) {
    const seed = i * 12.9898;
    const fx = Math.abs((Math.sin(seed) * 43758.5453) % 1);
    const speed = 0.012 + 0.01 * fx;
    const y = 1.1 - ((t * speed + fx * 3) % 1.3);
    const x = fx + 0.04 * Math.sin(t * 0.3 + seed);
    const r = (30 + 90 * ((i % 5) / 5)) * r0;
    ctx.fillStyle = `rgba(${colors[i % 3]},${alpha})`;
    ctx.beginPath();
    ctx.arc(x * w, y * h, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

const smallBreath = el.ideaInline.querySelector('.breath i'), smallWord = el.ideaInline.querySelector('.breath span');
function drawBreath(t) {
  const c = t % 8, s = 0.5 - 0.5 * Math.cos(c / 8 * 2 * Math.PI);
  const scale = reduced.matches ? 'scale(.73)' : `scale(${0.45 + 0.55 * s})`;
  el.breath.style.transform = smallBreath.style.transform = scale;
  el.breathWord.textContent = reduced.matches ? 'breathe slowly' : c < 4 ? 'breathe in' : 'breathe out';
  smallWord.textContent = reduced.matches ? 'breathe' : c < 4 ? 'in' : 'out';
}

function frame(now) {
  const t = reduced.matches ? 0 : (performance.timeOrigin + now) / 1000;
  for (const tm of liveTomatoes) tm.frame(t);
  if (!el.brk.hidden) { drawBokeh(el.bokeh, t); drawBreath(t); }
  else {
    const resting = document.body.classList.contains('resting');
    drawBokeh(el.ambient, t, resting ? BOKEH_COLORS : AMBIENT_COLORS, 0.09);
    if (resting) drawBreath(t);
  }
  requestAnimationFrame(frame);
}

/**
 * The clock ticks from a tiny worker: browsers slow a hidden page's own timers to
 * once a minute, which would freeze the mini timer while you work in another app.
 */
function startClock() {
  try {
    const src = 'setInterval(() => postMessage(0), 250)';
    new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))).onmessage = tick;
  } catch {
    setInterval(tick, 250);
  }
  requestAnimationFrame(frame);
}

// ---------- start up ----------

// First launch as an installed app: open at a comfortable size.
if (matchMedia('(display-mode: standalone)').matches && !store.get('sized', false)) {
  try { resizeTo(Math.min(1100, screen.availWidth), Math.min(780, screen.availHeight)); } catch {}
  store.set('sized', true);
}
sizeBokeh();

restore();
render();
startClock();
setInterval(renderHarvest, 60_000);  // midnight turns the page on the harvest

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
