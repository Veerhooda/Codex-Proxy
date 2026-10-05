const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { WebSocketServer, WebSocket } = require('ws');
const configManager = require('./lib/configManager');
const sessionManager = require('./lib/sessionManager');
const codexRunner = require('./lib/codexRunner');
const antigravityAuth = require('./lib/antigravityAuth');
const bridgeManager = require('./lib/bridgeManager');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules')));

// In-memory active workspace
let currentWorkspace = process.env.CODEX_DEFAULT_WORKSPACE || path.join(os.homedir(), 'Desktop');

// Predefined provider presets
const PROVIDER_PRESETS = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    wireApi: 'responses',
    requiresOpenaiAuth: false,
    defaultModels: ['anthropic/claude-3.5-sonnet', 'deepseek/deepseek-r1', 'meta-llama/llama-3.3-70b-instruct', 'google/gemini-2.0-flash-001'],
    description: 'Access 200+ models with unified billing'
  },
  {
    id: 'meta',
    name: 'Meta Model API / Muse Spark',
    baseUrl: 'http://127.0.0.1:8765/v1',
    envKey: 'MODEL_API_KEY',
    wireApi: 'responses',
    requiresOpenaiAuth: true,
    defaultModels: ['muse-spark-1.3-contributor', 'gpt-6-astra', 'gpt-5.6-sol'],
    description: 'Local Meta proxy bridge with full tool compatibility'
  },
  {
    id: 'antigravity',
    name: 'Antigravity (Google)',
    baseUrl: 'http://127.0.0.1:8766/v1',
    envKey: 'ANTIGRAVITY_API_KEY',
    wireApi: 'responses',
    requiresOpenaiAuth: false,
    defaultModels: ['gemini-3-flash', 'gemini-3.1-pro-low', 'gemini-3.8-flash-tiered', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking'],
    description: 'Local Antigravity bridge: Google OAuth models over Responses API'
  },
  {
    id: 'groq',
    name: 'Groq Cloud',
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    wireApi: 'responses',
    requiresOpenaiAuth: false,
    defaultModels: ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    description: 'Ultra-low latency LPU inference'
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    baseUrl: 'http://localhost:11434/v1',
    envKey: 'OLLAMA_API_KEY',
    wireApi: 'responses',
    requiresOpenaiAuth: false,
    defaultModels: ['llama3.2', 'qwen2.5-coder', 'deepseek-r1:8b'],
    description: '100% private, free local execution on your Mac'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (Local)',
    baseUrl: 'http://localhost:1234/v1',
    envKey: 'LMSTUDIO_API_KEY',
    wireApi: 'responses',
    requiresOpenaiAuth: false,
    defaultModels: ['local-model'],
    description: 'Local inference via LM Studio server'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek Official',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    wireApi: 'responses',
    requiresOpenaiAuth: false,
    defaultModels: ['deepseek-chat', 'deepseek-reasoner'],
    description: 'Direct DeepSeek API with reasoning model support'
  },
  {
    id: 'custom',
    name: 'Custom Responses/OpenAI Server',
    baseUrl: 'https://your-api-endpoint.com/v1',
    envKey: 'CUSTOM_API_KEY',
    wireApi: 'responses',
    requiresOpenaiAuth: false,
    defaultModels: ['custom-model'],
    description: 'Any OpenAI / Responses API compatible server'
  }
];

// API: App Status
app.get('/api/status', (req, res) => {
  const activeInfo = configManager.getActiveModelInfo();
  const binary = codexRunner.getExecutablePath();
  const isBinaryFound = fs.existsSync(binary) || binary === 'codex';
  res.json({
    status: 'online',
    isRunning: codexRunner.isRunning(),
    codexBinary: binary,
    binaryExists: isBinaryFound,
    activeModel: activeInfo.model,
    activeProvider: activeInfo.provider,
    reasoningEffort: activeInfo.reasoning_effort,
    currentWorkspace,
    bypassActive: true
  });
});

// API: Get Models & Providers
app.get('/api/models', (req, res) => {
  const configuredProviders = configManager.getProviders();
  const activeInfo = configManager.getActiveModelInfo();
  res.json({
    configured: configuredProviders,
    presets: PROVIDER_PRESETS,
    active: activeInfo
  });
});

