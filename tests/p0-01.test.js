'use strict';

// Isolated HTTP/Socket.IO fixtures and a real Chromium DOM. No production DB/env is loaded.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const http = require('node:http');
const { webcrypto } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const WebSocket = require('ws');
const { io: connect } = require('socket.io-client');
const { safeUrl } = require('../public/safe-content');
const isolatedDb = require('./helpers/isolated-db');

const root = path.resolve(__dirname, '..');
const realRequire = createRequire(path.join(root, 'server.js'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const raster = 'data:image/png;base64,' + png.toString('base64');
const attacks = ['<img src=x onerror=alert(1)>', '<svg onload=alert(1)>', '" onerror="alert(1)'];
const unsafeUrls = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'file:///tmp/test.html',
  'blob:https://example.test/untrusted',
  'vbscript:msgbox(1)', 'data:text/html,<script>alert(1)</script>',
  'data:image/svg+xml;base64,' + Buffer.from('<svg onload="alert(1)"/>').toString('base64')];
let tempDir, server, socketServer, base, browserProcess, cdp;
const sockets = [];
const users = [
  { syncId: 'SYNC-1001', username: 'alice', formattedName: 'SYNC-1001 - Alice', cleanDisplayName: 'Alice', avatarUrl: raster },
  { syncId: 'SYNC-1002', username: 'bob', formattedName: 'SYNC-1002 - Bob', cleanDisplayName: 'Bob', avatarUrl: raster }
];
let messages;
let db;

function fixtureDb() {
  db = isolatedDb(root, tempDir, users);
  messages = db.testData.messages;
  return db;
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(process.env.SYNC_TEST_TMP || os.tmpdir(), 'sync-xss-'));
  fs.mkdirSync(path.join(tempDir, 'public', 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'data', 'ssl'), { recursive: true });
  let html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  html = html.replace('<script src="https://cdn.tailwindcss.com"></script>', '<script>window.tailwind = {};</script>')
    .replace(/<script src="https:\/\/cdn\.socket\.io\/[^>]+><\/script>/, '<script src="/socket.io/socket.io.js"></script>')
    .replace(/<link[^>]+https:\/\/fonts\.[^>]+>/g, '');
  fs.writeFileSync(path.join(tempDir, 'public', 'index.html'), html);
  for (const file of ['safe-content.js', 'private-files.js', 'style.css', 'sw.js']) {
    fs.copyFileSync(path.join(root, 'public', file), path.join(tempDir, 'public', file));
  }
  const db = fixtureDb();
  const context = {
    __dirname: tempDir,
    process: { env: { NODE_ENV: 'test', PORT: '3000' } },
    console: { log() {}, warn() {}, error() {} },
    Buffer, URL, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === './db') return db;
      if (name === './public/safe-content') return realRequire(name);
      if (name === 'selfsigned') return { generate: async () => null };
      if (name === 'web-push') return { setVapidDetails() { throw new Error('disabled in fixtures'); } };
      if (name === 'http') return {
        createServer(app) {
          server = http.createServer(app);
          server.listen = () => server; // Suppress production binding/PubSub startup only.
          return server;
        }
      };
      return realRequire(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8') + '\nglobalThis.testIo = io;', context);
  socketServer = context.testIo;
  await new Promise((resolve) => http.Server.prototype.listen.call(server, 0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  for (const socket of sockets) socket.disconnect();
  if (cdp) cdp.close();
  if (browserProcess && browserProcess.exitCode === null) {
    const exited = once(browserProcess, 'exit');
    browserProcess.kill();
    await exited;
  }
  if (socketServer) await new Promise((resolve) => socketServer.close(resolve));
  if (server && server.listening) await new Promise((resolve) => server.close(resolve));
  if (db) await db.writeDb(db.testData);
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function profile(avatarUrl) {
  return fetch(base + '/api/user/profile', {
    method: 'POST', headers: { Authorization: 'Bearer test-alice', 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatarUrl })
  });
}

async function upload(bytes, name, type) {
  const body = new FormData();
  body.append('file', new Blob([bytes], { type }), name);
  const response = await fetch(base + '/api/upload', { method: 'POST', headers: { Authorization: 'Bearer test-alice' }, body });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(data.file.url.startsWith('/api/files/'));
  const socket = await authenticatedSocket('test-alice');
  const sent = waitEvent(socket, 'message-sent');
  socket.emit('send-private-message', { toSyncId: users[1].syncId, type: 'file', fileData: data.file });
  await sent;
  return data.file;
}

async function authenticatedSocket(token) {
  const socket = await connectedSocket();
  const authenticated = once(socket, 'authenticated');
  socket.emit('authenticate', { token });
  await authenticated;
  return socket;
}

async function connectedSocket() {
  const socket = connect(base, { transports: ['websocket'], autoConnect: false, forceNew: true });
  sockets.push(socket);
  const connected = once(socket, 'connect');
  socket.connect();
  await connected;
  return socket;
}

function waitEvent(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, receive); reject(new Error('Missing event: ' + name)); }, 5000);
    function receive(data) { clearTimeout(timer); resolve(data); }
    socket.once(name, receive);
  });
}

