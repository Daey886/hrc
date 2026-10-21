/**
 * Hermes Remote Control — Relay Server (no dependencies)
 *
 *   Browser extension(s) <--ws :8765--  relay  <--http :8766--  Hermes agent
 *
 * Multi-device: every extension registers with a deviceName; Hermes targets
 * one with the "device" parameter (or "default" / first-connected).
 *
 * Endpoints for Hermes (add optional "device": "<name>" to any POST body):
 *   GET  /devices            -> list connected browsers with device names
 *   GET  /status             -> overall status
 *   GET  /tabs               -> list tabs (device or default)
 *   POST /command            -> { device?, tabId?, command, params }
 *   POST /navigate           -> { device?, url, tabId? }
 *   POST /screenshot         -> { device?, tabId? }  -> { image: "data:image/png..." }
 *   POST /evaluate           -> { device?, tabId, expression }
 *   POST /click              -> { device?, tabId?, x, y }
 *   POST /move               -> { device?, tabId?, x, y }
 *   POST /type               -> { device?, tabId?, text }
 *   POST /key                -> { device?, tabId?, key, code?, modifiers? }
 *   POST /scroll             -> { device?, tabId?, x?, y?, dx?, dy? }
 *   POST /find               -> { device?, tabId?, selector }
 *   POST /tab/new            -> { device?, url?, active? }  -> { tabId }
 *   POST /tab/close          -> { device?, tabId }
 *   POST /tab/activate       -> { device?, tabId }
 *   POST /wait               -> { ms }
 */

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const WS_PORT = process.env.WS_PORT || 8765;     // extensions connect here
const HTTP_PORT = process.env.HTTP_PORT || 8766; // Hermes calls here

// ---------------- WebSocket (RFC 6455, server side) ----------------

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.from(data, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function decodeFrames(buf) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const fin = (buf[offset] & 0x80) !== 0;
    const opcode = buf[offset] & 0x0f;
    const masked = (buf[offset + 1] & 0x80) !== 0;
    let len = buf[offset + 1] & 0x7f;
    offset += 2;
    if (len === 126) { len = buf.readUInt16BE(offset); offset += 2; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(offset)); offset += 8; }
    let mask = null;
    if (masked) { mask = buf.slice(offset, offset + 4); offset += 4; }
    if (offset + len > buf.length) break;
    let payload = buf.slice(offset, offset + len);
    offset += len;
    if (masked && mask) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    frames.push({ fin, opcode, data: payload });
  }
  return frames;
}

class WsConn {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.alive = true;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => { if (this.alive) { this.alive = false; this.onclose && this.onclose(); } });
    socket.on('error', () => { if (this.alive) { this.alive = false; this.onclose && this.onclose(); } });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = decodeFrames(this.buffer);
    for (const f of frames) {
      if (f.opcode === 0x8) { this.close(); return; }
      if (f.opcode === 0x9) { this.sendRaw(f.data, 0xA); continue; }
      if (f.opcode === 0xA) continue;
      if (this.onmessage) this.onmessage(f.data.toString('utf8'));
    }
    let consumed = 0;
    let off = 0;
    const b = this.buffer;
    while (off + 2 <= b.length) {
      let len = b[off + 1] & 0x7f;
      let hlen = 2;
      if (len === 126) { len = b.readUInt16BE(off + 2); hlen = 4; }
      else if (len === 127) { len = Number(b.readBigUInt64BE(off + 2)); hlen = 10; }
      const masked = (b[off + 1] & 0x80) !== 0;
      const total = hlen + len + (masked ? 4 : 0);
      if (off + total > b.length) break;
      off += total;
      consumed = off;
    }
    if (consumed > 0) this.buffer = this.buffer.slice(consumed);
  }

  sendRaw(payload, opcode) {
    if (!this.alive) return;
    this.socket.write(encodeFrame(payload, opcode));
  }

  send(obj) { this.sendRaw(JSON.stringify(obj), 0x1); }

  close() {
    if (this.alive) {
      this.alive = false;
      try { this.socket.end(); } catch (e) {}
      this.onclose && this.onclose();
    }
  }
}

