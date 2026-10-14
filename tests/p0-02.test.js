'use strict';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { io: connect } = require('socket.io-client');
const isolatedDb = require('./helpers/isolated-db');
const launchBrowser = require('./helpers/browser');
const root = path.resolve(__dirname, '..');
const realRequire = createRequire(path.join(root, 'server.js'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const users = ['alice', 'bob', 'charlie', 'dave'].map((username, index) => ({
  username, syncId: 'SYNC-' + (1001 + index), cleanDisplayName: username,
  formattedName: 'SYNC-' + (1001 + index) + ' - ' + username
}));
const sockets = [];
let tempDir, db, server, socketServer, base, fileAB, messageAB, browser, alicePage, outsiderPage;

function bearer(user = 'alice') { return { Authorization: 'Bearer test-' + user }; }
async function get(file, user, extra = {}) {
  const headers = user ? { ...bearer(user), ...extra } : extra;
  return fetch(base + (typeof file === 'string' ? file : file.url), { headers });
}
function waitEvent(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, receive); reject(new Error('Missing event: ' + name)); }, 5000);
    function receive(data) { clearTimeout(timer); resolve(data); }
    socket.once(name, receive);
  });
}
async function socketFor(user) {
  const socket = connect(base, { transports: ['websocket'], autoConnect: false, forceNew: true });
  sockets.push(socket);
  const connected = once(socket, 'connect');
  socket.connect();
  await connected;
  const authenticated = waitEvent(socket, 'authenticated');
  socket.emit('authenticate', { token: 'test-' + user });
  await authenticated;
  return socket;
}
async function upload(bytes = png, name = 'picture.png', type = 'image/png', user = 'alice') {
  const body = new FormData();
  body.append('file', new Blob([bytes], { type }), name);
  const response = await fetch(base + '/api/upload', { method: 'POST', headers: bearer(user), body });
  assert.equal(response.status, 200);
  return (await response.json()).file;
}
async function share(file, from = 'alice', to = 'bob', legacy = false) {
  const socket = await socketFor(from);
  const sent = waitEvent(socket, 'message-sent');
  const url = legacy ? '/uploads/' + file.filename : file.url;
  socket.emit('send-private-message', {
    clientMsgId: 'p002-' + Math.random().toString(36).slice(2),
    toSyncId: users.find((user) => user.username === to).syncId,
    type: 'file', fileData: { ...file, url, data: url }
  });
  const { id } = await sent;
  return db.testData.messages.find((message) => message.id === id);
}
function wav() {
  const samples = 8000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(process.env.SYNC_TEST_TMP || os.tmpdir(), 'sync-files-'));
  fs.mkdirSync(path.join(tempDir, 'public', 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'data', 'ssl'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'public', 'assets'), { recursive: true });
  for (const file of ['index.html', 'widget.html', 'widget.css', 'widget.js', 'safe-content.js', 'private-files.js', 'style.css', 'sw.js', 'manifest.json']) {
    let content = fs.readFileSync(path.join(root, 'public', file), 'utf8');
    if (file.endsWith('.html')) content = content
      .replace('<script src="https://cdn.tailwindcss.com"></script>', '<script>window.tailwind = {};</script>')
      .replace(/<script src="https:\/\/cdn\.socket\.io\/[^>]+><\/script>/g, '<script src="/socket.io/socket.io.js"></script>')
      .replace(/<link[^>]+https:\/\/fonts\.[^>]+>/g, '');
    fs.writeFileSync(path.join(tempDir, 'public', file), content);
  }
  fs.copyFileSync(path.join(root, 'public', 'assets', 'logo.png'), path.join(tempDir, 'public', 'assets', 'logo.png'));
  db = isolatedDb(root, tempDir, users);
  const context = {
    __dirname: tempDir, process: { env: { NODE_ENV: 'test', PORT: '3000' } },
    console: { log() {}, warn() {}, error() {} },
    Buffer, URL, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === './db') return db;
      if (name === './public/safe-content') return realRequire(name);
      if (name === 'selfsigned') return { generate: async () => null };
      if (name === 'web-push') return { setVapidDetails() { throw new Error('disabled in fixtures'); } };
      if (name === 'http') return {
        createServer(app) { server = http.createServer(app); server.listen = () => server; return server; }
      };
      return realRequire(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8') + '\nglobalThis.testIo = io;', context);
  socketServer = context.testIo;
  await new Promise((resolve) => http.Server.prototype.listen.call(server, 0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  fileAB = await upload();
  messageAB = await share(fileAB);
});

after(async () => {
  if (browser) await browser.close();
  for (const socket of sockets) socket.disconnect();
  if (socketServer) await new Promise((resolve) => socketServer.close(resolve));
  if (server && server.listening) await new Promise((resolve) => server.close(resolve));
  if (db) await db.writeDb(db.testData);
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (_) {}
  }
});

test('TEST 1: uploader A reads the file associated with its real A-B message', async () => {
  assert.ok(fileAB.id);
  assert.equal(db.getFileById(fileAB.id).ownerId, users[0].syncId);
  assert.ok(messageAB.fileIds.includes(fileAB.id));
  const response = await get(fileAB, 'alice');
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});

test('TEST 2: recipient B reads the same file', async () => {
  const response = await get(fileAB, 'bob');
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});

test('TEST 3: authenticated outsider C receives 403', async () => {
  assert.equal((await get(fileAB, 'charlie')).status, 403);
});

test('TEST 4: anonymous/invalid identity receives 401; token in URL is not authentication', async () => {
  assert.equal((await get(fileAB)).status, 401);
  assert.equal((await get(fileAB.url + '?token=test-alice')).status, 401);
  assert.equal((await get(fileAB, null, { Authorization: 'Bearer invalid' })).status, 401);
});

test('TEST 5: knowing the physical URL and encoded/normalized variants does not bypass authorization', async () => {
  const paths = [
    '/uploads/' + fileAB.filename, '/UPLOADS/' + fileAB.filename,
    '/uploads%2f' + fileAB.filename, '/uploads%5c' + fileAB.filename,
    '/assets/%2e%2e/uploads/' + fileAB.filename, '/uploads./' + fileAB.filename,
    '/uploads::$INDEX_ALLOCATION/' + fileAB.filename
  ];
  for (const url of paths) {
    const denied = await get(url, 'charlie');
    assert.ok([400, 403].includes(denied.status), url + ': ' + denied.status);
    assert.ok([400, 401].includes((await get(url)).status));
  }
  assert.equal((await get('/uploads/' + fileAB.filename, 'alice')).status, 200);
});

test('TEST 6: replacing just an ID/URL cannot cross conversations; forged message references cannot grant access', async () => {
  const ownFile = await upload(png, 'charlie.png', 'image/png', 'charlie');
  await share(ownFile, 'charlie', 'dave');
  assert.equal((await get(ownFile, 'charlie')).status, 200);
  assert.equal((await get(fileAB, 'charlie')).status, 403);
  assert.equal((await get(ownFile, 'alice')).status, 403);
  const socket = await socketFor('charlie');
  for (const url of [fileAB.url, '/uploads/' + fileAB.filename]) {
    const rejected = waitEvent(socket, 'error-message');
    socket.emit('send-private-message', { toSyncId: users[3].syncId, type: 'file', fileData: { ...fileAB, url, data: url } });
    assert.match((await rejected).message, /No puedes compartir/);
  }
  const sent = waitEvent(socket, 'message-sent');
  socket.emit('send-private-message', { toSyncId: users[3].syncId, type: 'text', text: 'not an attachment', fileIds: [fileAB.id] });
  await sent;
  assert.equal((await get(fileAB, 'charlie')).status, 403);
  const duplicate = waitEvent(socket, 'error-message');
  socket.emit('send-private-message', { clientMsgId: messageAB.id, toSyncId: users[3].syncId, type: 'text', text: 'same client id' });
  assert.match((await duplicate).message, /identificador del mensaje ya está en uso/i);
  assert.equal((await get(fileAB, 'charlie')).status, 403);
});

test('TEST 7: deleting a message revokes its file reads; disk bytes alone never grant access', async () => {
  const file = await upload(png, 'delete.png');
  const message = await share(file);
  const alice = await socketFor('alice');
  const deleted = waitEvent(alice, 'message-deleted-for-everyone');
  alice.emit('delete-message-for-everyone', { messageId: message.id, toSyncId: users[1].syncId });
  await deleted;
  for (const user of ['alice', 'bob', 'charlie']) assert.equal((await get(file, user)).status, 403);
  assert.equal((await get(file)).status, 401);
  assert.equal(fs.existsSync(path.join(tempDir, 'public', 'uploads', file.filename)), true);
});

test('TEST 8: authorized ranges and HEAD work; unauthorized ranges and conditional requests stay denied', async () => {
  const response = await get(fileAB, 'bob', { Range: 'bytes=0-7' });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png.subarray(0, 8));
  assert.match(response.headers.get('content-range'), /^bytes 0-7\//);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await get(fileAB, 'charlie', { Range: 'bytes=0-7' })).status, 403);
  assert.equal((await get(fileAB, null, { Range: 'bytes=0-7' })).status, 401);
  const etag = (await get(fileAB, 'alice')).headers.get('etag');
  assert.equal((await get(fileAB, 'charlie', { 'If-None-Match': etag })).status, 403);
  const head = await fetch(base + fileAB.url, { method: 'HEAD', headers: bearer('alice') });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), png.length);
});

