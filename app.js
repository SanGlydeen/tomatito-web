// Tomatito for the web: the same tomato, installable as an app from Edge or Chrome.
'use strict';

// ?fast shrinks the timers to seconds for testing, like TOMATITO_FAST on the Mac.
const FAST = new URLSearchParams(location.search).has('fast');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

// The stylesheet's springs, for animations started from here.
const rootStyle = getComputedStyle(document.documentElement);
const POP = rootStyle.getPropertyValue('--pop').trim() || 'cubic-bezier(.34, 1.56, .64, 1)';
const SETTLE = rootStyle.getPropertyValue('--settle').trim() || 'cubic-bezier(.2, .9, .3, 1)';

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
    // In view: the tomato is picked, then the break begins by itself, just like on the Mac.
    if (!document.hasFocus()) notify(title, `Time for a ${breakLengthLabel()} break.`);
    celebrate(beginRest);
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
addEventListener('focus', () => { if (m.phase === 'breakPending' && !celebrating) beginRest(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  tick();
  renderHarvest();
  if (m.phase === 'breakPending' && !celebrating) beginRest();
});

let celebrating = false;
/** A ripe tomato hops for joy and a little one flies into the harvest. Then the break blooms out of it. */
function celebrate(then) {
  if (reduced.matches) return then();
  celebrating = true;
  badgeHeld = todayCount() - 1;  // the new tomato isn't in the basket until it lands there
  render();
  bigTomato.hop(0.16);
  setTimeout(flyToHarvest, 330);
  setTimeout(() => {
    celebrating = false;
    if (m.phase === 'breakPending') then(); else render();
  }, 1350);
}

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

/** Where the juice sits for 0...1 progress, mapped onto the visible body so "full" really looks full. */
const juiceLevel = p => p <= 0 ? 0 : p >= 1 ? 1 : 0.04 + p * 0.86;

/** The juice's surface: a gentle ripple, tipped over while it sloshes. */
function wavePath(level, t, tilt = 0, amp = 2.5) {
  const a = level <= 0.001 || level >= 0.999 ? 0 : amp;
  // Nearly full or nearly empty, there's no room left to slosh.
  const slope = Math.tan(tilt) * Math.min(1, 5 * level * (1 - level));
  const y0 = 92 - level * 92;
  let d = 'M0 92';
  for (let x = 0; x <= 102; x += 2) d += `L${x} ${(y0 + slope * (x - 50) + Math.sin(x / 100 * Math.PI * 3 + t * 2.2) * a).toFixed(2)}`;
  return d + 'L100 92Z';
}

// The tomato is a small physical thing. Its juice, its jelly body and its gaze are springs,
// [stiffness, damping], stepped every frame, so anything can nudge them and they settle naturally.
const SPRINGS = {
  level: [34, 8.2],   // the juice pours in and settles with a little overshoot
  tilt: [62, 1.9],    // and sloshes from side to side a few times
  jelly: [210, 6],    // the body wobbles like jelly
  look: [140, 22],    // the eyes glide to what they're looking at
};
const GRAVITY = 9;    // tomato heights per second squared, for hops

const ARC = { happy: -1.6, sleepy: 1.3 };  // how closed eyes curve, in eye radii
const MOUTH = { awake: [4.5, 5, 0], happy: [4.5, 7.5, 0], sleepy: [0, 0, 1] };  // smile half-width, smile depth, "o"
const smooth = u => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);

/** The eyes partway through a change of mood. A change always happens behind a blink:
 *  the old eyes close, then the new ones open. */
function eyesAt(from, to, k) {
  const a = ARC[from], b = ARC[to];
  if (from === to) k = 1;
  if (from !== 'awake' && to !== 'awake') return { open: false, arc: a + (b - a) * smooth(k) };
  if (k < 0.45) {
    const u = smooth(k / 0.45);
    return from === 'awake' ? { open: true, lid: 1 - 0.92 * u } : { open: false, arc: a * (1 - u) };
  }
  const u = smooth((k - 0.45) / 0.55);
  return to === 'awake' ? { open: true, lid: 0.08 + 0.92 * u } : { open: false, arc: b * u };
}

let tomatoId = 0;
const liveTomatoes = new Set();