// API: Add or Update Provider
app.post('/api/models/add', (req, res) => {
  try {
    const { id, name, baseUrl, apiKey, envKey, wireApi, isDefault, modelName } = req.body;
    if (!id || !baseUrl) {
      return res.status(400).json({ error: 'id and baseUrl are required' });
    }
    const result = configManager.addOrUpdateProvider({
      id: id.toLowerCase().trim(),
      name,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey ? apiKey.trim() : null,
      envKey: envKey ? envKey.trim() : null,
      wireApi: wireApi || 'responses',
      isDefault: Boolean(isDefault),
      modelName: modelName ? modelName.trim() : null
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Set Default Model
app.post('/api/models/set-default', (req, res) => {
  try {
    const { model, provider } = req.body;
    if (!model) {
      return res.status(400).json({ error: 'model is required' });
    }
    const result = configManager.setDefaultModel(model, provider);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Test Provider Connectivity
app.post('/api/models/test', async (req, res) => {
  const { baseUrl, apiKey } = req.body;
  if (!baseUrl) {
    return res.status(400).json({ error: 'baseUrl is required' });
  }

  const start = Date.now();
  try {
    const testUrl = baseUrl.endsWith('/models') ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/models`;
    const headers = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(testUrl, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    clearTimeout(timeout);

    const latency = Date.now() - start;
    if (response.ok) {
      const data = await response.json().catch(() => ({}));
      return res.json({
        success: true,
        status: response.status,
        latency,
        models: Array.isArray(data?.data) ? data.data.map(m => m.id) : []
      });
    } else {
      return res.json({
        success: false,
        status: response.status,
        statusText: response.statusText,
        latency
      });
    }
  } catch (err) {
    return res.json({
      success: false,
      error: err.message,
      latency: Date.now() - start
    });
  }
});

// API: First-run setup status — drives the onboarding wizard on a fresh computer.
app.get('/api/setup/status', async (req, res) => {
  try {
    const configured = configManager.getProviders();
    const byId = new Map(configured.map((p) => [p.id, p]));
    const keyProviders = ['openrouter', 'groq', 'deepseek', 'meta'].map((id) => ({
      id,
      has_key: Boolean(byId.get(id) && byId.get(id).has_key)
    }));
    const bridge = await bridgeManager.ensureBridge();
    res.json({
      needsSetup: !keyProviders.some((p) => p.has_key) && antigravityAuth.readAccounts().length === 0,
      keyProviders,
      antigravity: {
        accounts: antigravityAuth.readAccounts().map((a) => ({ email: a.email, projectId: a.projectId || null }))
      },
      bridge: { running: bridge.running }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Save an API key for a key-based provider (creates the provider section if needed).
app.post('/api/setup/key', (req, res) => {
  try {
    const { id, apiKey, modelName, setDefault } = req.body;
    if (!id || !apiKey) {
      return res.status(400).json({ error: 'id and apiKey are required' });
    }
    const preset = (PROVIDER_PRESETS.find((p) => p.id === id) || {});
    const result = configManager.addOrUpdateProvider({
      id: String(id).toLowerCase().trim(),
      name: preset.name || id,
      baseUrl: preset.baseUrl,
      apiKey: String(apiKey).trim(),
      envKey: preset.envKey,
      wireApi: preset.wireApi || 'responses',
      isDefault: setDefault === true && Boolean(modelName),
      modelName: modelName ? String(modelName).trim() : null
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Start Google OAuth for Antigravity (returns URL to open in a popup).
app.post('/api/antigravity/auth-url', (req, res) => {
  try {
    res.json(antigravityAuth.startAuthFlow());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Poll an OAuth flow, then finish it (stores the account on success).
app.get('/api/antigravity/flow/:sessionId', async (req, res) => {
  try {
    const flow = antigravityAuth.getFlow(req.params.sessionId);
    if (!flow) return res.status(404).json({ status: 'unknown' });
    if (flow.error) return res.json({ status: 'error', error: flow.error });
    if (!flow.code) return res.json({ status: 'pending' });
    const account = await antigravityAuth.completeFlow(req.params.sessionId);
    await bridgeManager.ensureBridge();
    res.json({ status: 'done', account });
  } catch (err) {
    if (err.code === 'PENDING') return res.json({ status: 'pending' });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/antigravity/accounts', (req, res) => {
  res.json({ accounts: antigravityAuth.readAccounts().map((a) => ({ email: a.email, projectId: a.projectId || null })) });
});

app.post('/api/antigravity/remove', (req, res) => {
  try {
    res.json(antigravityAuth.removeAccount(req.body.email));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Live provider progress for the turn timeline (Antigravity bridge phases).
app.get('/api/provider-status', async (req, res) => {
  try {
    const active = configManager.getActiveModelInfo();
    if (active.provider !== 'antigravity') {
      return res.json({ provider: active.provider, phase: 'external', detail: '' });
    }
    const result = await bridgeManager.getBridgeStatus();
    if (!result.ok) {
      return res.json({ provider: 'antigravity', phase: 'unreachable', detail: result.error });
    }
    res.json({ provider: 'antigravity', ...result.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Plugins
app.get('/api/plugins', (req, res) => {
  const plugins = configManager.getPlugins();
  res.json({
    plugins,
    quickMentions: [
      { tag: '@computer', name: 'Computer Use', description: 'Control Mac GUI & Apps', plugin: 'computer-use' },
      { tag: '@chrome', name: 'Chrome Browser', description: 'Control open Chrome tabs & DOM', plugin: 'chrome' },
      { tag: '@browser', name: 'Web Research', description: 'Headless browser search & scrape', plugin: 'browser' },
      { tag: '@documents', name: 'Document Writer', description: 'Create markdown & office docs', plugin: 'documents' },
      { tag: '@spreadsheets', name: 'Spreadsheets', description: 'Excel & CSV data computation', plugin: 'spreadsheets' },
      { tag: '@presentations', name: 'Presentations', description: 'Slide decks & visual presentations', plugin: 'presentations' },
      { tag: '@code-review', name: 'Code Review', description: 'Git diff analysis & quality audit', plugin: 'code-review' },
      { tag: '@visualize', name: 'Visualizer', description: 'Generate charts, SVG & interactive HTML', plugin: 'visualize' },
      { tag: '@pdf', name: 'PDF Inspector', description: 'Extract and analyze PDF contents', plugin: 'pdf' }
    ]
  });
});

// API: Sessions / Threads
app.get('/api/threads', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 30;
  const threads = sessionManager.listRecentThreads(limit);
  res.json({ threads });
});

app.get('/api/threads/:id', (req, res) => {
  const history = sessionManager.getThreadHistory(req.params.id);
  if (!history) {
    return res.status(404).json({ error: 'Thread not found' });
  }
  res.json(history);
});

// API: Workspaces
app.get('/api/workspaces/current', (req, res) => {
  res.json({ workspace: currentWorkspace });
});

app.post('/api/workspaces/select', (req, res) => {
  const { workspace } = req.body;
  if (workspace && fs.existsSync(workspace)) {
    currentWorkspace = workspace;
    res.json({ success: true, workspace: currentWorkspace });
  } else {
    res.status(400).json({ error: 'Invalid directory path' });
  }
});

// WebSocket Chat Streaming
wss.on('connection', (ws) => {
  console.log('Client connected to WebSocket');

  const onEvent = (event) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'codex_event', event }));
    }
  };

  const onStderr = (text) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stderr', text }));
    }
  };

  const onComplete = (data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'complete', data }));
    }
  };

  const onError = (err) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  };

  const onRunStatus = (status) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'run_status', status }));
    }
  };

  codexRunner.on('event', onEvent);
  codexRunner.on('stderr', onStderr);
  codexRunner.on('complete', onComplete);
  codexRunner.on('error', onError);
  codexRunner.on('status', onRunStatus);

  ws.on('message', (msgStr) => {
    try {
      const data = JSON.parse(msgStr);
      if (data.type === 'prompt') {
        const { prompt, model, provider, cwd, threadId, bypassSandbox } = data;
        const targetCwd = cwd || currentWorkspace;

        try {
          const runInfo = codexRunner.run({
            prompt,
            model,
            provider,
            cwd: targetCwd,
            threadId,
            bypassSandbox: bypassSandbox !== false
          });
          ws.send(JSON.stringify({ type: 'started', runInfo }));
        } catch (runErr) {
          ws.send(JSON.stringify({ type: 'error', message: runErr.message }));
        }
      } else if (data.type === 'stop') {
        codexRunner.stop();
        ws.send(JSON.stringify({ type: 'stopped' }));
      }
    } catch (e) {
      console.error('WS message error:', e);
    }
  });

  ws.on('close', () => {
    codexRunner.removeListener('event', onEvent);
    codexRunner.removeListener('stderr', onStderr);
    codexRunner.removeListener('complete', onComplete);
    codexRunner.removeListener('error', onError);
    codexRunner.removeListener('status', onRunStatus);
  });
});

const PORT = process.env.PORT || 3737;

function startServer(cb) {
  if (server.listening) {
    if (cb) cb(PORT);
    return;
  }

  const onError = (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${PORT} is already in use, reusing running instance.`);
      if (cb) cb(PORT);
    } else {
      console.error('Server startup error:', err);
    }
  };

  server.once('error', onError);

  server.listen(PORT, async () => {
    server.removeListener('error', onError);
    console.log(`Codex Custom Studio server running at http://localhost:${PORT}`);
    // Fresh-computer friendly: the Antigravity bridge starts with the app,
    // so its models work without a manual terminal step.
    try {
      const bridge = await bridgeManager.ensureBridge();
      console.log(`Antigravity bridge: ${bridge.running ? 'running' : 'NOT running'}`);
    } catch (err) {
      console.error('Antigravity bridge autostart failed:', err.message);
    }
    if (cb) cb(PORT);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, server, startServer };