function upgradeToWs(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '\r\n'
  ].join('\r\n');
  socket.write(headers);
  return new WsConn(socket);
}

// ---------------- Device registry ----------------

const devices = new Map(); // name -> { conn, ua, connectedAt, clientId }
const pending = new Map(); // reqId -> { resolve, reject, timer, conn, deviceName }
const MSG_TIMEOUT = 45000;

function registerDevice(name, conn, ua, clientId) {
  const old = devices.get(name);
  if (old && old.conn !== conn && old.conn.alive) {
    console.log(`[!] device "${name}" re-registered; dropping old connection`);
    try { old.conn.close(); } catch (e) {}
  }
  devices.set(name, { conn, ua, clientId, connectedAt: new Date().toISOString() });
  console.log(`[+] device registered: "${name}" (${ua || ''})`);
}

function unregisterConn(conn) {
  for (const [name, dev] of devices) {
    if (dev.conn === conn) {
      devices.delete(name);
      console.log(`[-] device disconnected: "${name}"`);
    }
  }
  for (const [reqId, p] of pending) {
    if (p.conn === conn) {
      pending.delete(reqId);
      clearTimeout(p.timer);
      p.reject(new Error(`device "${p.deviceName}" disconnected`));
    }
  }
}

function resolveDevice(name) {
  if (devices.size === 0) throw new Error('No browser extension connected');
  if (!name || name === 'default' || name === 'first') {
    let latest = null, latestTs = 0;
    for (const [n, d] of devices) {
      const ts = Date.parse(d.connectedAt) || 0;
      if (ts >= latestTs) { latestTs = ts; latest = n; }
    }
    return latest;
  }
  const lower = String(name).toLowerCase();
  for (const n of devices.keys()) {
    if (n.toLowerCase() === lower) return n;
  }
  throw new Error(`device "${name}" not connected. Available: ${[...devices.keys()].join(', ')}`);
}

function sendToDevice(deviceName, msg) {
  return new Promise((resolve, reject) => {
    const dev = devices.get(deviceName);
    if (!dev || !dev.conn.alive) {
      return reject(new Error(`device "${deviceName}" not connected`));
    }
    const reqId = crypto.randomBytes(6).toString('hex');
    msg.reqId = reqId;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`device "${deviceName}" response timeout`));
    }, MSG_TIMEOUT);
    pending.set(reqId, { resolve, reject, timer, conn: dev.conn, deviceName });
    dev.conn.send(msg);
  });
}

// ---------------- HTTP API ----------------

function respond(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 50 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// High-level helpers built on CDP
const Input = {
  async click(deviceName, tabId, x, y, opts = {}) {
    await sendToDevice(deviceName, {
      type: 'cdp', tabId, command: 'Input.dispatchMouseEvent',
      params: {
        type: 'mousePressed', x, y, button: 'left',
        clickCount: opts.double ? 2 : 1, buttons: 1, pointerType: 'mouse'
      }
    });
    return sendToDevice(deviceName, {
      type: 'cdp', tabId, command: 'Input.dispatchMouseEvent',
      params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, pointerType: 'mouse' }
    });
  },
  async move(deviceName, tabId, x, y) {
    return sendToDevice(deviceName, {
      type: 'cdp', tabId, command: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x, y, pointerType: 'mouse' }
    });
  },
  async type(deviceName, tabId, text) {
    for (const ch of String(text)) {
      await sendToDevice(deviceName, {
        type: 'cdp', tabId, command: 'Input.dispatchKeyEvent',
        params: { type: 'keyDown', text: ch, unmodifiedText: ch }
      });
      await sendToDevice(deviceName, {
        type: 'cdp', tabId, command: 'Input.dispatchKeyEvent',
        params: { type: 'keyUp', text: ch, unmodifiedText: ch }
      });
    }
    return {};
  },
  async key(deviceName, tabId, key, code, modifiers = 0) {
    const map = {
      Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
      ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
      Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32
    };
    const windowsKeyCode = map[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const params = { type: 'rawKeyDown', key, modifiers, windowsVirtualKeyCode: windowsKeyCode, code: code || key };
    await sendToDevice(deviceName, { type: 'cdp', tabId, command: 'Input.dispatchKeyEvent', params });
    if (key.length === 1 && !modifiers) {
      await sendToDevice(deviceName, {
        type: 'cdp', tabId, command: 'Input.dispatchKeyEvent',
        params: { type: 'keyDown', key, text: key, unmodifiedText: key, windowsVirtualKeyCode: windowsKeyCode, code: code || key, modifiers }
      });
    }
    await sendToDevice(deviceName, {
      type: 'cdp', tabId, command: 'Input.dispatchKeyEvent',
      params: { type: 'keyUp', key, windowsVirtualKeyCode: windowsKeyCode, code: code || key, modifiers }
    });
    return {};
  },
  async scroll(deviceName, tabId, x = 0, y = 0, dx = 0, dy = 0) {
    return sendToDevice(deviceName, {
      type: 'cdp', tabId, command: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy, pointerType: 'mouse' }
    });
  }
};

