/**
 * Bridge process manager: keeps the Antigravity Responses bridge alive.
 * The app server starts it on launch (fresh-computer friendly: no manual
 * terminal step), and proxies its status for the UI turn timeline.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const BRIDGE_PORT = 8766;
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const BRIDGE_SCRIPT = path.join(__dirname, '..', 'antigravity_bridge.py');

let child = null;

function checkAlive() {
  return new Promise((resolve) => {
    const req = http.get(`${BRIDGE_URL}/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureBridge() {
  if (await checkAlive()) return { running: true, started: false };
  if (child && !child.killed) return { running: false, started: false, note: 'starting' };
  try {
    child = spawn('python3', [BRIDGE_SCRIPT], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: false
    });
    child.on('error', (err) => {
      console.error('Antigravity bridge failed to start:', err.message);
      child = null;
    });
    child.on('exit', () => { child = null; });
    // Give it a moment to bind, then verify.
    await new Promise((r) => setTimeout(r, 1200));
    return { running: await checkAlive(), started: true };
  } catch (err) {
    return { running: false, started: false, error: err.message };
  }
}

function getBridgeStatus() {
  return new Promise((resolve) => {
    const req = http.get(`${BRIDGE_URL}/v1/status`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ ok: true, status: JSON.parse(data) }); }
        catch (e) { resolve({ ok: false, error: 'bad-status-json' }); }
      });
    });
    req.on('error', () => resolve({ ok: false, error: 'bridge-unreachable' }));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve({ ok: false, error: 'bridge-timeout' });
    });
  });
}

module.exports = { ensureBridge, checkAlive, getBridgeStatus, BRIDGE_PORT };
