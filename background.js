// Service worker: owns the timer, the badge, notifications and music.
// All state lives in chrome.storage.local so it survives the worker
// being suspended (MV3 workers are short-lived).

import { DEFAULT_SETTINGS, phraseMatches } from './lib/defaults.js';
import { buildAllowedHosts, hostOf, isAllowedUrl, isLockActive, isNewTabUrl, normalizeHost } from './lib/lock.js';

const ALARM_END = 'focus-end';
const ALARM_TICK = 'focus-tick';
const OFFSCREEN_URL = 'offscreen/offscreen.html';
const NOTIF_ID = 'focus-timeup';
const BLOCKED_PAGE = 'focus/blocked.html';
const NEWTAB_PAGE = 'focus/newtab.html';
const BLOCK_NOTIF_ID = 'focus-blocked';
const MAX_HISTORY = 200;
const MAX_RECENT_APPS = 12;

const COLORS = { running: '#5b5bd6', paused: '#8b8d98', timeup: '#2f9e6b' };

// ---------- storage helpers ----------

async function getSession() {
  return (await chrome.storage.local.get('session')).session || null;
}
async function setSession(session) {
  if (session) await chrome.storage.local.set({ session });
  else await chrome.storage.local.remove('session');
}
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
async function patchSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

const remainingMs = (s) => (s.status === 'running' ? Math.max(0, s.endsAt - Date.now()) : s.remainingMs ?? 0);

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(async () => {
  await patchSettings({});
  await reconcile();
});
chrome.runtime.onStartup.addListener(reconcile);

// After a browser restart (or anything odd), make the alarms/badge/music
// match what's stored.
async function reconcile() {
  const s = await getSession();
  if (!s) return updateBadge(null);
  if (s.status === 'running') {
    if (s.endsAt <= Date.now()) return timeUp();
    await scheduleAlarms(s);
    await startMusic(s.sound, s.volume);
    if (s.lock) await enforceLock();
  }
  await updateBadge(s);
}

// ---------- messages from the popup ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'background') return;
  handle(msg, sender)
    .then((r) => sendResponse({ ok: true, ...(r || {}) }))
    .catch((e) => {
      console.error(e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    });
  return true; // async response
});

async function handle(msg, sender) {
  switch (msg.type) {
    case 'start':
      return startSession(msg.plan);
    case 'pause':
      return pauseSession();
    case 'resume':
      return resumeSession();
    case 'extend':
      return extendSession(msg.minutes);
    case 'finish':
      return finishSession(msg.outcome, msg.phrase);
    case 'setSound':
      return setSound(msg.sound);
    case 'setVolume':
      return setVolume(msg.volume);
    case 'openApps':
      return openApps(msg.apps, msg.task);
    case 'allowHost':
      return allowHost(msg.host, sender.tab);
    case 'backToWork':
      return backToWork(sender.tab);
    default:
      throw new Error(`Unknown message: ${msg.type}`);
  }
}

// ---------- session control ----------

async function startSession(plan) {
  const task = String(plan?.task || '').trim();
  if (!task) throw new Error('Please describe your task first.');
  const minutes = Math.min(Math.max(Number(plan.minutes) || 25, 1), 480);

  // If an earlier session was left on the "time's up" screen, log it.
  const prev = await getSession();
  if (prev) await logHistory(prev, prev.status === 'timeup' ? 'timeup' : 'stopped');

  const now = Date.now();
  const apps = Array.isArray(plan.apps) ? plan.apps.slice(0, 30) : [];
  const settings = await getSettings();
  const session = {
    id: now,
    task,
    apps,
    plannedMs: minutes * 60_000,
    totalMs: minutes * 60_000,
    startedAt: now,
    endsAt: now + minutes * 60_000,
    remainingMs: null,
    status: 'running',
    sound: plan.sound || 'none',
    volume: typeof plan.volume === 'number' ? plan.volume : 0.5,
    lock: !!plan.lock,
    strict: !!(plan.lock && plan.strict),
    allowedHosts: buildAllowedHosts(apps, settings.alwaysAllowed),
  };
  await setSession(session);

  // Remember choices as next time's defaults.
  const recent = [...apps, ...settings.recentApps].filter(
    (a, i, arr) => arr.findIndex((b) => b.name === a.name && b.url === a.url) === i,
  );
  await patchSettings({
    defaultMinutes: minutes,
    sound: session.sound,
    volume: session.volume,
    openApps: !!plan.openApps,
    groupTabs: !!plan.groupTabs,
    lockBrowsing: !!plan.lock,
    strictMode: !!plan.strict,
    recentApps: recent.slice(0, MAX_RECENT_APPS),
  });

  chrome.notifications.clear(NOTIF_ID);
  await scheduleAlarms(session);
  await updateBadge(session);
  const opened = plan.openApps ? await openApps(apps, plan.groupTabs ? task : null) : { tabIds: [] };
  if (session.lock) await enforceLock(opened.tabIds[0]);
  const music = await startMusic(session.sound, session.volume);
  return { music };
}

