'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

class DevTools {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (!message.id) { this.events.push(message); return; }
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async wait(expression) {
    return this.evaluate(`new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (${expression}) { clearInterval(timer); resolve(true); }
        else if (Date.now() - start > 12000) { clearInterval(timer); reject(new Error('Browser condition timed out')); }
      }, 30);
    })`);
  }
  close() { this.socket.close(); }
}

module.exports = async function launchBrowser(tempDir) {
  const executable = [process.env.CHROME_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/chromium', '/usr/bin/google-chrome'].find((file) => file && fs.existsSync(file));
  if (!executable) return null;
  const child = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + path.join(tempDir, 'browser'),
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const browserUrl = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Chromium startup timeout: ' + stderr)); }, 20000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const debuggerBase = browserUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.+$/, '');
  const rootSocket = new WebSocket(browserUrl);
  await once(rootSocket, 'open');
  const browser = new DevTools(rootSocket);
  const pages = [];
  return {
    browser,
    async page(url, token) {
      const { browserContextId } = await browser.send('Target.createBrowserContext');
      const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
      const targets = await (await fetch(debuggerBase + '/json/list')).json();
      const target = targets.find((item) => item.id === targetId);
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await once(ws, 'open');
      const page = new DevTools(ws);
      page.contextId = browserContextId;
      pages.push(page);
      await page.send('Page.enable');
      await page.send('Runtime.enable');
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        window.alert = (value) => { throw new Error('Unexpected alert: ' + value); };
        ${token ? `localStorage.setItem('sync_engine_auth_token', ${JSON.stringify(token)});` : ''}
      ` });
      await page.send('Page.navigate', { url });
      await page.wait("document.readyState === 'complete'");
      return page;
    },
    async close() {
      for (const page of pages) page.close();
      try { await browser.send('Browser.close'); } catch (_) {}
      browser.close();
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
  };
};
