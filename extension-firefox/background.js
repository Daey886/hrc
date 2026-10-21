/**
 * Hermes Remote Control - Firefox Background Page (MV2)
 *
 * Firefox has no chrome.debugger / CDP access, so this build re-implements the
 * same command set with WebExtensions APIs:
 *   - Tab ops:        browser.tabs
 *   - Screenshots:    browser.tabs.captureTab (visible tabs only)
 *   - JS evaluation:  browser.tabs.executeScript (page context)
 *   - Input events:   content script synthesizes DOM events (isTrusted:false)
 *
 * Wire protocol is identical to the Chrome/Edge build, so relay.js works
 * with both without changes.
 */

const DEFAULT_SERVER = 'ws://127.0.0.1:8765';
const RECONNECT_DELAY_MS = 3000;
const CMD_TIMEOUT_MS = 30000;

let ws = null;
let wsId = 0;
let connected = false;
let clientId = null;

// ---------- utils ----------

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

async function getServerUrl() {
  const st = await browser.storage.local.get('serverUrl');
  return (st && st.serverUrl) || DEFAULT_SERVER;
}

async function getDeviceName() {
  const st = await browser.storage.local.get('deviceName');
  if (st && st.deviceName && st.deviceName.trim()) return st.deviceName.trim();
  const st2 = await browser.storage.local.get('autoName');
  if (st2 && st2.autoName) return st2.autoName;
  const guess = 'Firefox-' + (navigator.platform || 'PC').replace(/\s+/g, '');
  await browser.storage.local.set({ autoName: guess });
  return guess;
}

function timeout(ms, tag) {
  return new Promise((_, rej) => setTimeout(() => rej(new Error(tag + ' timeout')), ms));
}

// ---------- content-script based execution ----------

// Inject a function into the page and await its result.
// Uses executeScript with a serialized IIFE + Promise wrapping.
async function evalInTab(tabId, code) {
  const wrapped = `(async function(){ return (${code}); })()`;
  const results = await browser.tabs.executeScript(tabId, {
    code: `(async () => {
      try {
        const r = await (${wrapped});
        return { ok: true, value: r === undefined ? null : r };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })()`
  });
  const r = results && results[0];
  if (!r) throw new Error('executeScript returned nothing');
  if (!r.ok) throw new Error(r.error || 'page script failed');
  return { result: { type: 'object', value: r.value } };
}

// The full input-event toolkit, injected once per command (stateless).
const INPUT_LIB = `
(function(){
  if (window.__hrcInput) return 'cached';
  window.__hrcInput = {
    // element from viewport coordinates (CSS pixels)
    el: (x, y) => document.elementFromPoint(x, y),
    fireMouse: (el, type, x, y, opts) => {
      const e = new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, button: 0, buttons: opts.buttons || 0,
        detail: opts.detail || 1
      });
      el.dispatchEvent(e);
    },
    fireWheel: (el, x, y, dx, dy) => {
      const e = new WheelEvent('wheel', {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, deltaX: dx, deltaY: dy, deltaMode: 0
      });
      el.dispatchEvent(e);
    },
    fireKey: (el, type, key, code, keyCode, mods, textVal) => {
      const init = {
        bubbles: true, cancelable: true, view: window,
        key, code, keyCode, which: keyCode,
        ctrlKey: !!(mods & 2), altKey: !!(mods & 1), shiftKey: !!(mods & 8), metaKey: !!(mods & 4)
      };
      if (textVal !== undefined) { init.data = textVal; }
      const EvtCtor = (type === 'keypress' || type === 'textInput') ? KeyboardEvent : KeyboardEvent;
      const e = new KeyboardEvent(type, Object.assign(init, textVal !== undefined ? {} : {}));
      el.dispatchEvent(e);
    },
    fireInput: (el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
  return 'installed';
})()
`;

async function injectInputLib(tabId) {
  await browser.tabs.executeScript(tabId, { code: INPUT_LIB });
}

// Key name -> keyCode map (legacy DOM keyCode values, same as relay's map)
const KEYCODES = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32
};

// ---------- command implementations ----------

async function cmdClick(tabId, x, y, opts = {}) {
  await injectInputLib(tabId);
  const code = `(function(){
    const L = window.__hrcInput;
    const el = L.el(${x}, ${y});
    if (!el) return { ok:false, error:'no element at point' };
    const detail = ${opts.double ? 2 : 1};
    L.fireMouse(el, 'mousedown', ${x}, ${y}, { buttons: 1, detail });
    L.fireMouse(el, 'mouseup', ${x}, ${y}, { buttons: 0, detail });
    L.fireMouse(el, 'click', ${x}, ${y}, { buttons: 0, detail });
    return { ok:true, tag: el.tagName, text:(el.textContent||'').slice(0,60) };
  })()`;
  return evalInTab(tabId, code);
}