test('URL policy rejects executable schemes in every purpose and bounds data exceptions', () => {
  for (const purpose of ['link', 'download', 'avatar', 'image', 'audio', 'video']) {
    for (const attack of unsafeUrls) assert.equal(safeUrl(attack, purpose, base), '', purpose + ': ' + attack);
    assert.equal(safeUrl('/uploads/photo.png', purpose, base), base + '/uploads/photo.png');
  }
  assert.equal(safeUrl(raster, 'avatar'), raster);
  assert.equal(safeUrl(raster, 'image'), raster);
  assert.equal(safeUrl(raster, 'link'), '');
  assert.equal(safeUrl('data:audio/webm;base64,AAAA', 'audio'), 'data:audio/webm;base64,AAAA');
  assert.equal(safeUrl('data:audio/webm;base64,AAAA', 'link'), '');
  assert.equal(safeUrl('https://user:password@example.test/x', 'image'), '');
});

test('all inline application scripts parse, and the safe-content dependency is available offline', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    new vm.Script(match[1]);
  }
  assert.ok(html.includes('<script src="/safe-content.js"></script>'));
  assert.ok(fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8').includes("'/safe-content.js'"));
});

test('profile endpoint rejects executable avatars; HTTP and Canvas-compatible raster avatars survive', async () => {
  for (const url of unsafeUrls) assert.equal((await profile(url)).status, 400);
  for (const url of [base + '/uploads/avatar.png', raster, null]) {
    const response = await profile(url);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.avatarUrl, url);
  }
  await profile(raster);
});