test('unassociated uploads, missing metadata/files and legacy unproven references fail closed', async () => {
  const orphan = await upload(png, 'orphan.png');
  assert.equal((await get(orphan, 'alice')).status, 403);
  fs.writeFileSync(path.join(tempDir, 'public', 'uploads', 'legacy.png'), png);
  db.saveMessage({ fromId: users[0].syncId, toId: users[1].syncId, type: 'file', fileData: { url: '/uploads/legacy.png' } });
  for (const user of ['alice', 'bob', 'charlie']) assert.equal((await get('/uploads/legacy.png', user)).status, 404);
  assert.equal((await get('/api/files/not-a-file', 'alice')).status, 404);
  const missing = await upload(png, 'missing.png');
  await share(missing);
  fs.unlinkSync(path.join(tempDir, 'public', 'uploads', missing.filename));
  assert.equal((await get(missing, 'alice')).status, 404);
});

test('legacy alias can attach only a registered owned file; clearing history also removes authorization', async () => {
  const file = await upload(png, 'legacy-alias.png');
  await share(file, 'alice', 'bob', true);
  assert.equal((await get('/uploads/' + file.filename, 'bob')).status, 200);
  const response = await fetch(base + '/api/messages/' + users[1].syncId, { method: 'DELETE', headers: bearer('alice') });
  assert.equal(response.status, 200);
  assert.equal((await get(file, 'alice')).status, 403);
  assert.equal((await get(file, 'bob')).status, 403);
  // Restore the A-B fixture for browser/media tests without changing file ownership.
  messageAB = await share(fileAB);
});