async function cmdMove(tabId, x, y) {
  await injectInputLib(tabId);
  const code = `(function(){
    const L = window.__hrcInput;
    const el = L.el(${x}, ${y});
    if (!el) return { ok:false, error:'no element at point' };
    L.fireMouse(el, 'mousemove', ${x}, ${y}, { buttons: 0 });
    return { ok:true };
  })()`;
  return evalInTab(tabId, code);
}

async function cmdType(tabId, text, tab) {
  // Type into the active element of the page
  const jsText = JSON.stringify(String(text));
  await injectInputLib(tabId);
  const code = `(function(){
    const L = window.__hrcInput;
    let el = document.activeElement;
    if (!el || el === document.body || el.tagName === 'HTML') {
      el = document.querySelector('input:not([type=hidden]), textarea, [contenteditable]');
      if (!el) return { ok:false, error:'no focused or typable element' };
      el.focus();
    }
    const text = ${jsText};
    for (const ch of text) {
      const kc = ch.charCodeAt(0);
      L.fireKey(el, 'keydown', ch, '', kc, 0);
      L.fireKey(el, 'keypress', ch, '', kc, 0, ch);
      // editable elements: insert directly
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.value += ch;
      } else if (el.isContentEditable) {
        document.execCommand('insertText', false, ch);
      }
      L.fireInput(el);
      L.fireKey(el, 'keyup', ch, '', kc, 0);
    }
    return { ok:true, len: text.length };
  })()`;
  return evalInTab(tabId, code);
}

async function cmdKey(tabId, key, mods) {
  await injectInputLib(tabId);
  const code = `(function(){
    const L = window.__hrcInput;
    const el = document.activeElement || document.body;
    const key = ${JSON.stringify(String(key))};
    const mods = ${mods || 0};
    const kc = ${KEYCODES[key] || (String(key).length === 1 ? String(key).toUpperCase().charCodeAt(0) : 0)};
    L.fireKey(el, 'keydown', key, key, kc, mods);
    if (key.length === 1 && !mods) L.fireKey(el, 'keypress', key, key, kc, mods, key);
    if (key === 'Enter' && (el.tagName === 'BUTTON' || el.type === 'submit')) {
      // activate buttons on Enter like real browsers do
      el.click();
    }
    L.fireKey(el, 'keyup', key, key, kc, mods);
    return { ok:true };
  })()`;
  return evalInTab(tabId, code);
}

async function cmdScroll(tabId, x, y, dx, dy) {
  await injectInputLib(tabId);
  const code = `(function(){
    const L = window.__hrcInput;
    const el = L.el(${x}, ${y}) || document.documentElement;
    L.fireWheel(el, ${x}, ${y}, ${dx}, ${dy});
    window.scrollBy(${dx}, ${dy});
    return { ok:true };
  })()`;
  return evalInTab(tabId, code);
}

async function cmdFind(tabId, selector) {
  const code = `(function(){
    const el = document.querySelector(${JSON.stringify(String(selector))});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2,
             rect: {x:r.x, y:r.y, w:r.width, h:r.height},
             tag: el.tagName, text: (el.textContent||'').slice(0,120) };
  })()`;
  const r = await evalInTab(tabId, code);
  return r.result.value;
}

async function cmdScreenshot(tabId) {
  const dataUrl = await browser.tabs.captureTab(tabId, { format: 'png' });
  return { data: dataUrl };
}

// ---------- command dispatch (same shapes as CDP build) ----------