class Tomato {
  constructor(host, size, { animated = true } = {}) {
    const id = ++tomatoId, k = 100 / size, lw = Math.max(1, size * 0.02) * k;
    this.host = host;
    this.size = size;
    this.animated = animated;
    this.progress = 0;
    this.mood = 'awake';
    this.bob = false;
    host.innerHTML = `
      <svg viewBox="0 0 100 92" width="${size}" height="${size * 0.92}" style="overflow:visible;display:block" aria-hidden="true">
        <defs>
          <clipPath id="tc${id}"><path d="${BODY}"/></clipPath>
          <linearGradient id="tg${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="92">
            <stop offset="0" stop-color="rgb(245,92,79)"/><stop offset="1" stop-color="rgb(209,51,51)"/>
          </linearGradient>
        </defs>
        <g class="body">
          <path d="${BODY}" fill="rgb(255,232,224)"/>
          <path class="wave" clip-path="url(#tc${id})" fill="url(#tg${id})"/>
          <ellipse cx="25" cy="33.12" rx="8" ry="4" fill="#fff" opacity=".45" transform="rotate(-35 25 33.12)"/>
          <path d="${BODY}" fill="none" stroke="rgb(209,51,51)" stroke-opacity=".9" stroke-width="${Math.max(1, size * 0.022) * k}"/>
          <g class="face">
            <ellipse cx="25" cy="59.34" rx="6" ry="3" fill="rgb(255,128,153)" opacity=".5"/>
            <ellipse cx="75" cy="59.34" rx="6" ry="3" fill="rgb(255,128,153)" opacity=".5"/>
            <path class="smile" fill="none" stroke="${INK}" stroke-width="${lw}" stroke-linecap="round"/>
            <ellipse class="o" cx="50" cy="60.59" rx="1.5" ry="1.75" fill="${INK}"/>
            <g class="eyes">${[37, 63].map(x => `
              <g transform="translate(${x} 51.52)">
                <g class="open"><ellipse rx="4.2" ry="5.04" fill="${INK}"/><circle cx="1.155" cy="-2.205" r="1.785" fill="#fff"/></g>
                <path class="arc" fill="none" stroke="${INK}" stroke-width="${lw}" stroke-linecap="round"/>
              </g>`).join('')}
            </g>
          </g>
          <rect x="49.75" y="-0.98" width="4.5" height="13" rx="2.25" fill="rgb(64,128,77)" transform="rotate(14 52 5.52)"/>
          <path d="${CALYX}" fill="rgb(102,179,102)" stroke="rgb(64,128,77)" stroke-width="${Math.max(0.5, size * 0.008) * k}"/>
          <g class="zzz" font-weight="900" fill="${INK}" text-anchor="middle" dominant-baseline="central">
            <text font-size="9">z</text><text font-size="12">z</text><text font-size="15">z</text>
          </g>
        </g>
      </svg>`;
    const svg = this.svg = host.firstElementChild;
    const q = s => svg.querySelector(s), all = s => [...svg.querySelectorAll(s)];
    this.bodyG = q('.body');
    this.wave = q('.wave');
    this.faceG = q('.face');
    this.eyesG = q('.eyes');
    this.opens = all('.open');
    this.arcs = all('.arc');
    this.smile = q('.smile');
    this.o = q('.o');
    this.zzz = all('.zzz text');

    // Springs, the hop and the face. `face` remembers the mood it's changing from and when it started.
    this.s = { level: 0, levelV: 0, tilt: 0, tiltV: 0, jelly: 0, jellyV: 0, lookX: 0, lookXV: 0, lookY: 0, lookYV: 0 };
    this.air = 0;
    this.airV = 0;
    this.leap = null;     // a hop waiting for its anticipation squash to finish
    this.ripple = 0;
    this.bobbing = 0;
    this.sleepiness = 0;
    this.gaze = [0, 0];
    this.face = { from: 'awake', to: 'awake', at: -1 };
    this.blinkAt = 0;
    this.last = null;
    this.fresh = true;
    if (animated) liveTomatoes.add(this);
  }

  set(progress, mood, bob = false) {
    this.progress = progress;
    this.mood = mood;
    this.bob = bob;
    if (!this.animated || reduced.matches) this.still();
    return this;
  }

  /** Drawn at rest: no springs, no blinking. For little tomatoes, and for Reduce Motion. */
  still() {
    const s = this.s;
    s.level = juiceLevel(this.progress);
    s.levelV = s.tilt = s.tiltV = s.jelly = s.jellyV = s.lookX = s.lookY = s.lookXV = s.lookYV = 0;
    this.air = this.airV = this.ripple = 0;
    this.leap = null;
    this.bobbing = 0;
    this.sleepiness = this.mood === 'sleepy' && this.animated ? 1 : 0;
    this.face = { from: this.mood, to: this.mood, at: -1 };
    this.last = null;
    this.draw(0);
  }

  get visible() { return !this.host.closest('[hidden]'); }

  // Nudges. Each is a push on a spring; the physics does the rest.

  /** A tap. `side` is where it landed, -1 (left edge) to 1 (right edge). */
  poke(side = 0) {
    const s = this.s;
    s.tiltV += -Math.max(-1, Math.min(1, side || (Math.random() - 0.5))) * 2.6;
    s.jellyV += 3.4;
    this.ripple = Math.max(this.ripple, 1.2);
  }

  /** A little jump for joy: it crouches first, then leaves the ground. */
  hop(height = 0.12) {
    this.s.jellyV += 2.2;
    this.leap = { in: 0.09, v: Math.sqrt(2 * GRAVITY * height) };
  }

  /** Falls in from `height` tomato-heights above and lands with a squash and a slosh. */
  drop(height = 0.3) {
    this.air = height;
    this.airV = 0;
  }

  /** Whatever it's sitting on moved: `dv` is the change in sideways speed, in pixels per second. */
  push(dv) { this.s.tiltV += dv * 0.0011; }

  /** Where to look, as a direction no longer than 1. */
  lookAt(x, y) { this.gaze = [x, y]; }

  frame(t) {
    const s = this.s, target = juiceLevel(this.progress);
    if (this.fresh) { s.level = target; this.fresh = false; }
    const dt = this.last == null ? 0 : Math.min(0.05, Math.max(0, t - this.last));
    this.last = t;

    if (this.leap && (this.leap.in -= dt) <= 0) {
      this.airV = this.leap.v;
      this.leap = null;
    }
    const spring = (key, goal, [k, c], h) => {
      s[key + 'V'] += (-k * (s[key] - goal) - c * s[key + 'V']) * h;
      s[key] += s[key + 'V'] * h;
    };
    for (let left = dt; left > 1e-6; left -= 1 / 120) {
      const h = Math.min(left, 1 / 120);
      spring('level', target, SPRINGS.level, h);
      spring('tilt', 0, SPRINGS.tilt, h);
      spring('jelly', 0, SPRINGS.jelly, h);
      spring('lookX', this.gaze[0], SPRINGS.look, h);
      spring('lookY', this.gaze[1], SPRINGS.look, h);
      if (this.air > 0 || this.airV > 0) {
        this.airV -= GRAVITY * h;
        this.air += this.airV * h;
        if (this.air <= 0) {
          // Landing squashes the body and slops the juice about; a hard landing bounces once.
          const hit = -this.airV;
          this.air = 0;
          this.airV = hit > 1.6 ? hit * 0.2 : 0;
          s.jellyV += hit * 1.5;
          s.tiltV += (Math.random() < 0.5 ? -1 : 1) * hit * 0.9;
          this.ripple = Math.max(this.ripple, hit * 0.7);
        }
      }
    }
    this.ripple *= Math.exp(-2.4 * dt);
    this.bobbing += ((this.bob ? 1 : 0) - this.bobbing) * Math.min(1, dt * 2.5);
    this.sleepiness += ((this.mood === 'sleepy' ? 1 : 0) - this.sleepiness) * Math.min(1, dt * 3);
    this.draw(t);
  }