async function pauseSession() {
  const s = await getSession();
  if (!s || s.status !== 'running') return;
  if (s.strict) throw new Error('Strict focus is on — pausing is turned off until the timer ends.');
  s.remainingMs = remainingMs(s);
  s.status = 'paused';
  await setSession(s);
  await chrome.alarms.clear(ALARM_END);
  await updateBadge(s);
  await stopMusic();
  await releaseLock();
}

async function resumeSession() {
  const s = await getSession();
  if (!s || s.status !== 'paused') return;
  s.endsAt = Date.now() + s.remainingMs;
  s.remainingMs = null;
  s.status = 'running';
  await setSession(s);
  await scheduleAlarms(s);
  await updateBadge(s);
  await startMusic(s.sound, s.volume);
  if (s.lock) await enforceLock();
}

async function extendSession(minutes) {
  const s = await getSession();
  if (!s) return;
  const add = Math.min(Math.max(Number(minutes) || 5, 1), 240) * 60_000;
  s.totalMs += add;
  if (s.status === 'running') s.endsAt += add;
  else if (s.status === 'paused') s.remainingMs += add;
  else if (s.status === 'timeup') {
    s.status = 'running';
    s.endsAt = Date.now() + add;
    s.remainingMs = null;
    chrome.notifications.clear(NOTIF_ID);
    await startMusic(s.sound, s.volume);
  }
  await setSession(s);
  if (s.status === 'running') await scheduleAlarms(s);
  if (isLockActive(s)) await enforceLock();
  await updateBadge(s);
}

async function finishSession(outcome = 'done', phrase = '') {
  const s = await getSession();
  if (!s) return;
  // Strict sessions can only end early with the emergency phrase.
  if (s.strict && s.status !== 'timeup' && !phraseMatches(phrase)) {
    throw new Error('Strict focus is on — type the emergency phrase to end early.');
  }
  await logHistory(s, outcome);
  await setSession(null);
  await chrome.alarms.clear(ALARM_END);
  await chrome.alarms.clear(ALARM_TICK);
  chrome.notifications.clear(NOTIF_ID);
  await stopMusic();
  await updateBadge(null);
  await releaseLock();
}

async function timeUp() {
  const s = await getSession();
  if (!s || s.status !== 'running') return;
  s.status = 'timeup';
  s.remainingMs = 0;
  s.endedAt = Date.now();
  await setSession(s);
  await chrome.alarms.clear(ALARM_TICK);
  await updateBadge(s);
  await stopMusic();
  await releaseLock();
  const settings = await getSettings();
  if (settings.chime) await sendToOffscreen({ type: 'chime', volume: s.volume });

  chrome.notifications.create(NOTIF_ID, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: "Time's up — nice focus!",
    message: `Did you finish: ${s.task}?`,
    buttons: [{ title: '✓ I finished' }, { title: '+5 more minutes' }],
    requireInteraction: true,
    priority: 2,
  });
}

async function logHistory(s, outcome) {
  const { history = [] } = await chrome.storage.local.get('history');
  const focusedMs = Math.max(0, s.totalMs - (s.status === 'timeup' ? 0 : remainingMs(s)));
  history.unshift({
    id: s.id,
    task: s.task,
    apps: (s.apps || []).map((a) => a.name),
    plannedMs: s.plannedMs,
    focusedMs,
    startedAt: s.startedAt,
    endedAt: Date.now(),
    outcome, // 'done' | 'stopped' | 'timeup'
  });
  await chrome.storage.local.set({ history: history.slice(0, MAX_HISTORY) });
}