test('file credential cookie is scoped, never replaces other API auth, and still enforces resource permissions', async () => {
  const response = await fetch(base + '/api/files/access', { method: 'POST', headers: bearer('charlie') });
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  for (const cookie of cookies) { assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); }
  assert.ok(cookies.some((cookie) => cookie.includes('Path=/api/files')));
  assert.ok(cookies.some((cookie) => cookie.includes('Path=/uploads')));
  const cookie = cookies[0].split(';')[0];
  assert.equal((await get(fileAB, null, { Cookie: cookie })).status, 403);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await get(fileAB, null, { Cookie: cookie, Authorization: 'Bearer invalid' })).status, 401);
  const https = await fetch(base + '/api/files/access', { method: 'POST', headers: { ...bearer(), 'X-Forwarded-Proto': 'https' } });
  assert.ok(https.headers.getSetCookie().every((value) => value.includes('Secure')));
  const cleared = await fetch(base + '/api/files/access/clear', { method: 'POST' });
  assert.ok(cleared.headers.getSetCookie().every((value) => /Expires=Thu, 01 Jan 1970/.test(value)));
});

async function browserReady(t) {
  if (!browser) browser = await launchBrowser(tempDir);
  if (!browser) { t.skip('Set CHROME_PATH for real media/widget verification'); return false; }
  if (!alicePage) {
    alicePage = await browser.page(base + '/', 'test-alice');
    await alicePage.wait("typeof socket !== 'undefined' && socket && socket.connected && activeContactSyncId");
    await alicePage.evaluate(`navigator.serviceWorker.ready`);
    await alicePage.wait('navigator.serviceWorker.controller !== null');
    outsiderPage = await browser.page(base + '/', 'test-charlie');
    await outsiderPage.wait("typeof socket !== 'undefined' && socket && socket.connected && activeContactSyncId");
  }
  return true;
}