  draw(t) {
    const s = this.s;
    this.wave.setAttribute('d', wavePath(s.level, t, s.tilt, 2.5 * (1 + this.ripple)));

    // Squash and stretch about the bottom (it sits on something), the hop, and a slow breath while it grows.
    const j = Math.max(-0.28, Math.min(0.28, s.jelly));
    const breath = 1 + 0.018 * Math.sin(t * 2.4) * this.bobbing;
    this.bodyG.setAttribute('transform',
      `translate(0 ${(-this.air * 92).toFixed(2)}) translate(50 92) scale(${((1 + j) * breath).toFixed(4)} ${((1 - j) * breath).toFixed(4)}) translate(-50 -92)`);

    // The face turns a little toward what it looks at, and the eyes a little more.
    this.faceG.setAttribute('transform', `translate(${(s.lookX * 1.1).toFixed(2)} ${(s.lookY * 0.8).toFixed(2)})`);
    this.eyesG.setAttribute('transform', `translate(${(s.lookX * 1.5).toFixed(2)} ${(s.lookY * 1.2).toFixed(2)})`);

    const f = this.face;
    if (this.mood !== f.to) Object.assign(f, { from: f.to, to: this.mood, at: t });
    const k = f.at < 0 || !this.animated ? 1 : Math.min(1, (t - f.at) / 0.32);
    if (k >= 1) f.from = f.to;
    const eyes = eyesAt(f.from, f.to, k);

    // Every few seconds an awake tomato blinks, now and then twice.
    let lid = eyes.lid ?? 1;
    if (this.animated && eyes.open && k >= 1 && t > 0) {
      if (!this.blinkAt) this.blinkAt = t + 1.5 + Math.random() * 3;
      const u = t - this.blinkAt;
      if (u > 0.16) this.blinkAt = t + (Math.random() < 0.2 ? 0.08 : 2.5 + Math.random() * 3.5);
      else if (u >= 0) lid *= u < 0.06 ? 1 - 0.92 * (u / 0.06) : 0.08 + 0.92 * ((u - 0.06) / 0.1);
    }
    for (const g of this.opens) {
      g.style.display = eyes.open ? '' : 'none';
      g.setAttribute('transform', `scale(1 ${Math.max(0.06, lid).toFixed(3)})`);
    }
    for (const a of this.arcs) {
      a.style.display = eyes.open ? 'none' : '';
      if (!eyes.open) a.setAttribute('d', `M-5.46 0Q0 ${(eyes.arc * 4.2).toFixed(2)} 5.46 0`);
    }

    const [w0, c0, o0] = MOUTH[f.from], [w1, c1, o1] = MOUTH[f.to], e = smooth(k);
    const w = w0 + (w1 - w0) * e, c = c0 + (c1 - c0) * e, o = o0 + (o1 - o0) * e;
    this.smile.style.display = w > 0.05 ? '' : 'none';
    this.smile.setAttribute('d', `M${(50 - w).toFixed(2)} 59.34Q50 ${(59.34 + c).toFixed(2)} ${(50 + w).toFixed(2)} 59.34`);
    this.o.style.display = o > 0.02 ? '' : 'none';
    this.o.setAttribute('transform', `translate(50 60.59) scale(${o.toFixed(3)}) translate(-50 -60.59)`);

    // A sleepy tomato breathes out little z's.
    this.zzz.forEach((z, i) => {
      const q = (t * 0.35 + i / 3) % 1;
      z.setAttribute('x', 84 + 12 * q);
      z.setAttribute('y', 92 * (0.28 - 0.3 * q));
      z.setAttribute('opacity', this.animated && t ? (0.55 * Math.sin(q * Math.PI) * this.sleepiness).toFixed(3) : 0);
    });
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

// Buttons whose icon and words change get a slot for each, so the change can be animated.
const slots = '<span class="ico"></span><span class="lbl"></span>';
el.openSettings.innerHTML = icon('gear') + '<span class="desk-only">Settings</span>';
el.openHarvest.innerHTML = `<span class="desk-only hv">${icon('chart')}<span>Harvest</span><em class="num"></em></span>`
  + '<span class="phone-only hv"><span></span><span></span></span>';
const [harvestDesk, harvestPhone] = el.openHarvest.children;
const harvestTomato = new Tomato(harvestPhone.firstElementChild, 18, { animated: false });
el.popOut.innerHTML = icon('pip');
document.querySelectorAll('[data-close]').forEach(b => { b.innerHTML = icon('close'); });
el.reset.innerHTML = icon('reset');
for (const b of [el.toggle, el.takeBreak, el.primary, el.chimeName]) b.innerHTML = slots;
el.notifyCheck.firstElementChild.classList.add('ico');
el.again.innerHTML = icon('play') + 'Grow another tomato';
document.querySelectorAll('[data-chime="-1"]').forEach(b => { b.innerHTML = icon('back'); });
document.querySelectorAll('[data-chime="1"]').forEach(b => { b.innerHTML = icon('next'); });

// ---------- motion helpers ----------

/** Swaps an icon in its slot: the old one spins away as the new one springs in. */
function setIcon(slot, name) {
  if (slot.dataset.icon === name) return;
  const first = !slot.dataset.icon;
  slot.dataset.icon = name;
  let svg = slot.querySelector(`[data-i="${name}"]`);
  if (!svg) {
    slot.insertAdjacentHTML('beforeend', icon(name).replace('<svg', `<svg data-i="${name}"`));
    svg = slot.lastElementChild;
    if (!first && !reduced.matches) {
      svg.classList.add('off');
      svg.getBoundingClientRect();  // start from "off" so it transitions in
    }
  }
  for (const s of slot.children) s.classList.toggle('off', s !== svg);
}

/** Changes text by blurring the old words away and settling the new ones in from `from` (x and y in px). */
function swapText(node, text, from = [0, 6]) {
  if (node.dataset.text === text) return;
  const first = node.dataset.text === undefined;
  node.dataset.text = text;
  if (first || reduced.matches || node.closest('[hidden]')) { node.textContent = text; return; }
  if (node.fading) return;  // the fade already running will pick up the newest words
  const [x, y] = from;
  node.fading = node.animate([{ opacity: 1 }, { opacity: 0, transform: `translate(${-x}px, ${-y}px)`, filter: 'blur(4px)' }],
    { duration: 150, easing: 'ease-in', fill: 'forwards' });
  node.fading.onfinish = () => {
    node.textContent = node.dataset.text;
    node.fading.cancel();
    node.fading = null;
    node.animate([{ opacity: 0, transform: `translate(${x}px, ${y}px)`, filter: 'blur(4px)' }, { opacity: 1, transform: 'none', filter: 'none' }],
      { duration: 460, easing: SETTLE });
  };
}

/** Numbers that roll digit by digit, like a counter: down when time runs down, up when it goes back up. */
class Roller {
  constructor(node) { this.node = node; this.text = null; }
  set(text) {
    if (text === this.text) return;
    const old = this.text, n = this.node;
    this.text = text;
    const digit = ch => /\d/.test(ch);
    const same = old != null && old.length === text.length && [...text].every((ch, i) => digit(ch) === digit(old[i]));
    if (!same || reduced.matches || n.closest('[hidden]')) {
      n.innerHTML = [...text].map(ch => `<span class="roll"><span>${ch === ' ' ? '&nbsp;' : ch}</span></span>`).join('');
      if (old != null && !reduced.matches) n.animate([{ opacity: 0, filter: 'blur(6px)', transform: 'scale(.97)' }, {}], { duration: 460, easing: SETTLE });
      return;
    }
    const value = s => parseFloat(s.replace(':', '.'));
    const d = value(text) < value(old) ? 1 : -1;  // counting down, new digits drop in from above
    [...text].forEach((ch, i) => {
      if (ch === old[i]) return;
      const slot = n.children[i], now = slot.firstElementChild;
      slot.querySelectorAll('i').forEach(x => x.remove());
      const gone = document.createElement('i');
      gone.textContent = old[i];
      gone.setAttribute('aria-hidden', 'true');
      slot.append(gone);
      now.textContent = ch;
      now.animate([{ transform: `translateY(${-0.42 * d}em)`, opacity: 0, filter: 'blur(3px)' }, { transform: 'none', opacity: 1, filter: 'none' }],
        { duration: 520, easing: SETTLE });
      gone.animate([{ opacity: 1 }, { transform: `translateY(${0.42 * d}em)`, opacity: 0, filter: 'blur(3px)' }],
        { duration: 300, easing: 'ease-in', fill: 'forwards' }).onfinish = () => gone.remove();
    });
  }
}
const timeRoller = new Roller(el.time);
const restRoller = new Roller(el.restTime);

/** Plays a CSS animation class again from the start. */
function replay(node, cls) {
  if (reduced.matches) return;
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}

/** Counts a number up from zero, easing out, when a panel opens. */
function countUp(node, to) {
  if (reduced.matches || to < 2) { node.textContent = to; return; }
  const t0 = performance.now();
  const step = now => {
    const u = Math.min(1, (now - t0) / 700);
    node.textContent = Math.round(to * (1 - (1 - u) ** 3));
    if (u < 1) requestAnimationFrame(step);
  };
  node.textContent = 0;
  requestAnimationFrame(step);
}

/** Where the big tomato's heart is on screen: breaks bloom out of it and fold back into it. */
function tomatoCentre() {
  const r = el.tomato.getBoundingClientRect();
  return r.width ? [r.left + r.width / 2, r.top + r.height * 0.55] : [innerWidth / 2, innerHeight * 0.4];
}

/** A circle of a new scene spreading out of the tomato (or shrinking back into it). */
function bloom(node, open, { duration = open ? 950 : 560, then } = {}) {
  node.blooming?.cancel();
  node.blooming = null;
  if (reduced.matches) { then?.(); return; }
  const [x, y] = tomatoCentre();
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 40;
  const shut = `circle(0px at ${x}px ${y}px)`, wide = `circle(${r}px at ${x}px ${y}px)`;
  const a = node.animate({ clipPath: open ? [shut, wide] : [wide, shut] },
    { duration, easing: open ? 'cubic-bezier(.22, .7, .12, 1)' : 'cubic-bezier(.6, 0, .78, .3)', fill: 'forwards' });
  node.blooming = a;
  a.onfinish = () => {
    if (node.blooming !== a) return;
    node.blooming = null;
    then?.();
    a.cancel();
  };
}

/** The picked tomato flies in an arc into the harvest, which bumps as it lands. */
let badgeHeld = null;
function flyToHarvest() {
  const target = phone.matches ? harvestPhone.firstElementChild : harvestDesk.lastElementChild;
  const land = () => {
    badgeHeld = null;
    harvestShown = '';
    renderHarvest();
    target.animate([{ transform: 'scale(1.6)' }, { transform: 'none' }], { duration: 700, easing: POP });
    el.openHarvest.animate([{ transform: 'scale(1.1, .9)' }, { transform: 'none' }], { duration: 700, easing: POP });
  };
  const from = el.tomato.getBoundingClientRect(), to = target.getBoundingClientRect();
  if (reduced.matches || !from.width || !to.width) return land();
  const size = 60;
  const flyer = document.createElement('div');
  flyer.className = 'flyer';
  new Tomato(flyer, size, { animated: false }).set(1, 'happy');
  document.body.append(flyer);
  const [x0, y0] = [from.left + from.width / 2, from.top + from.height * 0.42];
  const [x1, y1] = [to.left + to.width / 2, to.top + to.height / 2];
  // Tossed up first, then over into the basket, never out of the window.
  const [cx, cy] = [x0 + (x1 - x0) * 0.25, Math.max(size * 0.4, Math.min(y0, y1) - Math.max(80, Math.abs(x1 - x0) * 0.25))];
  const s0 = from.width * 0.42 / size, s1 = Math.max(to.width, to.height) * 1.3 / size;
  const spin = x1 > x0 ? 1 : -1;
  const frames = [];
  for (let i = 0; i <= 30; i++) {
    const u = i / 30, v = 1 - u;
    const x = v * v * x0 + 2 * v * u * cx + u * u * x1, y = v * v * y0 + 2 * v * u * cy + u * u * y1;
    const s = i === 0 ? s0 * 0.5 : s0 + (s1 - s0) * smooth(u);
    frames.push({ transform: `translate(${x - size / 2}px, ${y - size * 0.46}px) rotate(${spin * 300 * u}deg) scale(${s})` });
  }
  const a = flyer.animate(frames, { duration: 820, easing: 'cubic-bezier(.4, 0, .25, 1)' });
  a.onfinish = () => { flyer.remove(); land(); };
}

// ---------- rendering ----------

function renderLine() { swapText(el.line, m.line); }

function render() {
  const pending = m.phase === 'breakPending' && !celebrating;
  bigTomato.set(fill(), mood(), m.running);
  timeRoller.set(celebrating || (phone.matches && m.phase === 'restDone') ? '00:00' : pending ? breakLengthLabel() : timeString());
  renderLine();
  el.focusControls.hidden = pending;
  el.pendingControls.hidden = !pending;
  setIcon(el.takeBreak.firstElementChild, 'leaf');
  swapText(el.takeBreak.lastElementChild, `Take ${m.isLongBreak ? 'long break' : 'break'} now`, [0, 4]);
  if (!celebrating) {
    setIcon(el.toggle.firstElementChild, m.running ? 'pause' : 'play');
    swapText(el.toggle.lastElementChild, m.running ? 'Pause' : m.phase === 'focus' ? 'Resume' : 'Start focus', [0, 4]);
  }
  el.reset.disabled = m.phase === 'idle';
  el.summary.textContent = FAST ? 'fast test mode' : `${settings.focusMinutes} min focus, ${settings.shortMinutes} min break, ${settings.longMinutes} min long break`;
  renderCycle();
  renderPhone();
  document.title = m.running ? `${timeString()} ${m.phase === 'rest' ? 'of break' : 'left'}` : 'Tomatito';
  renderBreak();
  drawMini();
  renderHarvest();
}

/** One dot per tomato in the set that earns a long break; the growing one fills up.
 *  A tomato joins the set with a pop, and a finished set gives a little cheer. */
let dotsShown = '', dotsDone = -1, dotsLong = false, growingDot = null;
function renderCycle() {
  const n = settings.longEvery;
  const pendingLong = m.phase === 'breakPending' && m.isLongBreak;
  const done = pendingLong ? n : todayCount() % n;
  const growing = m.phase === 'focus' ? done : -1;
  const p = progress();
  const sig = [phone.matches, n, done, growing].join();
  if (sig !== dotsShown) {
    const picked = dotsShown && dotsShown.split(',')[1] === String(n) && done === dotsDone + 1 ? done - 1 : -1;
    dotsShown = sig;
    dotsDone = done;
    growingDot = null;
    el.dots.textContent = '';
    for (let i = 0; i < n; i++) {
      const now = i === growing;
      let dot;
      if (phone.matches) {
        // On a phone, as in the iPhone app: little tomatoes, the growing one ripening.
        dot = document.createElement('span');
        const t = new Tomato(dot, 22, { animated: false }).set(i < done ? 1 : now ? p : 0, i < done ? 'happy' : 'awake');
        dot.style.opacity = i < done || now ? 1 : 0.4;
        if (now) growingDot = t;
      } else {
        dot = document.createElement('b');
        if (i < done) dot.className = 'full';
        if (now) { dot.className = 'now'; growingDot = dot; }
      }
      if (i === picked) dot.classList.add('picked');
      dot.style.setProperty('--i', i);
      el.dots.append(dot);
    }
  }
  if (pendingLong && !dotsLong) for (const d of el.dots.children) replay(d, 'cheer');
  dotsLong = pendingLong;
  if (growingDot instanceof Tomato) growingDot.set(p, 'awake');
  else if (growingDot) growingDot.style.setProperty('--p', `${Math.round(p * 100)}%`);
  const left = n - done;
  swapText(el.cycleText, pendingLong ? 'A long break, well earned 🌿'
    : left === 1 ? 'The next one earns a long break'
    : `${left} more for a long break`);
}

// ---------- phone ----------

const phone = matchMedia('(max-width: 600px)');
phone.addEventListener?.('change', () => { dotsShown = ''; breakShown = null; render(); });

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

/** On a phone the room itself turns mint for a break, the colour spreading out of the tomato. */
const tint = document.createElement('div');
tint.style.cssText = 'position:fixed;inset:0;pointer-events:none;display:none';
el.ambient.before(tint);
let roomResting = false;
function setRoom(resting) {
  if (resting === roomResting) return;
  roomResting = resting;
  if (reduced.matches || !phone.matches) { document.body.classList.toggle('resting', resting); return; }
  tint.style.background = resting ? 'linear-gradient(135deg, var(--mint), var(--peach))' : 'linear-gradient(var(--cream), var(--blush))';
  tint.style.display = '';
  bloom(tint, true, { duration: 900, then: () => { document.body.classList.toggle('resting', roomResting); tint.style.display = 'none'; } });
}

function renderPhone() {
  const resting = phone.matches && (m.phase === 'rest' || m.phase === 'breakPending');
  setRoom(phone.matches && m.phase === 'rest');
  if (!phone.matches) return keepAwake();
  if (!celebrating) {
    const [title, glyph, act, second, act2] = phoneActions();
    setIcon(el.primary.firstElementChild, glyph);
    swapText(el.primary.lastElementChild, title, [0, 4]);
    el.primary.classList.toggle('green', resting);
    primaryAction = act;
    swapText(el.secondary, second || ' ', [0, 4]);
    el.secondary.classList.toggle('none', !second);
    secondaryAction = act2;
  }
  el.setup.hidden = m.phase !== 'idle';
  el.setup.textContent = FAST ? 'fast test mode' : `${settings.focusMinutes} min focus, ${settings.shortMinutes} min breaks`;
  el.longChip.hidden = !(m.isLongBreak && (m.phase === 'rest' || m.phase === 'breakPending'));
  el.ideaInline.hidden = m.phase !== 'rest';
  const [emoji, text] = LINES.ideas[m.ideaIndex % LINES.ideas.length];
  swapText(el.ideaInline.children[1], emoji);
  swapText(el.ideaInline.children[2], text);
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
  const days = history(), today = days[6].count, badge = badgeHeld ?? today;
  const sig = JSON.stringify(days) + settings.focusMinutes + badge;
  if (sig === harvestShown) return;
  harvestShown = sig;
  const focused = today * settings.focusMinutes;
  el.minutes.textContent = today > 0 ? (focused >= 60 ? `${Math.floor(focused / 60)} h ${focused % 60} min focused` : `${focused} min focused`) : '';
  el.todayNum.textContent = today;
  harvestDesk.lastElementChild.textContent = badge;
  swapText(harvestPhone.lastElementChild, badge ? `× ${badge} today` : 'Harvest');
  harvestTomato.set(badge ? 1 : 0, 'happy');
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
      span.style.setProperty('--i', i);
      el.basket.append(span);
    }
    if (today > 12) el.basket.insertAdjacentHTML('beforeend', `<b style="--i:12">+${today - 12}</b>`);
  }
  const peak = Math.max(1, ...days.map(d => d.count));
  el.week.innerHTML = days.map((d, i) => `
    <div class="${d.isToday ? 'today' : d.count ? 'some' : ''}" style="--i:${i}">
      <span class="n">${d.count || ''}</span>
      <span class="bar" style="height:${6 + 64 * d.count / peak}px"></span>
      <span class="d">${d.label}</span>
    </div>`).join('');
}