// ---------- alarms, badge, notifications ----------

async function scheduleAlarms(s) {
  await chrome.alarms.create(ALARM_END, { when: s.endsAt });
  await chrome.alarms.create(ALARM_TICK, { periodInMinutes: 0.5 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_END) return timeUp();
  if (alarm.name === ALARM_TICK) {
    const s = await getSession();
    if (!s) return chrome.alarms.clear(ALARM_TICK);
    if (s.status === 'running' && s.endsAt <= Date.now()) return timeUp();
    return updateBadge(s);
  }
});

async function updateBadge(s) {
  let text = '';
  let color = COLORS.running;
  if (s?.status === 'running') {
    const min = Math.ceil(remainingMs(s) / 60_000);
    text = min >= 100 ? `${Math.round(min / 60)}h` : `${min}m`;
  } else if (s?.status === 'paused') {
    text = '❚❚';
    color = COLORS.paused;
  } else if (s?.status === 'timeup') {
    text = '✓';
    color = COLORS.timeup;
  }
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({ title: s ? `Focus Planner — ${s.task}` : 'Focus Planner' });
}

chrome.notifications.onButtonClicked.addListener((id, button) => {
  if (id !== NOTIF_ID) return;
  if (button === 0) finishSession('done');
  else extendSession(5);
});
chrome.notifications.onClicked.addListener((id) => {
  if (id !== NOTIF_ID) return;
  chrome.action.openPopup?.().catch(() => {});
});

// ---------- opening the user's apps ----------

async function openApps(apps = [], groupTitle = null) {
  const web = apps.filter((a) => a.type === 'web' && a.url);
  if (!web.length) return { opened: 0, tabIds: [] };
  const tabIds = [];
  for (const app of web) {
    try {
      const tab = await chrome.tabs.create({ url: app.url, active: false });
      tabIds.push(tab.id);
    } catch (e) {
      console.warn('Could not open', app.url, e);
    }
  }
  if (groupTitle && tabIds.length) {
    try {
      const groupId = await chrome.tabs.group({ tabIds });
      await chrome.tabGroups.update(groupId, { title: `🎯 ${groupTitle}`.slice(0, 40), color: 'purple' });
    } catch (e) {
      console.warn('Could not group tabs', e);
    }
  }
  return { opened: tabIds.length, tabIds };
}

// ---------- music (via an offscreen document) ----------

let creatingOffscreen = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (existing.length) return;
  creatingOffscreen ||= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Plays background focus sounds while the timer runs.',
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

async function hasOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  return (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })).length > 0;
}

async function sendToOffscreen(msg) {
  await ensureOffscreen();
  try {
    return await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
  } catch {
    // The document can be a moment late to start listening; try once more.
    await new Promise((r) => setTimeout(r, 150));
    return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
  }
}

async function startMusic(sound, volume) {
  if (!sound || sound === 'none') return stopMusic();
  return sendToOffscreen({ type: 'play', sound, volume });
}

async function stopMusic() {
  // Chrome closes an idle audio offscreen document by itself after ~30s.
  if (await hasOffscreen()) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {});
}

async function setSound(sound) {
  const s = await getSession();
  await patchSettings({ sound });
  if (!s) return;
  s.sound = sound;
  await setSession(s);
  if (s.status === 'running') return { music: await startMusic(sound, s.volume) };
}

async function setVolume(volume) {
  const v = Math.min(Math.max(Number(volume), 0), 1);
  const s = await getSession();
  await patchSettings({ volume: v });
  if (!s) return;
  s.volume = v;
  await setSession(s);
  if (await hasOffscreen()) await chrome.runtime.sendMessage({ target: 'offscreen', type: 'volume', volume: v }).catch(() => {});
}

// ---------- Focus Lock ----------
// While a locked session is running, only the session's web apps (and the
// user's always-allowed sites) can be visited, in every tab and every window,
// incognito included (when the extension is allowed there).
//  • Navigating to an off-limits site shows focus/blocked.html in that tab.
//  • Switching to an off-limits tab (or to a window showing one) shows a
//    single "guard" tab instead; the original tab is left untouched.
//  • New tabs show focus/newtab.html: your task, timer and app shortcuts.
//  • Strict mode also locks chrome:// pages (so the extension can't be
//    switched off mid-session) and unloads off-limits background tabs so
//    their videos/audio stop.
//  • Incognito can't show extension pages, so off-limits incognito tabs are
//    closed instead.
// Everything is restored when the session pauses (non-strict) or ends.