test('TEST 9: real image decoding with file-scoped cookie succeeds for A and fails for C/anonymous browser', async (t) => {
  if (!await browserReady(t)) return;
  const image = await alicePage.evaluate(`(async () => {
    const image = new Image(); image.src = ${JSON.stringify(fileAB.url)};
    await image.decode();
    return { width: image.naturalWidth, visibleCookies: document.cookie };
  })()`);
  assert.equal(image.width, 1);
  assert.equal(image.visibleCookies.includes('sync_engine_file_auth'), false);
  const denied = await outsiderPage.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(fileAB.url)});
    const image = new Image(); image.src = ${JSON.stringify(fileAB.url)};
    let decoded = true; try { await image.decode(); } catch (_) { decoded = false; }
    return { status: response.status, decoded };
  })()`);
  assert.equal(denied.status, 403);
  assert.equal(denied.decoded, false);
  const anonymous = await browser.page(base + '/', null);
  assert.equal(await anonymous.evaluate(`fetch(${JSON.stringify(fileAB.url)}).then(r => r.status)`), 401);
});

test('TEST 10: real WAV and generated WebM video load/play through authorized streaming routes', async (t) => {
  if (!await browserReady(t)) return;
  // Exercise playback after a real trusted gesture, respecting browser autoplay policy.
  await alicePage.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
  await alicePage.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 });
  const audio = await upload(wav(), 'sample.wav', 'audio/wav');
  const socket = await socketFor('alice');
  const sent = waitEvent(socket, 'message-sent');
  socket.emit('send-private-message', { toSyncId: users[1].syncId, type: 'audio', audioData: audio.url });
  await sent;
  const audioResult = await alicePage.evaluate(`new Promise((resolve, reject) => {
    const audio = document.createElement('audio'); audio.src = ${JSON.stringify(audio.url)}; audio.muted = true;
    audio.onloadedmetadata = async () => {
      try { await audio.play(); audio.pause(); resolve({ duration: audio.duration, state: audio.readyState }); } catch (error) { reject(error); }
    };
    audio.onerror = () => reject(new Error('Audio failed')); document.body.appendChild(audio);
  })`);
  assert.equal(audioResult.duration, 1);
  assert.ok(audioResult.state >= 1);
  const video = await alicePage.evaluate(`(async () => {
    // Deterministic, pre-encoded VP8/WebM fixture (32x32, 1 second).
    // Avoids MediaRecorder/real-time encoding differences across CI Chromium builds.
    const webmBytes = Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAIDEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggHt7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuNy4xMDNXQYxMYXZmNjEuNy4xMDNEiYhAj0AAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WIXUYetILvUC6cgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QdzWUA4JCwgSC6gSCagQJVsIRVuYEBElTDZ/tzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYxLjcuMTAzc3PWY8CLY8WIXUYetILvUC5nyKFFo4dFTkNPREVSRIeUTGF2YzYxLjE5LjEwMSBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1xeeBAKOkgQAAgDACAJ0BKiAAIAAARwiFhYiZhIgCAgAHkPPJwP7/q1CAo5qBAfQA0QEAARAQABgAHlf0DAAPmAD+/6tQgBxTu2uRu4+zgQC3iveBAfGCAaPwgQM=', 'base64');
    const webmBlob = new Blob([webmBytes], { type: 'video/webm' });
    const localUrl = URL.createObjectURL(webmBlob);
    try {
      await new Promise((resolve, reject) => {
        const localVideo = document.createElement('video');
        localVideo.muted = true;
        localVideo.onloadeddata = () => localVideo.videoWidth === 32 && localVideo.videoHeight === 32
          ? resolve() : reject(new Error('Fixture WebM decoded with unexpected dimensions: ' + localVideo.videoWidth + 'x' + localVideo.videoHeight));
        localVideo.onerror = () => reject(new Error('Known WebM fixture failed local decoding (' + webmBytes.length + ' bytes)'));
        localVideo.src = localUrl;
      });
    } finally {
      URL.revokeObjectURL(localUrl);
    }
    const body = new FormData(); body.append('file', webmBlob, 'sample.webm');
    const response = await fetch('/api/upload', { method: 'POST', headers: { Authorization: 'Bearer test-alice' }, body });
    const file = (await response.json()).file;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Send failed')), 5000);
      socket.once('message-sent', () => { clearTimeout(timer); resolve(); });
      socket.emit('send-private-message', { toSyncId: 'SYNC-1002', type: 'file', fileData: file });
    });
    const video = document.createElement('video'); video.muted = true; video.src = file.url;
    document.body.appendChild(video);
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = async () => {
        let responseInfo = { fetchError: null };
        try {
          const response = await fetch(file.url);
          const bytes = await response.clone().arrayBuffer();
          responseInfo = {
            status: response.status,
            contentType: response.headers.get('content-type'),
            contentLength: response.headers.get('content-length'),
            contentRange: response.headers.get('content-range'),
            acceptRanges: response.headers.get('accept-ranges'),
            cacheControl: response.headers.get('cache-control'),
            bytesReceived: bytes.byteLength
          };
        } catch (error) {
          responseInfo.fetchError = String(error && error.message || error);
        }
        reject(new Error('Video failed: ' + JSON.stringify({
          mediaError: video.error ? { code: video.error.code, message: video.error.message } : null,
          networkState: video.networkState,
          readyState: video.readyState,
          currentSrc: video.currentSrc,
          fixtureBytes: webmBytes.length,
          response: responseInfo
        })));
      };
    });
    await video.play(); video.pause();
    return { file, width: video.videoWidth, height: video.videoHeight };
  })()`);
  assert.equal(video.width, 32);
  assert.equal(video.height, 32);
  assert.equal((await get(video.file, 'bob', { Range: 'bytes=0-15' })).status, 206);
  assert.equal((await get(video.file, 'charlie')).status, 403);
  assert.equal((await get(audio, 'charlie')).status, 403);
  // Recorder-produced voice notes must also be registered/associated, not public.
  const recorded = waitEvent(socket, 'receive-private-message');
  socket.emit('send-private-message', { toSyncId: users[1].syncId, type: 'audio', audioData: 'data:audio/wav;base64,' + wav().toString('base64') });
  const voice = await recorded;
  assert.equal(voice.fileIds.length, 1);
  assert.equal((await get(voice.audioData, 'bob')).status, 200);
  assert.equal((await get(voice.audioData, 'charlie')).status, 403);
});

test('TEST 11: documents stream/download with authorization and retain P0-01 protection', async (t) => {
  const content = 'Documento privado A-B';
  const document = await upload(content, 'private.txt', 'text/plain');
  await share(document);
  const response = await get(document, 'bob');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.equal(await response.text(), content);
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await get(document, 'charlie')).status, 403);
  if (!await browserReady(t)) return;
  const downloads = path.join(tempDir, 'downloads'); fs.mkdirSync(downloads, { recursive: true });
  await browser.browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true, browserContextId: alicePage.contextId });
  const result = await alicePage.send('Page.navigate', { url: base + document.url });
  assert.ok(result.isDownload || result.errorText === 'net::ERR_ABORTED');
  for (let i = 0; i < 100 && !fs.existsSync(path.join(downloads, 'private.txt')); i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fs.readFileSync(path.join(downloads, 'private.txt'), 'utf8'), content);
});

test('TEST 12: Media Center uses private routes; active service worker never caches/serves private media offline', async (t) => {
  if (!await browserReady(t)) return;
  const result = await alicePage.evaluate(`(async () => {
    await selectContact('SYNC-1002'); renderMediaHubContent('images');
    const image = mediaHubContent.querySelector('img'); await image.decode();
    renderDrawerMedia('img'); await drawerMediaContent.querySelector('img').decode();
    const names = await caches.keys();
    const requests = (await Promise.all(names.map(name => caches.open(name).then(cache => cache.keys())))).flat();
    return { width: image.naturalWidth, url: image.src,
      cachedPrivate: requests.filter(request => /\\/(uploads|api\\/files)\\//.test(new URL(request.url).pathname)).length,
      status: (await fetch(${JSON.stringify(fileAB.url)})).status };
  })()`);
  assert.equal(result.width, 1);
  assert.ok(result.url.includes('/api/files/'));
  assert.equal(result.cachedPrivate, 0);
  assert.equal(result.status, 200);
  await alicePage.send('Network.enable');
  await alicePage.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  assert.equal(await alicePage.evaluate(`fetch(${JSON.stringify(fileAB.url)}).then(() => false).catch(() => true)`), true);
  await alicePage.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  assert.equal(await outsiderPage.evaluate(`fetch(${JSON.stringify(fileAB.url)}).then(r => r.status)`), 403);
});

test('TEST 13: real widget uploads/shares a capture and its resulting file stays private', async (t) => {
  if (!await browserReady(t)) return;
  const widget = await browser.page(base + '/widget.html', 'test-alice');
  await widget.wait("document.getElementById('sync-label').textContent === 'Sincronizado'");
  const previousCount = db.testData.messages.length;
  await widget.evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(fileAB.url)}); const bytes = await response.blob();
    const select = document.getElementById('contact-select'); select.value = 'SYNC-1002'; select.dispatchEvent(new Event('change'));
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'widget-capture.png', { type: 'image/png' }));
    const input = document.getElementById('camera-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
  })()`);
  await widget.wait("document.getElementById('widget-notice').textContent === 'Foto enviada correctamente.'");
  assert.ok(db.testData.messages.length > previousCount);
  const message = db.testData.messages.at(-1);
  assert.equal(message.fileData.name, 'widget-capture.png');
  assert.ok(message.fileData.url.startsWith('/api/files/'));
  assert.equal(message.fileIds.length, 1);
  assert.equal((await get(message.fileData.url, 'bob')).status, 200);
  assert.equal((await get(message.fileData.url, 'charlie')).status, 403);
  assert.equal((await get(message.fileData.url)).status, 401);
  const file = db.getFileById(message.fileIds[0]);
  assert.equal((await get('/uploads/' + file.filename)).status, 401);
});