/** The break screen blooms out of the tomato and, when it's over, folds back into it. */
let breakShown = false, breakWas = '';
function renderBreak() {
  // On a phone the break happens right on the main screen instead.
  const on = (m.phase === 'rest' || m.phase === 'restDone') && !phone.matches;
  if (on !== breakShown) {
    const first = breakShown === null;
    breakShown = on;
    if (on) {
      el.brk.hidden = false;
      sizeBokeh();
      if (!first) bloom(el.brk, true);
      restTomato.drop(0.3);
    } else if (!el.brk.hidden) {
      bloom(el.brk, false, { then: () => {
        el.brk.hidden = true;
        bigTomato.poke();  // the break went back into the tomato
      } });
      if (reduced.matches) el.brk.hidden = true;
    }
  }
  if (!on) { breakWas = ''; return; }
  const done = m.phase === 'restDone';
  const scene = done ? 'welcome' : 'resting';
  el.resting.hidden = done;
  el.skip.hidden = done;
  el.welcome.hidden = !done;
  if (scene !== breakWas) {
    // Each scene arrives in a cascade: the tomato, then the words, then the rest.
    breakWas = scene;
    const stage = done ? el.welcome : el.resting;
    [...stage.children].forEach((c, i) => c.style.setProperty('--i', i));
    replay(stage, 'enter');
    if (!done) replay(el.brk, 'enter-skip');
    if (done) {
      // It wakes up: eyes open from sleep into a smile, and it hops.
      welcomeTomato.set(1, 'sleepy', true);
      welcomeTomato.face = { from: 'sleepy', to: 'sleepy', at: -1 };
      setTimeout(() => { welcomeTomato.set(1, 'happy', true); welcomeTomato.hop(0.12); }, 520);
    }
    setTimeout(() => stage.classList.remove('enter'), 1600);
  }
  if (done) {
    swapText(el.welcomeTitle, m.welcomeTitle);
    swapText(el.welcomeSub, m.welcomeSub);
    return;
  }
  el.longBadge.hidden = !m.isLongBreak;
  el.longBadge.textContent = `Long break, ${breakLengthLabel()}`;
  swapText(el.breakTitle, m.breakTitle);
  swapText(el.breakSub, m.breakSub);
  restRoller.set(timeString());
  const [emoji, text] = LINES.ideas[m.ideaIndex % LINES.ideas.length];
  swapText(el.idea.firstElementChild, emoji, [0, 8]);
  swapText(el.idea.lastElementChild, text, [0, 8]);
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
const stepRollers = Object.fromEntries(STEPS.map(([, key]) => [key, new Roller($(`val-${key}`))]));

let chimeStep = 1;
function renderSettings() {
  for (const [, key, unit, lo, hi] of STEPS) {
    stepRollers[key].set(`${settings[key]} ${unit}`);
    el.steps.querySelector(`[data-step="${key}"][data-by="-1"]`).disabled = settings[key] <= lo;
    el.steps.querySelector(`[data-step="${key}"][data-by="1"]`).disabled = settings[key] >= hi;
  }
  // The chime's name slides in from the side you stepped toward.
  setIcon(el.chimeName.firstElementChild, settings.chime === 'Silent' ? 'mute' : 'sound');
  swapText(el.chimeName.lastElementChild, settings.chime, [14 * chimeStep, 0]);
  const supported = 'Notification' in window;
  const blocked = supported && Notification.permission === 'denied';
  const on = settings.notify && supported && !blocked;
  el.notifyCheck.classList.toggle('on', on);
  setIcon(el.notifyCheck.firstElementChild, on ? 'on' : 'off');
  el.notifyNote.textContent = !supported ? 'Not available in this browser'
    : blocked ? 'Blocked. Allow notifications for this site to turn this on.'
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
  chimeStep = Number(b.dataset.chime);
  settings.chime = CHIMES[(i + chimeStep + CHIMES.length) % CHIMES.length];
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

// Harvest and settings slide in from the side (up from the bottom on a phone); one at a time.
// What's inside follows a beat behind, and the harvest grows its week and counts its tomatoes.
const drawerOpen = () => document.body.classList.contains('drawer-open');
function showDrawer(drawer) {
  if (drawer === el.settings) renderSettings();
  for (const d of [el.harvest, el.settings]) {
    const opening = d === drawer && !d.classList.contains('open');
    d.classList.toggle('open', d === drawer);
    d.inert = d !== drawer;
    if (!opening) continue;
    [...d.children].forEach((c, i) => c.style.setProperty('--i', i));
    if (d === el.harvest) {
      renderHarvest();
      replay(d, 'grow');
      const week = history().reduce((a, day) => a + day.count, 0);
      for (const [node, value] of [[el.todayNum, todayCount()], [el.weekTotal, week], [el.streak, streak()], [el.allTime, allTime()]]) {
        countUp(node, value);
      }
    }
  }
  document.body.classList.toggle('drawer-open', !!drawer);
}
showDrawer(null);
el.openHarvest.addEventListener('click', () => showDrawer(el.harvest));
el.openSettings.addEventListener('click', () => showDrawer(el.settings));
el.scrim.addEventListener('click', () => showDrawer(null));
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => showDrawer(null)));