const ourPrefix = () => chrome.runtime.getURL('');
const isOurPage = (url) => !!url && url.startsWith(ourPrefix());
const blockedBase = () => chrome.runtime.getURL(BLOCKED_PAGE);
const newTabPage = () => chrome.runtime.getURL(NEWTAB_PAGE);
const blockedUrl = (params) => `${blockedBase()}?${new URLSearchParams(params)}`;
const tabUrl = (tab) => tab?.pendingUrl || tab?.url || '';

function blockedParams(url) {
  if (!url?.startsWith(blockedBase())) return null;
  return Object.fromEntries(new URL(url).searchParams);
}

// Per-window "last tab you were working in" and per-tab "last allowed URL",
// kept in session storage so they survive the worker sleeping.
async function getNav() {
  const { nav } = await chrome.storage.session.get('nav');
  return nav || { lastTab: {}, lastUrl: {} };
}
async function rememberAllowed(tab, url) {
  if (!tab || isOurPage(url) || !/^https?:/i.test(url)) return;
  const nav = await getNav();
  nav.lastUrl[tab.id] = url;
  if (tab.active) nav.lastTab[tab.windowId] = tab.id;
  await chrome.storage.session.set({ nav });
}

function notifyBlocked(url) {
  const host = hostOf(url) || 'That page';
  chrome.notifications.create(BLOCK_NOTIF_ID, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Stay focused 🎯',
    message: `${host} is off-limits until your focus session ends.`,
    priority: 1,
  });
}

// A tab is trying to show `url`. Returns true if we stepped in.
async function checkNavigation(tab, url, s) {
  if (!isLockActive(s) || !url) return false;
  if (isNewTabUrl(url)) {
    if (tab.incognito) return false; // incognito's own new tab page is harmless
    await chrome.tabs.update(tab.id, { url: newTabPage() }).catch(() => {});
    return true;
  }
  if (isAllowedUrl(url, s)) {
    await rememberAllowed(tab, url);
    return false;
  }
  if (tab.incognito) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    notifyBlocked(url);
  } else {
    await chrome.tabs.update(tab.id, { url: blockedUrl({ mode: 'nav', url }) }).catch(() => {});
  }
  return true;
}

// The user is now looking at `tab` (switched tab or window).
async function checkActiveTab(tab, s) {
  if (!tab || !isLockActive(s)) return;
  const url = tabUrl(tab);
  // Still loading (a brand-new tab or a fresh navigation): block it in place.
  if (isNewTabUrl(url) || tab.status === 'loading') return checkNavigation(tab, url, s);
  if (isAllowedUrl(url, s)) return rememberAllowed(tab, url);
  if (tab.incognito) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    notifyBlocked(url);
    return;
  }
  await showGuard(tab.windowId, url, tab.id);
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const s = await getSession();
  if (!isLockActive(s)) return;
  await checkActiveTab(await chrome.tabs.get(tabId).catch(() => null), s);
});

// Switching windows doesn't fire onActivated, so check the newly focused window too.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const s = await getSession();
  if (!isLockActive(s)) return;
  const [tab] = await chrome.tabs.query({ windowId, active: true });
  await checkActiveTab(tab, s);
});

// New tabs and new windows (including restored tabs and pop-ups).
chrome.tabs.onCreated.addListener(async (tab) => {
  const s = await getSession();
  if (!isLockActive(s)) return;
  await checkNavigation(tab, tabUrl(tab), s);
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const url = info.url || (info.status === 'loading' ? tabUrl(tab) : null);
  if (!url) return;
  const s = await getSession();
  if (!isLockActive(s)) return;
  await checkNavigation(tab, url, s);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const nav = await getNav();
  delete nav.lastUrl[tabId];
  await chrome.storage.session.set({ nav });
});

