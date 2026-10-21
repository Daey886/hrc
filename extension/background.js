/**
 * Hermes Remote Control - Background Service Worker
 * Connects to the relay server via WebSocket and executes CDP commands.
 */

const DEFAULT_SERVER = 'ws://127.0.0.1:8765';
const RECONNECT_DELAY_MS = 3000;
const CDP_COMMAND_TIMEOUT_MS = 30000;

let ws = null;
let wsId = 0;              // increments on every (re)connect, invalidates stale timers
let attachedTabs = new Map(); // tabId -> { version }
let connected = false;
let clientId = null;

// ---------- helpers ----------

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function log(...args) {
  console.log('[HermesRC]', ...args);
}

async function getServerUrl() {
  const { serverUrl } = await chrome.storage.local.get('serverUrl');
  return serverUrl || DEFAULT_SERVER;
}

// Device name: manually set in popup; falls back to the computer's hostname
// captured once (navigator.deviceMemory etc. are not available, use UA hint).
async function getDeviceName() {
  const { deviceName } = await chrome.storage.local.get('deviceName');
  if (deviceName && deviceName.trim()) return deviceName.trim();
  const { autoName } = await chrome.storage.local.get('autoName');
  if (autoName) return autoName;
  // Derive a readable default from the UA platform (best effort in SW context)
  const ua = navigator.userAgent;
  let guess = 'Chrome-PC';
  if (/Windows NT 10/.test(ua)) guess = 'Windows-PC';
  else if (/Mac OS X/.test(ua)) guess = 'Mac';
  else if (/CrOS/.test(ua)) guess = 'ChromeOS';
  else if (/Linux/.test(ua)) guess = 'Linux-PC';
  await chrome.storage.local.set({ autoName: guess });
  return guess;
}

// Attach the debugger to a tab (auto re-attach if detached).
async function ensureAttached(tabId) {
  let info = attachedTabs.get(tabId);
  if (info) return info;
  const version = '1.3';
  await chrome.debugger.attach({ tabId }, version);
  // Ignore events (incl. detach) to keep the session alive
  try { chrome.debugger.onEvent.removeListener(() => {}); } catch (e) {}
  attachedTabs.set(tabId, { version });
  return attachedTabs.get(tabId);
}

async function detach(tabId) {
  if (!attachedTabs.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch (e) {}
  attachedTabs.delete(tabId);
}

function cleanupDetached(tabId) {
  attachedTabs.delete(tabId);
}

// ---------- CDP command execution ----------

async function execCdp(payload) {
  const { command, params = {}, tabId } = payload;

  // Tab management commands handled natively
  switch (command) {
    case 'Tab.new': {
      // Open in foreground by default; pass active:false explicitly for background tabs
      const tab = await chrome.tabs.create({
        url: params.url || 'about:blank',
        active: params.active !== false
      });
      return { tabId: tab.id };
    }
    case 'Tab.close': {
      await chrome.tabs.remove(Number(tabId));
      return {};
    }
    case 'Tab.list': {
      const tabs = await chrome.tabs.query({});
      return tabs.map(t => ({
        id: t.id, title: t.title, url: t.url,
        active: t.active, windowId: t.windowId,
        index: t.index, pinned: t.pinned
      }));
    }
    case 'Tab.activate': {
      await chrome.tabs.update(Number(tabId), { active: true });
      await chrome.windows.update((await chrome.tabs.get(Number(tabId))).windowId, { focused: true });
      return {};
    }
    case 'Tab.navigate': {
      await chrome.tabs.update(Number(tabId), { url: params.url });
      return {};
    }
    case 'Tab.screenshot': {
      const tab = await chrome.tabs.get(Number(tabId));
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return { data: dataUrl };
    }
  }

  // CDP commands require an attached debugger
  if (tabId == null) throw new Error(`command ${command} requires tabId`);
  const tid = Number(tabId);
  await ensureAttached(tid);

  // Page.evaluate-like helper for JS evaluation
  if (command === 'Runtime.evaluate') {
    // keep default CDP path but force returnByValue & awaitPromise for convenience
    params.returnByValue = params.returnByValue !== false;
    params.awaitPromise = params.awaitPromise !== false;
  }

  const result = await chrome.debugger.sendCommand({ tabId: tid }, command, params);
  return result;
}

// Wrap execCdp with timeout + tab lifecycle tracking
async function execCdpSafe(payload) {
  const tid = payload.tabId != null ? Number(payload.tabId) : null;
  try {
    const result = await Promise.race([
      execCdp(payload),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('CDP command timeout')), CDP_COMMAND_TIMEOUT_MS)
      )
    ]);
    return { ok: true, result };
  } catch (err) {
    if (tid != null && /detached|closed|not attached|No tab with/i.test(String(err && err.message))) {
      cleanupDetached(tid);
    }
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// ---------- WebSocket connection ----------

async function connect() {
  const myId = ++wsId;
  const serverUrl = await getServerUrl();
  log('connecting to', serverUrl);

  try {
    ws = new WebSocket(serverUrl);
  } catch (e) {
    log('connect failed:', e);
    scheduleReconnect(myId);
    return;
  }

  ws.onopen = async () => {
    if (myId !== wsId) { try { ws.close(); } catch (e) {} return; }
    connected = true;
    clientId = 'ext-' + Math.random().toString(36).slice(2, 10);
    const deviceName = await getDeviceName();
    send({ type: 'hello', clientId, role: 'extension', deviceName, ua: navigator.userAgent });
    updateBadge();
    log('connected as', deviceName);
  };

  ws.onmessage = async (ev) => {
    if (myId !== wsId) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }

    if (msg.type === 'cdp') {
      const res = await execCdpSafe(msg);
      send({ type: 'cdp_result', reqId: msg.reqId, ...res });
    } else if (msg.type === 'ping') {
      send({ type: 'pong', t: msg.t });
    } else if (msg.type === 'config') {
      // reserved for server-pushed config
    }
  };

  ws.onclose = () => {
    if (myId !== wsId) return;
    connected = false;
    updateBadge();
    log('disconnected');
    scheduleReconnect(myId);
  };

  ws.onerror = () => {
    try { ws.close(); } catch (e) {}
  };
}

function scheduleReconnect(myId) {
  setTimeout(() => {
    if (myId === wsId) connect();
  }, RECONNECT_DELAY_MS);
}

function updateBadge() {
  const txt = connected ? 'ON' : 'OFF';
  chrome.action.setBadgeText({ text: txt });
  chrome.action.setBadgeBackgroundColor({ color: connected ? '#22a45d' : '#a0a0a0' });
}

// ---------- lifecycle ----------

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) cleanupDetached(source.tabId);
});

// Keep service worker alive-ish: SW may be killed after 30s idle; the
// WebSocket itself keeps it registered (Chrome extends SW lifetime for
// active WebSocket). Reconnect on startup anyway.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// Heartbeat so the server can spot dead connections
setInterval(() => { if (connected) send({ type: 'heartbeat' }); }, 20000);

// Message from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    getDeviceName().then((deviceName) => {
      sendResponse({ connected, serverUrl: null, tabs: attachedTabs.size, deviceName });
    });
    return true;
  } else if (msg.type === 'reconnect') {
    connect();
    sendResponse({ ok: true });
  } else if (msg.type === 'setName') {
    chrome.storage.local.set({ deviceName: msg.name }).then(() => {
      // Re-connect so the server immediately sees the new name
      connect();
      sendResponse({ ok: true });
    });
    return true;
  }
  return true;
});