// On a phone the drawers are sheets: pull one down by its handle or title to put it away.
for (const d of [el.harvest, el.settings]) {
  let y0 = 0, dy = 0, v = 0, lastY = 0, lastT = 0, held = false;
  d.addEventListener('pointerdown', e => {
    if (!phone.matches || !d.classList.contains('open') || e.target.closest('button')) return;
    if (!e.target.closest('.grab, header')) return;
    held = true;
    y0 = lastY = e.clientY;
    lastT = e.timeStamp;
    dy = v = 0;
    try { d.setPointerCapture(e.pointerId); } catch {}  // keep following the finger outside the sheet
    d.classList.add('dragging');
  });
  d.addEventListener('pointermove', e => {
    if (!held) return;
    const raw = e.clientY - y0;
    dy = raw > 0 ? raw : -Math.sqrt(-raw) * 2;  // pulling up only stretches a little
    v = (e.clientY - lastY) / Math.max(1, e.timeStamp - lastT);
    lastY = e.clientY;
    lastT = e.timeStamp;
    d.style.transform = `translateY(${dy}px)`;
    el.scrim.style.opacity = String(Math.max(0, 1 - Math.max(0, dy) / d.offsetHeight));
  });
  const letGo = () => {
    if (!held) return;
    held = false;
    d.classList.remove('dragging');
    d.style.transform = '';
    el.scrim.style.opacity = '';
    if (dy > 110 || v > 0.5) showDrawer(null);  // far enough, or flicked: it carries on down
  };
  d.addEventListener('pointerup', letGo);
  d.addEventListener('pointercancel', letGo);
}

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
  ctx.fill(new Path2D(wavePath(juiceLevel(progress), 0)));
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