async function showGuard(windowId, url, fromTabId) {
  const params = { mode: 'tab', url, from: String(fromTabId) };
  const tabs = await chrome.tabs.query({ windowId });
  const guard = tabs.find((t) => blockedParams(tabUrl(t))?.mode === 'tab');
  if (guard) await chrome.tabs.update(guard.id, { url: blockedUrl(params), active: true });
  else await chrome.tabs.create({ windowId, url: blockedUrl(params), active: true });
}

// Run when a locked session starts, resumes or Chrome restarts: make sure no
// window is sitting on an off-limits page.
async function enforceLock(preferTabId) {
  const s = await getSession();
  if (!isLockActive(s)) return;
  if (preferTabId) await chrome.tabs.update(preferTabId, { active: true }).catch(() => {});
  const all = await chrome.tabs.query({});
  for (const tab of all) {
    const url = tabUrl(tab);
    if (tab.active) {
      await checkActiveTab(tab, s);
    } else if (!isAllowedUrl(url, s) && !isNewTabUrl(url)) {
      if (tab.incognito) await chrome.tabs.remove(tab.id).catch(() => {});
      // Strict: unload off-limits background tabs so videos/music in them stop.
      // They stay in the tab strip and reload when visited after the session.
      else if (s.strict && /^https?:/i.test(url) && !tab.discarded) await chrome.tabs.discard(tab.id).catch(() => {});
    }
  }
}

// Session paused/ended: send blocked tabs back where they were going, turn
// focus new-tab pages back into normal ones, and close guard tabs.
async function releaseLock() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const url = tabUrl(tab);
    if (url.startsWith(newTabPage())) {
      await chrome.tabs.update(tab.id, { url: 'chrome://newtab/' }).catch(() => {});
      continue;
    }
    const p = blockedParams(url);
    if (!p) continue;
    if (p.mode === 'nav' && p.url) await chrome.tabs.update(tab.id, { url: p.url }).catch(() => {});
    else if (p.mode === 'tab') await chrome.tabs.remove(tab.id).catch(() => {});
  }
  chrome.notifications.clear(BLOCK_NOTIF_ID);
}

// "Allow this site for this session" on the blocked page (never in strict mode).
async function allowHost(host, tab) {
  const s = await getSession();
  const settings = await getSettings();
  if (!s || s.strict || !settings.allowEscape) throw new Error('Allowing extra sites is turned off for this session.');
  const h = normalizeHost(host);
  if (!h) return;
  s.allowedHosts = [...new Set([...(s.allowedHosts || []), h])];
  await setSession(s);
  const p = blockedParams(tabUrl(tab)) || {};
  if (p.mode === 'nav' && p.url) await chrome.tabs.update(tab.id, { url: p.url });
  else if (p.mode === 'tab') {
    await chrome.tabs.update(Number(p.from), { active: true }).catch(() => {});
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// "Back to my work" on the blocked page.
async function backToWork(tab) {
  const s = await getSession();
  const nav = await getNav();
  const p = blockedParams(tabUrl(tab)) || {};

  // A tab that was navigated away from an allowed page: send it back there.
  const prev = nav.lastUrl[tab.id];
  if (p.mode === 'nav' && prev && isAllowedUrl(prev, s)) {
    await chrome.tabs.update(tab.id, { url: prev });
    return;
  }

  // Otherwise switch to the tab they were last working in…
  let target = null;
  const last = nav.lastTab[tab.windowId];
  if (last && last !== tab.id) target = await chrome.tabs.get(last).catch(() => null);
  // …or any open tab with one of their apps…
  if (!target || !/^https?:/i.test(tabUrl(target)) || !isAllowedUrl(tabUrl(target), s)) {
    const tabs = await chrome.tabs.query({ windowId: tab.windowId });
    target = tabs.find((t) => t.id !== tab.id && /^https?:/i.test(tabUrl(t)) && isAllowedUrl(tabUrl(t), s)) || null;
  }
  if (target) {
    await chrome.tabs.update(target.id, { active: true });
    await chrome.tabs.remove(tab.id).catch(() => {});
    return;
  }
  // …or, failing that, open their first app (or the focus new tab) right here.
  const firstApp = (s?.apps || []).find((a) => a.type === 'web' && a.url);
  await chrome.tabs.update(tab.id, { url: firstApp ? firstApp.url : newTabPage() });
}