test('uploads preserve bytes; active documents download with sandbox/nosniff; media stays inline and supports ranges', async () => {
  for (const [name, type, content] of [
    ['attack.html', 'text/html', '<script>window.__xss=1</script>'],
    ['attack.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
    ['attack.xml', 'application/xml', '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>']
  ]) {
    const file = await upload(content, name, type);
    const response = await fetch(base + file.url, { headers: { Authorization: 'Bearer test-alice' } });
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.match(response.headers.get('content-security-policy'), /sandbox/);
    assert.match(response.headers.get('content-security-policy'), /script-src 'none'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await response.text(), content);
  }
  const file = await upload(png, 'image.png', 'image/png');
  const response = await fetch(base + file.url, { headers: { Authorization: 'Bearer test-alice' } });
  assert.equal(response.headers.get('content-disposition'), null);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  const range = await fetch(base + file.url, { headers: { Range: 'bytes=0-7', Authorization: 'Bearer test-alice' } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), png.subarray(0, 8));
  assert.equal((await fetch(base + '/index.html')).headers.get('content-security-policy'), null);
});

test('real Socket.IO delivers normal text/files/audio and rejects executable resource payloads before persistence', async () => {
  const alice = await authenticatedSocket('test-alice');
  const bob = await authenticatedSocket('test-bob');
  const file = await upload(png, 'normal.png', 'image/png');
  for (const payload of [
    { type: 'text', text: 'Mensaje normal' },
    { type: 'text', text: attacks[0] },
    { type: 'file', fileData: { ...file, data: file.url } },
    { type: 'audio', audioData: 'data:audio/webm;base64,AAAA' }
  ]) {
    const received = waitEvent(bob, 'receive-private-message');
    alice.emit('send-private-message', { toSyncId: users[1].syncId, ...payload });
    const message = await received;
    assert.equal(message.type, payload.type);
    if (payload.type === 'text') assert.equal(message.text, payload.text);
    if (payload.type === 'file') assert.equal(message.fileData.url, file.url);
    if (payload.type === 'audio') assert.match(message.audioData, /^\/api\/files\//);
  }
  for (const url of unsafeUrls) {
    for (const payload of [
      { type: 'file', fileData: { name: 'x.png', type: 'image/png', url } },
      { type: 'file', fileData: { name: 'x.png', type: 'image/png', url: file.url, data: url } },
      { type: 'audio', audioData: url }
    ]) {
      const count = messages.length;
      const rejected = waitEvent(alice, 'error-message');
      alice.emit('send-private-message', { toSyncId: users[1].syncId, ...payload });
      assert.match((await rejected).message, /URL/);
      assert.equal(messages.length, count);
    }
  }
});

test('private message retries with the same client ID do not create duplicates', async () => {
  const alice = await authenticatedSocket('test-alice');
  const bob = await authenticatedSocket('test-bob');
  const clientMsgId = 'retry_' + Date.now();
  const received = waitEvent(bob, 'receive-private-message');
  const firstAck = waitEvent(alice, 'message-sent');
  alice.emit('send-private-message', {
    clientMsgId, toSyncId: users[1].syncId, type: 'text', text: 'Queued once'
  });
  assert.equal((await firstAck).id, clientMsgId);
  assert.equal((await received).id, clientMsgId);

  const retryAck = waitEvent(alice, 'message-sent');
  alice.emit('send-private-message', {
    clientMsgId, toSyncId: users[1].syncId, type: 'text', text: 'Queued once'
  });
  assert.equal((await retryAck).id, clientMsgId);
  assert.equal(messages.filter((message) => message.id === clientMsgId).length, 1);
});

test('Web Push configuration endpoint requires authentication and reports disabled configuration', async () => {
  assert.equal((await fetch(base + '/api/notifications/vapid-public-key')).status, 401);
  const response = await fetch(base + '/api/notifications/vapid-public-key', {
    headers: { Authorization: ['Bearer', 'test-alice'].join(' ') }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, configured: false, publicKey: null });
});

test('channel subscriptions and history require an authenticated member', async () => {
  const channel = db.createWorkspaceChannel('private-room', 'Private channel', users[0].syncId);
  db.saveChannelMessage(channel.id, users[0].syncId, { text: 'Private history' });

  const anonymous = await connectedSocket();
  const anonymousError = waitEvent(anonymous, 'authorization-error');
  anonymous.emit('join-channel', { channelId: channel.id });
  assert.equal((await anonymousError).code, 'UNAUTHENTICATED');
  assert.equal(Boolean(socketServer.sockets.adapter.rooms.get('channel:' + channel.id)?.has(anonymous.id)), false);

  const invalidTokenSocket = await connectedSocket();
  const authError = waitEvent(invalidTokenSocket, 'auth-error');
  invalidTokenSocket.emit('authenticate', { token: 'invalid-token' });
  await authError;
  const invalidTokenError = waitEvent(invalidTokenSocket, 'authorization-error');
  invalidTokenSocket.emit('join-channel', { channelId: channel.id });
  assert.equal((await invalidTokenError).code, 'UNAUTHENTICATED');

  const alice = await authenticatedSocket('test-alice');
  const bob = await authenticatedSocket('test-bob');
  const bobError = waitEvent(bob, 'authorization-error');
  bob.emit('join-channel', { channelId: channel.id });
  assert.equal((await bobError).code, 'FORBIDDEN');
  assert.equal(Boolean(socketServer.sockets.adapter.rooms.get('channel:' + channel.id)?.has(bob.id)), false);

  const deniedHistory = await fetch(base + '/api/channels/' + channel.id + '/messages', {
    headers: { Authorization: 'Bearer test-bob' }
  });
  assert.equal(deniedHistory.status, 403);

  const bobChannels = await fetch(base + '/api/channels', {
    headers: { Authorization: 'Bearer test-bob' }
  });
  assert.equal((await bobChannels.json()).channels.some((item) => item.id === channel.id), false);

  const allowedHistory = await fetch(base + '/api/channels/' + channel.id + '/messages', {
    headers: { Authorization: 'Bearer test-alice' }
  });
  assert.equal(allowedHistory.status, 200);
  assert.deepEqual((await allowedHistory.json()).messages.map((message) => message.text), ['Private history']);

  const joined = waitEvent(alice, 'channel-message-received');
  alice.emit('join-channel', { channelId: channel.id });
  alice.emit('send-channel-message', { channelId: channel.id, text: 'Authorized' });
  assert.equal((await joined).text, 'Authorized');

  const bobMessageError = waitEvent(bob, 'authorization-error');
  bob.emit('send-channel-message', { channelId: channel.id, text: 'Unauthorized' });
  assert.equal((await bobMessageError).code, 'FORBIDDEN');
  assert.equal(db.testData.channelMessages.some((message) => message.text === 'Unauthorized'), false);

  const defaultChannel = db.getWorkspaceChannels(users[1].syncId).find((item) => item.isDefault);
  assert.equal(db.isChannelMember(defaultChannel.id, users[1].syncId), true);
  assert.equal(db.isChannelMember(channel.id, users[1].syncId), false);
});

test('vault API stores and returns only authenticated client-encrypted payloads', async () => {
  const legacyItems = db.testData.vaultItems || (db.testData.vaultItems = {});
  legacyItems[users[1].syncId] = [{ id: 'legacy', title: 'Legacy', secretContent: 'old plaintext' }];
  const secret = 'sensitive-vault-value';
  const passphrase = 'local-master-passphrase';
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const material = await webcrypto.subtle.importKey('raw', Buffer.from(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
  const ciphertext = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, Buffer.from(secret)
  );
  const base64 = (bytes) => Buffer.from(bytes).toString('base64');
  const encryptedContent = {
    version: 1, algorithm: 'AES-GCM', kdf: 'PBKDF2', hash: 'SHA-256', iterations: 310000,
    salt: base64(salt), iv: base64(iv), ciphertext: base64(ciphertext)
  };

  const plaintextAttempt = await fetch(base + '/api/vault', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-bob', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Plaintext', category: 'note', secretContent: secret })
  });
  assert.equal(plaintextAttempt.status, 400);

  const savedResponse = await fetch(base + '/api/vault', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-bob', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Encrypted', category: 'note', hint: 'non-secret hint',
      encryptedContent: { ...encryptedContent, unexpectedPlaintext: secret }
    })
  });
  assert.equal(savedResponse.status, 200);
  assert.match(savedResponse.headers.get('cache-control'), /no-store/);
  const saved = await savedResponse.json();
  assert.equal(saved.item.encryptedContent.ciphertext, encryptedContent.ciphertext);
  assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.equal(Object.hasOwn(saved.item, 'secretContent'), false);

  const fetchedResponse = await fetch(base + '/api/vault', {
    headers: { Authorization: 'Bearer test-bob' }
  });
  assert.match(fetchedResponse.headers.get('cache-control'), /no-store/);
  const fetched = await fetchedResponse.json();
  assert.equal(fetched.items.some((item) => item.id === 'legacy'), false);
  assert.equal(fetched.items.length, 1);
  const stored = db.testData.vaultItems[users[1].syncId][0];
  assert.equal(Object.hasOwn(stored, 'secretContent'), false);
  assert.equal(JSON.stringify(stored).includes(secret), false);

  const decrypted = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv }, key, Buffer.from(fetched.items[0].encryptedContent.ciphertext, 'base64')
  );
  assert.equal(Buffer.from(decrypted).toString(), secret);
});