// The tomato wobbles like jelly when you poke it, and its juice sloshes away from your finger.
el.tomato.addEventListener('click', e => {
  if (phone.matches) primaryAction?.();  // on a phone the tomato is a big button too
  const r = el.tomato.getBoundingClientRect();
  bigTomato.poke((e.clientX - (r.left + r.width / 2)) / (r.width / 2));
});

// A springy pop and a ripple on release, so even the quickest click visibly lands.
document.addEventListener('pointerup', e => {
  const b = e.target.closest?.('.press');
  if (!b || b.disabled) return;
  replay(b, 'pop');
});
document.addEventListener('animationend', e => { if (e.animationName === 'pop') e.target.classList.remove('pop'); });

addEventListener('keydown', e => {
  if (e.key === 'Enter' && m.phase === 'restDone' && !e.target.closest?.('button')) return startFocus();
  if (e.target.closest?.('button') && (e.key === ' ' || e.key === 'Enter')) return;
  if (e.key === 'Escape' && drawerOpen()) return showDrawer(null);
  if (drawerOpen() || !el.brk.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  // Keys press the button they stand for, so the button answers the same way a click does.
  if (e.key === ' ') { e.preventDefault(); replay(el.pendingControls.hidden ? el.toggle : el.takeBreak, 'pop'); toggle(); }
  if ((e.key === 'r' || e.key === 'R') && m.phase !== 'idle') { replay(el.reset, 'pop'); reset(); }
});

// Skipping takes a deliberate four-second hold. The button fills with juice while you hold
// (and ticks on phones that can buzz); let go early and it drains away.
let holdTimer = 0, holdTicks = [];
const skipTexts = el.skip.querySelectorAll('.skip-text');
function skipSay(text) {
  if (skipTexts[0].textContent === text) return;
  const w0 = el.skip.offsetWidth;
  skipTexts.forEach(t => { t.textContent = text; });
  const w1 = el.skip.offsetWidth;
  if (w0 !== w1 && !reduced.matches) el.skip.animate([{ width: `${w0}px` }, { width: `${w1}px` }], { duration: 450, easing: SETTLE });
}
function holdStart(e) {
  if (e.type === 'keydown' && (e.repeat || (e.key !== ' ' && e.key !== 'Enter'))) return;
  e.preventDefault();
  el.skip.classList.add('holding');
  skipSay('Are you sure? Keep holding…');
  clearTimeout(holdTimer);
  holdTicks.forEach(clearTimeout);
  holdTicks = [1000, 2000, 3000].map(ms => setTimeout(() => navigator.vibrate?.(8), ms));
  holdTimer = setTimeout(() => {
    el.skip.classList.add('done');
    navigator.vibrate?.(24);
    holdTimer = setTimeout(() => { holdEnd(); reset(); }, 180);
  }, 4000);
}
function holdEnd() {
  clearTimeout(holdTimer);
  holdTicks.forEach(clearTimeout);
  el.skip.classList.remove('holding', 'done');
  skipSay('Hold to skip break');
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
/** Soft circles drifting up. During a break the whole room breathes with the guide. */
function drawBokeh(canvas, t, colors = BOKEH_COLORS, alpha = 0.1, breath = 0.5) {
  const ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height, r0 = (devicePixelRatio || 1) * (0.96 + 0.08 * breath);
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
/** In for four seconds, out for four. Returns how full the lungs are, 0 to 1. */
function drawBreath(t) {
  const c = t % 8, s = 0.5 - 0.5 * Math.cos(c / 8 * 2 * Math.PI);
  const scale = reduced.matches ? 'scale(.73)' : `scale(${0.45 + 0.55 * s})`;
  el.breath.style.transform = smallBreath.style.transform = scale;
  swapText(el.breathWord, reduced.matches ? 'breathe slowly' : c < 4 ? 'breathe in' : 'breathe out', [0, 4]);
  swapText(smallWord, reduced.matches ? 'breathe' : c < 4 ? 'in' : 'out', [0, 3]);
  return s;
}

// The big tomato glances toward the pointer, and its juice sloshes when the window is dragged around.
let pointer = null, lastLook = '', win = null;
if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
  addEventListener('pointermove', e => { pointer = [e.clientX, e.clientY]; }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { pointer = null; });
  addEventListener('blur', () => { pointer = null; });
}
function feel(t) {
  const key = pointer ? pointer.join() : '';
  if (key !== lastLook) {
    lastLook = key;
    if (!pointer) bigTomato.lookAt(0, 0);
    else {
      const [cx, cy] = tomatoCentre(), dx = pointer[0] - cx, dy = pointer[1] - cy, d = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, d / 260) / d;
      bigTomato.lookAt(dx * reach, dy * reach);
    }
  }
  const x = screenX;
  if (win && t > win.t) {
    const v = (x - win.x) / (t - win.t);
    if (Math.abs(x - win.x) < 400) bigTomato.push(v - win.v);
    win = { x, t, v };
  } else win = { x, t, v: 0 };
}

let aloft = 0;
function frame(now) {
  const t = reduced.matches ? 0 : (performance.timeOrigin + now) / 1000;
  if (!reduced.matches) {
    feel(t);
    for (const tm of liveTomatoes) if (tm.visible) tm.frame(t);
    // The shadow under the big tomato shrinks while it's in the air.
    const air = Math.min(1, bigTomato.air * 4);
    if (air || aloft) el.tomato.style.setProperty('--air', air.toFixed(3));
    aloft = air;
  }
  if (!el.brk.hidden) {
    const breath = drawBreath(t);
    drawBokeh(el.bokeh, t, BOKEH_COLORS, 0.1, breath);
  } else {
    const resting = document.body.classList.contains('resting');
    const breath = resting ? drawBreath(t) : 0.5;
    drawBokeh(el.ambient, t, resting ? BOKEH_COLORS : AMBIENT_COLORS, 0.09, breath);
  }
  requestAnimationFrame(frame);
}

// Reduce Motion can be switched on and off while the app is open.
reduced.addEventListener?.('change', () => {
  for (const tm of liveTomatoes) tm.set(tm.progress, tm.mood, tm.bob);
  render();
});

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

// Opening the app: the tomato drops in, lands with a squash and a slosh, and everything settles around it.
if (!reduced.matches) {
  [...document.querySelector('.room').children].forEach((c, i) => c.style.setProperty('--i', i));
  document.body.classList.add('arrive');
  bigTomato.drop(0.3);
  setTimeout(() => document.body.classList.remove('arrive'), 2000);
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
