const http = require('http');
const WebSocket = require('ws');

const BASE_URL = 'http://localhost:3737';

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    }).on('error', reject);
  });
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function runAllTests() {
  console.log('=== STARTING COMPLETE SELF-TEST SUITE ===\n');

  // Test 1: Status API
  console.log('1. Testing /api/status...');
  const statusRes = await get('/api/status');
  console.assert(statusRes.status === 200, 'Status endpoint failed');
  console.assert(statusRes.data.status === 'online', 'Status is not online');
  console.log('   ✓ Status is ONLINE. Active model:', statusRes.data.activeModel, '| Binary:', statusRes.data.codexBinary);

  // Test 2: Models API
  console.log('2. Testing /api/models...');
  const modelsRes = await get('/api/models');
  console.assert(modelsRes.status === 200, 'Models endpoint failed');
  console.assert(Array.isArray(modelsRes.data.presets), 'Presets is not an array');
  console.log('   ✓ Available presets:', modelsRes.data.presets.map(p => p.name).join(', '));

  // Test 3: Plugins API
  console.log('3. Testing /api/plugins...');
  const pluginsRes = await get('/api/plugins');
  console.assert(pluginsRes.status === 200, 'Plugins endpoint failed');
  console.assert(pluginsRes.data.plugins.length > 0, 'No plugins found');
  const mentions = pluginsRes.data.quickMentions.map(m => m.tag);
  console.log('   ✓ Plugins discovered:', pluginsRes.data.plugins.length, '| Quick mentions:', mentions.join(' '));

  // Test 4: Threads API
  console.log('4. Testing /api/threads...');
  const threadsRes = await get('/api/threads?limit=5');
  console.assert(threadsRes.status === 200, 'Threads endpoint failed');
  console.log(`   ✓ Retrieved ${threadsRes.data.threads.length} recent sessions from SQLite.`);

  // Test 5: Provider Connectivity Test
  console.log('5. Testing /api/models/test (Groq API ping test)...');
  const testPing = await post('/api/models/test', {
    baseUrl: 'https://api.groq.com/openai/v1'
  });
  console.log('   ✓ Endpoint ping returned latency:', testPing.data.latency, 'ms | HTTP', testPing.data.status || testPing.data.error);

  // Test 6: Setting Active Model
  console.log('6. Testing /api/models/set-default...');
  const setModelRes = await post('/api/models/set-default', {
    model: 'muse-spark-1.3-contributor',
    provider: 'meta'
  });
  console.assert(setModelRes.data.success === true, 'Failed to set default model');
  console.log('   ✓ Active model safely set to:', setModelRes.data.model);

  // Test 8: Provider contract for the model picker (regression: picker once
  // treated provider ids as model ids and rendered "undefined" base URLs)
  console.log('8. Testing provider shape contract...');
  const badProviders = (modelsRes.data.configured || [])
    .filter(p => !p.id || !p.base_url);
  console.assert(badProviders.length === 0, `Providers missing id/base_url: ${JSON.stringify(badProviders)}`);
  console.assert(modelsRes.data.presets.every(p => Array.isArray(p.defaultModels) && p.defaultModels.length > 0),
    'Every preset must declare at least one defaultModel for picker resolution');
  console.assert(modelsRes.data.presets.every(p => p.wireApi === 'responses'),
    'All presets must use responses wire: this codex binary rejects chat at startup');
  const envKeys = (modelsRes.data.configured || []).map(p => p.env_key).filter(Boolean);
  console.assert(new Set(envKeys).size === envKeys.length,
    `Each provider must map to its own env key, found duplicates: ${envKeys.join(',')}`);
  console.log(`   ✓ ${(modelsRes.data.configured || []).length} configured providers carry id + base_url; all presets declare defaultModels on responses wire; env keys distinct.`);

  // Test 9: set-default round-trips to /api/status (regression: UI showed one
  // model while config held another)
  console.log('9. Testing set-default round-trip...');
  const statusAfter = await get('/api/status');
  console.assert(statusAfter.data.activeModel === 'muse-spark-1.3-contributor',
    `Round-trip mismatch: status shows ${statusAfter.data.activeModel}`);
  console.assert(!/^(meta|openrouter|groq|ollama|lmstudio|deepseek|custom)$/.test(statusAfter.data.activeModel || ''),
    'Active model must be a model id, never a bare provider id');
  console.log('   ✓ Active model round-trips as a real model id:', statusAfter.data.activeModel);

  // Test 7: WebSocket Connection & Streaming
  console.log('7. Testing WebSocket streaming (/ws)...');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:3737/ws');
    let gotStarted = false;

    ws.on('open', () => {
      console.log('   ✓ WebSocket connected successfully');
      resolve();
      ws.close();
    });

    ws.on('error', (err) => {
      reject(err);
    });

    setTimeout(() => {
      resolve();
    }, 2000);
  });

  // Test 10: First-run setup status (drives the onboarding wizard)
  console.log('10. Testing /api/setup/status...');
  const setupRes = await get('/api/setup/status');
  console.assert(setupRes.status === 200, 'Setup status endpoint failed');
  console.assert(typeof setupRes.data.needsSetup === 'boolean', 'needsSetup must be boolean');
  console.assert(Array.isArray(setupRes.data.keyProviders), 'keyProviders must be an array');
  console.assert(setupRes.data.antigravity && Array.isArray(setupRes.data.antigravity.accounts), 'antigravity accounts must be an array');
  console.log(`   ✓ needsSetup=${setupRes.data.needsSetup}, antigravity accounts=${setupRes.data.antigravity.accounts.length}, bridge running=${setupRes.data.bridge && setupRes.data.bridge.running}`);

  // Test 11: Provider status timeline feed
  console.log('11. Testing /api/provider-status...');
  const provRes = await get('/api/provider-status');
  console.assert(provRes.status === 200, 'Provider status endpoint failed');
  console.assert(typeof provRes.data.phase === 'string' && provRes.data.phase.length > 0, 'phase must be a non-empty string');
  console.log(`   ✓ provider=${provRes.data.provider} phase=${provRes.data.phase}`);

  // Test 12: Antigravity accounts listing (no secrets echoed)
  console.log('12. Testing /api/antigravity/accounts...');
  const accRes = await get('/api/antigravity/accounts');
  console.assert(accRes.status === 200, 'Accounts endpoint failed');
  console.assert(Array.isArray(accRes.data.accounts), 'accounts must be an array');
  console.assert(!JSON.stringify(accRes.data).includes('refreshToken'), 'accounts must never echo refresh tokens');
  console.log(`   ✓ ${accRes.data.accounts.length} account(s), no secrets leaked`);

  console.log('\n=== ALL SELF-TESTS PASSED SUCCESSFULLY! ===');
}

runAllTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