async function ensureTab(deviceName, tabId) {
  if (tabId != null) return Number(tabId);
  const tabs = await sendToDevice(deviceName, { type: 'cdp', command: 'Tab.list' });
  if (!tabs || !tabs.length) throw new Error('No tabs open');
  const active = tabs.find(t => t.active) || tabs[0];
  return active.id;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const path = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};

    const deviceQuery = u.searchParams.get('device') || undefined;
    const deviceArg = body.device || deviceQuery;
    const D = () => resolveDevice(deviceArg);

    switch (path) {
      case '/status': {
        respond(res, 200, {
          extensionConnected: devices.size > 0,
          devices: [...devices.entries()].map(([name, d]) => ({
            name, ua: d.ua, connectedAt: d.connectedAt
          })),
          httpPort: HTTP_PORT, wsPort: WS_PORT
        });
        return;
      }
      case '/devices': {
        respond(res, 200, {
          devices: [...devices.entries()].map(([name, d]) => ({
            name, ua: d.ua, connectedAt: d.connectedAt
          }))
        });
        return;
      }
      case '/tabs': {
        const dn = D();
        const tabs = await sendToDevice(dn, { type: 'cdp', command: 'Tab.list' });
        respond(res, 200, { device: dn, tabs });
        return;
      }
      case '/command': {
        const dn = D();
        const result = await sendToDevice(dn, {
          type: 'cdp', tabId: body.tabId, command: body.command, params: body.params || {}
        });
        respond(res, 200, { ok: true, device: dn, result });
        return;
      }
      case '/navigate': {
        const dn = D();
        const tabId = await ensureTab(dn, body.tabId);
        await sendToDevice(dn, { type: 'cdp', tabId, command: 'Tab.navigate', params: { url: body.url } });
        respond(res, 200, { ok: true, device: dn, tabId });
        return;
      }
      case '/screenshot': {
        const dn = D();
        const tabId = await ensureTab(dn, body.tabId);
        const r = await sendToDevice(dn, { type: 'cdp', tabId, command: 'Tab.screenshot' });
        respond(res, 200, { ok: true, device: dn, image: r.data });
        return;
      }
      case '/evaluate': {
        const dn = D();
        const tabId = await ensureTab(dn, body.tabId);
        const r = await sendToDevice(dn, {
          type: 'cdp', tabId, command: 'Runtime.evaluate',
          params: { expression: body.expression, returnByValue: true, awaitPromise: true }
        });
        // Chrome build: r.result.value ; Firefox build: r.result.value (same shape via evalInTab wrapper)
        let value = r && r.result ? r.result.value : r;
        // Firefox cmdType/cmdKey etc. may return {ok:true,...} objects; pass through
        respond(res, 200, { ok: true, device: dn, result: value === undefined ? null : value });
        return;
      }
      case '/click': {
        const dn = D();
        const tabId = await ensureTab(dn, body.tabId);
        await Input.click(dn, tabId, Number(body.x), Number(body.y), { double: body.double });
        respond(res, 200, { ok: true, device: dn, tabId });
        return;
      }
      case '/move': {
        const dn = D();
        const tabId = await ensureTab(dn, body.tabId);
        await Input.move(dn, tabId, Number(body.x), Number(body.y));
        respond(res, 200, { ok: true, device: dn, tabId });
        return;
      }
      case '/type': {
        const dn = D();
        const tabId = await ensureTab(dn, body.tabId);
        await Input.type(dn, tabId, body.text || '');
        respond(res, 200, { ok: true, device: dn, tabId });
        return;
      }
      case '/key': {
        const dn = D();
        const tabId = await ensureTab(dn, body.tabId);
        await Input.key(dn, tabId, body.key, body.code, body.modifiers || 0);
        respond(res, 200, { ok: true, device: dn, tabId });
        return;
      }
      case '/scroll': {
        const dn = D();
        const tabId = await ensureTab(dn, body.tabId);
        await Input.scroll(dn, tabId, Number(body.x) || 0, Number(body.y) || 0, Number(body.dx) || 0, Number(body.dy) || 0);
        respond(res, 200, { ok: true, device: dn, tabId });
        return;
      }
      case '/find': {
        const dn = D();
        const tabId = await ensureTab(dn, body.tabId);
        const r = await sendToDevice(dn, {
          type: 'cdp', tabId, command: 'Runtime.evaluate',
          params: {
            expression: `(() => {
              const el = document.querySelector(${JSON.stringify(body.selector)});
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: r.x + r.width/2, y: r.y + r.height/2, rect: {x:r.x,y:r.y,w:r.width,h:r.height}, tag: el.tagName, text: (el.textContent||'').slice(0,120) };
            })()`,
            returnByValue: true
          }
        });
        const found = r && r.result ? r.result.value : null;
        if (!found) return respond(res, 404, { ok: false, error: 'element not found' });
        respond(res, 200, { ok: true, device: dn, tabId, ...found });
        return;
      }
      case '/tab/new': {
        const dn = D();
        const r = await sendToDevice(dn, { type: 'cdp', command: 'Tab.new', params: { url: body.url || 'about:blank', active: body.active !== false } });
        respond(res, 200, { ok: true, device: dn, tabId: r.tabId });
        return;
      }
      case '/tab/close': {
        const dn = D();
        await sendToDevice(dn, { type: 'cdp', command: 'Tab.close', tabId: body.tabId });
        respond(res, 200, { ok: true, device: dn });
        return;
      }
      case '/tab/activate': {
        const dn = D();
        await sendToDevice(dn, { type: 'cdp', command: 'Tab.activate', tabId: body.tabId });
        respond(res, 200, { ok: true, device: dn });
        return;
      }
      case '/wait': {
        await new Promise(r => setTimeout(r, Math.min(Number(body.ms) || 1000, 60000)));
        respond(res, 200, { ok: true });
        return;
      }
      default:
        respond(res, 404, { ok: false, error: 'unknown endpoint', endpoints: [
          '/devices','/status','/tabs','/command','/navigate','/screenshot','/evaluate',
          '/click','/move','/type','/key','/scroll','/find','/tab/new','/tab/close','/tab/activate','/wait'
        ]});
    }
  } catch (err) {
    respond(res, 500, { ok: false, error: String((err && err.message) || err) });
  }
});

// ---------------- WebSocket side ----------------

const wsServer = http.createServer((req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('websocket only');
});

wsServer.on('upgrade', (req, socket) => {
  const conn = upgradeToWs(req, socket);
  if (!conn) return;
  conn.onmessage = (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'hello' && msg.role === 'extension') {
      const name = (msg.deviceName && String(msg.deviceName).trim()) || `device-${crypto.randomBytes(3).toString('hex')}`;
      conn.deviceName = name;
      registerDevice(name, conn, msg.ua, msg.clientId);
    } else if (msg.type === 'cdp_result') {
      const p = pending.get(msg.reqId);
      if (p) {
        pending.delete(msg.reqId);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || 'CDP error'));
      }
    }
  };
  conn.onclose = () => unregisterConn(conn);
});

wsServer.listen(WS_PORT, '127.0.0.1', () => {
  console.log(`[WS]   listening for extensions on ws://127.0.0.1:${WS_PORT}`);
});
server.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[HTTP] API for Hermes on http://127.0.0.1:${HTTP_PORT}`);
});