async function execCommand(payload) {
  const { command, params = {}, tabId } = payload;
  const tid = tabId != null ? Number(tabId) : null;

  switch (command) {
    case 'Tab.new': {
      const tab = await browser.tabs.create({ url: params.url || 'about:blank', active: params.active !== false });
      return { tabId: tab.id };
    }
    case 'Tab.close': {
      await browser.tabs.remove(tid);
      return {};
    }
    case 'Tab.list': {
      const tabs = await browser.tabs.query({});
      return tabs.map(t => ({
        id: t.id, title: t.title, url: t.url,
        active: t.active, windowId: t.windowId, index: t.index, pinned: t.pinned
      }));
    }
    case 'Tab.activate': {
      await browser.tabs.update(tid, { active: true });
      const tab = await browser.tabs.get(tid);
      await browser.windows.update(tab.windowId, { focused: true });
      return {};
    }
    case 'Tab.navigate': {
      await browser.tabs.update(tid, { url: params.url });
      return {};
    }
    case 'Tab.screenshot': {
      return cmdScreenshot(tid);
    }
    case 'Runtime.evaluate': {
      const r = await evalInTab(tid, params.expression);
      return r;
    }
    case 'Input.click': return cmdClick(tid, Number(params.x), Number(params.y), { double: params.clickCount > 1 });
    case 'Input.move': return cmdMove(tid, Number(params.x), Number(params.y));
    case 'Input.type': return cmdType(tid, params.text, payload);
    case 'Input.key': return cmdKey(tid, params.key, params.modifiers || 0);
    case 'Input.scroll': return cmdScroll(tid, Number(params.x) || 0, Number(params.y) || 0, Number(params.deltaX) || 0, Number(params.deltaY) || 0);

    // ---- CDP-shape translation (relay's high-level endpoints send these) ----
    case 'Input.dispatchMouseEvent': {
      const t = params.type;
      if (t === 'mousePressed') return cmdClick(tid, Number(params.x), Number(params.y), { double: (params.clickCount || 1) > 1 });
      if (t === 'mouseMoved') return cmdMove(tid, Number(params.x), Number(params.y));
      if (t === 'mouseWheel') return cmdScroll(tid, Number(params.x) || 0, Number(params.y) || 0, Number(params.deltaX) || 0, Number(params.deltaY) || 0);
      if (t === 'mouseReleased') return { ok: true }; // handled inside cmdClick
      return { ok: true };
    }
    case 'Input.dispatchKeyEvent': {
      const t = params.type;
      if (t === 'keyDown' && params.text) {
        // per-char text insertion (relay /type sends keyDown+keyUp pairs)
        return cmdType(tid, params.text);
      }
      if (t === 'keyUp') return { ok: true }; // folded into cmdKey/cmdType
      if (t === 'rawKeyDown' || t === 'keyDown') return cmdKey(tid, params.key, params.modifiers || 0);
      return { ok: true };
    }
    default:
      throw new Error(`command ${command} not supported on Firefox build`);
  }
}

async function execCommandSafe(payload) {
  try {
    const result = await Promise.race([
      execCommand(payload),
      timeout(CMD_TIMEOUT_MS, 'command')
    ]);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// ---------- WebSocket connection ----------

async function connect() {
  const myId = ++wsId;
  const serverUrl = await getServerUrl();
  try {
    ws = new WebSocket(serverUrl);
  } catch (e) {
    scheduleReconnect(myId);
    return;
  }

  ws.onopen = async () => {
    if (myId !== wsId) { try { ws.close(); } catch (e) {} return; }
    connected = true;
    clientId = 'ff-' + Math.random().toString(36).slice(2, 10);
    const deviceName = await getDeviceName();
    send({ type: 'hello', clientId, role: 'extension', deviceName, ua: navigator.userAgent });
    updateBadge();
  };

  ws.onmessage = async (ev) => {
    if (myId !== wsId) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'cdp') {
      const res = await execCommandSafe(msg);
      send({ type: 'cdp_result', reqId: msg.reqId, ...res });
    } else if (msg.type === 'ping') {
      send({ type: 'pong', t: msg.t });
    }
  };

  ws.onclose = () => {
    if (myId !== wsId) return;
    connected = false;
    updateBadge();
    scheduleReconnect(myId);
  };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

function scheduleReconnect(myId) {
  setTimeout(() => { if (myId === wsId) connect(); }, RECONNECT_DELAY_MS);
}

function updateBadge() {
  browser.browserAction.setBadgeText({ text: connected ? 'ON' : 'OFF' });
  browser.browserAction.setBadgeBackgroundColor({ color: connected ? '#22a45d' : '#a0a0a0' });
}

// ---------- lifecycle ----------

browser.runtime.onStartup.addListener(connect);
browser.runtime.onInstalled.addListener(connect);
connect();

setInterval(() => { if (connected) send({ type: 'heartbeat' }); }, 20000);

// popup messaging (browser.* namespace)
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    getDeviceName().then((deviceName) => {
      sendResponse({ connected, serverUrl: null, tabs: 0, deviceName });
    });
    return true;
  } else if (msg.type === 'reconnect') {
    connect();
    sendResponse({ ok: true });
  } else if (msg.type === 'setName') {
    browser.storage.local.set({ deviceName: msg.name }).then(() => {
      connect();
      sendResponse({ ok: true });
    });
    return true;
  }
  return true;
});