test('HTML disguised as inline media still receives sandbox and nosniff', async () => {
  const file = await upload('<img src=x onerror=alert(1)><script>alert(1)</script>', 'disguised.png', 'image/png');
  const response = await fetch(base + file.url, { headers: { Authorization: 'Bearer test-alice' } });
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /sandbox; default-src 'none'; script-src 'none'/);
});

class DevTools {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.diagnostics = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (['Runtime.exceptionThrown', 'Runtime.consoleAPICalled'].includes(message.method)) this.diagnostics.push(message);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  close() { this.socket.close(); }
}

async function startBrowser(t) {
  if (cdp) return true;
  const executable = [process.env.CHROME_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/chromium', '/usr/bin/google-chrome'].find((file) => file && fs.existsSync(file));
  if (!executable) { t.skip('Set CHROME_PATH to run real-browser assertions'); return false; }
  const sandboxArgs = (process.env.CI || process.env.CHROMIUM_SANDBOX_DISABLED) ? ['--no-sandbox'] : [];
  // GitHub-hosted Linux runners have constrained shared memory and no desktop bus.
  // Use an isolated profile and disable features that can stall headless startup there.
  const browserProfile = fs.mkdtempSync(path.join(tempDir, 'browser-profile-'));
  browserProcess = spawn(executable, [...sandboxArgs, '--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-zygote', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-port=0', '--user-data-dir=' + browserProfile,
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const browserUrl = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      if (browserProcess && browserProcess.exitCode === null) browserProcess.kill('SIGKILL');
      reject(new Error('Chromium startup timeout after 35s: ' + stderr));
    }, 35000);
    browserProcess.once('error', (error) => {
      clearTimeout(timer);
      if (browserProcess && browserProcess.exitCode === null) browserProcess.kill('SIGKILL');
      reject(error);
    });
    browserProcess.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const debuggerBase = browserUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.+$/, '');
  const target = await (await fetch(debuggerBase + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, 'open');
  cdp = new DevTools(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__xss = 0;
    window.alert = () => { window.__xss++; };
    localStorage.setItem('sync_engine_auth_token', 'test-alice');
    if ('serviceWorker' in navigator) navigator.serviceWorker.register = () => Promise.reject(new Error('isolated test'));
  ` });
  await cdp.send('Page.navigate', { url: base + '/' });
  try {
    await cdp.evaluate(`new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (typeof socket !== 'undefined' && socket && socket.connected && activeContactSyncId && activeConversationMessages.length) {
        clearInterval(timer); resolve(true);
      } else if (Date.now() - start > 10000) { clearInterval(timer); reject(new Error('App startup failed')); }
    }, 50);
    })`);
  } catch (error) {
    const state = await cdp.evaluate(`({ ready: document.readyState, currentUser: typeof currentUser === 'undefined' ? null : currentUser,
      socket: typeof socket === 'undefined' ? 'missing' : socket && socket.connected,
      contact: typeof activeContactSyncId === 'undefined' ? 'missing' : activeContactSyncId,
      safe: typeof SyncSafeContent, io: typeof io, scripts: [...document.scripts].map(s => s.src) })`);
    throw new Error(error.message + '\nState: ' + JSON.stringify(state) + '\nBrowser: ' + JSON.stringify(cdp.diagnostics));
  }
  return true;
}

test('real browser: text/name/file/quote payloads stay data across chat, avatars, previews, Media Center and notifications', async (t) => {
  if (!await startBrowser(t)) return;
  for (const attack of attacks) {
    const result = await cdp.evaluate(`(() => {
      const attack = ${JSON.stringify(attack)};
      const quotedUrl = '/uploads/missing.png" onerror="alert(1)';
      chatMessages.replaceChildren(); renderedMessageIds.clear();
      renderMessageBubble({ id: 'text', fromId: 'SYNC-1002', fromName: attack, type: 'text', text: attack,
        timestamp: Date.now(), replyTo: { id: 'other', fromName: attack, text: attack } });
      const text = chatMessages.querySelector('.msg-text-content').textContent;
      renderMessageBubble({ id: 'image', fromId: 'SYNC-1002', type: 'file', fileData: { url: quotedUrl, name: attack, type: 'image/png', size: 10 } });
      renderMessageBubble({ id: 'video', fromId: 'SYNC-1002', type: 'file', fileData: { url: quotedUrl, name: attack, type: 'video/mp4', size: 10 } });
      activeConversationMessages = [{ id: 'image', fromId: 'SYNC-1002', type: 'file', timestamp: Date.now(),
        fileData: { url: quotedUrl, data: quotedUrl, name: attack, type: 'image/png' } }];
      renderMediaHubContent('images'); renderDrawerMedia('img');
      const imageAlt = mediaHubContent.querySelector('img').alt;
      activeConversationMessages.push({ id: 'doc', type: 'file', timestamp: Date.now(), fileData: { url: quotedUrl, name: attack, type: 'application/pdf' } });
      renderMediaHubContent('docs'); renderDrawerMedia('doc');
      const downloadName = mediaHubContent.querySelector('a').download;
      activeConversationMessages.push({ id: 'audio', type: 'audio', timestamp: Date.now(), audioData: quotedUrl, fromName: attack });
      renderMediaHubContent('audios');
      const preview = createLinkCardElement({ url: '/uploads/file.pdf', image: quotedUrl, title: attack, description: attack, domain: attack });
      document.body.appendChild(preview);
      triggerPopupNotification(attack, attack, attack);
      showMirroredNotificationToast({ icon: attack, title: attack, body: attack });
      const contact = { syncId: 'SYNC-1002', cleanDisplayName: attack, formattedName: attack, avatarUrl: quotedUrl, lastMessage: { text: attack } };
      renderContacts([contact]); updateDrawerContact(contact);
      applyProfileUpdate({ syncId: currentUser.syncId, avatarUrl: quotedUrl, cleanDisplayName: attack }); openProfileSettings();
      return { text, imageAlt, downloadName, previewTitle: preview.querySelector('p.font-bold').textContent,
        contactName: contactsList.querySelector('p.font-bold').textContent,
        injected: [chatMessages, contactsList, mediaHubContent, drawerMediaContent, activeChatAvatar,
          popupNotifications, document.getElementById('mirrored-notification-container'), preview]
          .reduce((sum, element) => sum + element.querySelectorAll('[onerror], [onload], svg, script').length, 0), xss: window.__xss };
    })()`);
    assert.equal(result.text, attack);
    assert.equal(result.imageAlt, attack);
    assert.equal(result.downloadName, attack);
    assert.equal(result.previewTitle, attack);
    assert.equal(result.contactName, attack);
    assert.equal(result.injected, 0);
    assert.equal(result.xss, 0);
    await cdp.evaluate(`selectContact('SYNC-1002')`); // Exercises the actual chat-header avatar sink.
  }
  for (const url of unsafeUrls) {
    const result = await cdp.evaluate(`(() => {
      const url = ${JSON.stringify(url)};
      chatMessages.replaceChildren(); renderedMessageIds.clear();
      renderMessageBubble({ id: 'bad', fromId: 'SYNC-1002', type: 'file', fileData: { url, name: 'x.png', type: 'image/png' } });
      activeConversationMessages = [{ id: 'bad', type: 'audio', audioData: url, timestamp: Date.now() }];
      renderMediaHubContent('audios');
      renderContacts([{ syncId: 'SYNC-1002', avatarUrl: url, formattedName: 'Bob' }]);
      applyProfileUpdate({ syncId: currentUser.syncId, avatarUrl: url });
      updateDrawerContact({ syncId: 'SYNC-1002', avatarUrl: url });
      const audio = mediaHubContent.querySelector('audio');
      const preview = createLinkCardElement({ url: '/uploads/document.pdf', image: url, title: 'Preview' });
      return { imageSrc: chatMessages.querySelector('img').getAttribute('src'),
        downloadHref: chatMessages.querySelector('a').getAttribute('href'), audioSrc: audio.getAttribute('src'),
        avatarSrc: headerUserAvatar.getAttribute('src'), drawerSrc: drawerContactAvatarImg.getAttribute('src'),
        preview: createLinkCardElement({ url }) === null, previewImage: preview.querySelector('.preview-image') === null, xss: window.__xss };
    })()`);
    assert.equal(result.imageSrc, null);
    assert.equal(result.downloadHref, null);
    assert.equal(result.audioSrc, null);
    assert.equal(result.avatarSrc, null);
    assert.equal(result.drawerSrc, null);
    assert.equal(result.preview, true);
    assert.equal(result.previewImage, true);
    assert.equal(result.xss, 0);
  }
  const file = await upload(png, 'legitimate.png', 'image/png');
  const svg = await upload('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" onload="alert(1)"><rect width="8" height="8" fill="red"/></svg>', 'vector.svg', 'image/svg+xml');
  const result = await cdp.evaluate(`(async () => {
    chatMessages.replaceChildren(); renderedMessageIds.clear();
    renderMessageBubble({ id: 'normal', fromId: 'SYNC-1002', type: 'text', text: 'Hola SYNC ENGINE' });
    renderMessageBubble({ id: 'good-image', fromId: 'SYNC-1002', type: 'file', fileData: ${JSON.stringify(file)} });
    const image = chatMessages.querySelector('img');
    await image.decode();
    const bytes = await (await fetch(${JSON.stringify(file.url)})).blob();
    const avatar = await processProfileAvatar(new File([bytes], 'avatar.png', { type: 'image/png' }));
    applyProfileUpdate({ syncId: currentUser.syncId, avatarUrl: avatar, cleanDisplayName: 'Alice' });
    await headerUserAvatar.decode();
    const resized = await processChatImage(new File([bytes], 'chat.png', { type: 'image/png' }), 1600, 0.85);
    return { text: chatMessages.querySelector('.msg-text-content').textContent, width: image.naturalWidth,
      avatar: avatar.startsWith('data:image/jpeg;base64,'), avatarWidth: headerUserAvatar.naturalWidth,
      resized: resized.type, connected: socket.connected, xss: window.__xss };
  })()`);
  assert.equal(result.text, 'Hola SYNC ENGINE');
  assert.equal(result.width, 1);
  assert.equal(result.avatar, true);
  assert.equal(result.avatarWidth, 1080);
  assert.equal(result.resized, 'image/jpeg');
  assert.equal(result.connected, true);
  assert.equal(result.xss, 0);
  const vector = await cdp.evaluate(`(async () => {
    renderMessageBubble({ id: 'vector', fromId: 'SYNC-1002', type: 'file', fileData: ${JSON.stringify(svg)} });
    const image = document.getElementById('msg-vector').querySelector('img');
    await image.decode();
    const bytes = await (await fetch(${JSON.stringify(svg.url)})).blob();
    const localAvatar = await processProfileAvatar(new File([bytes], 'vector.svg', { type: 'image/svg+xml' }));
    return { width: image.naturalWidth, avatar: localAvatar.startsWith('data:image/jpeg;base64,'), xss: window.__xss };
  })()`);
  assert.equal(vector.width, 8);
  assert.equal(vector.avatar, true);
  assert.equal(vector.xss, 0);
  // Main client's real upload/emit handler, not a duplicate implementation.
  const sent = await cdp.evaluate(`(async () => {
    const bytes = await (await fetch(${JSON.stringify(file.url)})).blob();
    pendingSendFile = new File([bytes], 'document.txt', { type: 'text/plain' });
    const received = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      socket.once('message-sent', () => { clearTimeout(timeout); resolve(true); });
    });
    confirmSendMediaBtn.click();
    return await received;
  })()`);
  assert.equal(sent, true);
  assert.ok(messages.at(-1).fileData.url.startsWith('/api/files/'));

  const vaultSaved = await cdp.evaluate(`(async () => {
    window.prompt = () => 'test-master-passphrase';
    openVaultBtn.click();
    vaultTitleInput.value = 'Browser vault test';
    vaultCategorySelect.value = 'note';
    vaultSecretInput.value = 'browser-only secret value';
    vaultHintInput.value = 'public hint';
    await handleSaveVaultItem();
    await loadVaultItems();
    const card = vaultItemsContainer.querySelector('.vault-item-card');
    const masked = card.querySelector('.secret-text').textContent;
    card.querySelector('.btn-toggle-secret').click();
    return { masked, revealed: card.querySelector('.secret-text').textContent };
  })()`);
  assert.equal(vaultSaved.masked, '••••••••••••');
  assert.equal(vaultSaved.revealed, 'browser-only secret value');
  const storedVaultItem = db.testData.vaultItems[users[0].syncId].find((item) => item.title === 'Browser vault test');
  assert.ok(storedVaultItem.encryptedContent);
  assert.equal(Object.hasOwn(storedVaultItem, 'secretContent'), false);
  assert.equal(JSON.stringify(storedVaultItem).includes('browser-only secret value'), false);
  const fetchedVault = await (await fetch(base + '/api/vault', {
    headers: { Authorization: 'Bearer test-alice' }
  })).json();
  assert.equal(Object.hasOwn(fetchedVault.items.find((item) => item.id === storedVaultItem.id), 'secretContent'), false);

  await cdp.evaluate(`(() => {
    closeVaultModalBtn.click();
    window.prompt = () => 'incorrect-master-passphrase';
    openVaultBtn.click();
  })()`);
  await cdp.evaluate(`new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (vaultItemsContainer.textContent.includes('No se pudo cargar o descifrar')) { clearInterval(timer); resolve(true); }
      else if (Date.now() - start > 5000) { clearInterval(timer); reject(new Error('Vault did not reject an incorrect master passphrase')); }
    }, 25);
  })`);
  const wrongKeyState = await cdp.evaluate(`({
    showsSecret: vaultItemsContainer.textContent.includes('browser-only secret value'),
    masterInputCleared: vaultSecretInput.value === ''
  })`);
  assert.equal(wrongKeyState.showsSecret, false);
  assert.equal(wrongKeyState.masterInputCleared, true);
  await cdp.evaluate('closeVaultModalBtn.click()');

  // HTML directly opened from the app origin must download, never become an app document.
  const html = await upload('<script>alert(1)</script>', 'direct.html', 'text/html');
  const navigation = await cdp.send('Page.navigate', { url: base + html.url });
  assert.ok(navigation.isDownload || navigation.errorText === 'net::ERR_ABORTED', JSON.stringify(navigation));
  assert.equal(await cdp.evaluate('window.__xss'), 0);
});

test('real browser queues offline private text and replays it once after reconnect', async (t) => {
  if (!cdp) db.saveTextMessage(users[0].syncId, users[1].syncId, 'Outbox test history');
  if (!await startBrowser(t)) return;
  const disconnected = await cdp.evaluate(`(() => {
    socket.disconnect();
    isSocketAuthenticated = false;
    return JSON.stringify({ connected: socket.connected, recipient: activeContactSyncId });
  })()`).then(JSON.parse).catch((error) => { throw new Error('Disconnect evaluation failed: ' + error.message); });
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.recipient, users[1].syncId);
  await cdp.evaluate(`(async () => {
    chatTextarea.value = 'Offline private message';
    await handleSendMessage();
    return true;
  })()`).catch((error) => { throw new Error('Queue evaluation failed: ' + error.message); });
  const queued = await cdp.evaluate(`getOfflineMessages().then(messages => JSON.stringify((() => {
    const entry = messages.find(message => message.text === 'Offline private message');
    return { saved: Boolean(entry), status: entry && entry.status, text: entry && entry.text,
      textarea: chatTextarea.value };
  })()))`).then(JSON.parse).catch((error) => { throw new Error('Outbox evaluation failed: ' + error.message); });
  assert.equal(queued.textarea, '');
  assert.equal(queued.saved, true);
  assert.equal(queued.status, 'pending');

  await cdp.evaluate('socket.connect(); true');
  await cdp.evaluate(`new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(async () => {
      const stillQueued = (await getOfflineMessages()).some(message => message.text === 'Offline private message');
      if (!stillQueued && socket.connected && isSocketAuthenticated) {
        clearInterval(timer); resolve(true);
      } else if (Date.now() - started > 10000) {
        clearInterval(timer); reject(new Error('Offline message did not replay'));
      }
    }, 50);
  })`);
  assert.equal(messages.filter((message) => message.text === 'Offline private message').length, 1);
});
