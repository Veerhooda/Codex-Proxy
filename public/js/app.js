/**
 * Codex Custom Studio - Frontend Application Controller
 * Handles live event streaming from Codex CLI, tool execution cards,
 * reasoning blocks, model switcher, and SQLite session history.
 */

// State Management
const state = {
  models: [],
  presets: [],
  activeModel: 'muse-spark-1.3-contributor',
  activeProvider: 'meta',
  currentWorkspace: '',
  activeThreadId: null,
  isGenerating: false,
  ws: null,
  currentAssistantBubble: null,
  lastStderr: '',
  currentReasoningContainer: null,
  currentReasoningContent: null,
  currentText: '',
  currentReasoning: '',
  activeToolCards: new Map(), // call_id -> element
  selectedPreset: null
};

// DOM Elements
const el = {
  // Titlebar
  activeModelTag: document.getElementById('activeModelTag'),
  engineStatusBadge: document.getElementById('engineStatusBadge'),
  topAddModalBtn: document.getElementById('topAddModalBtn'),

  // Sidebar
  newChatBtn: document.getElementById('newChatBtn'),
  workspaceName: document.getElementById('workspaceName'),
  changeWorkspaceBtn: document.getElementById('changeWorkspaceBtn'),
  workspacePill: document.getElementById('workspacePill'),
  sidebarModelId: document.getElementById('sidebarModelId'),
  sidebarProviderBadge: document.getElementById('sidebarProviderBadge'),
  manageModelsBtn: document.getElementById('manageModelsBtn'),
  refreshThreadsBtn: document.getElementById('refreshThreadsBtn'),
  threadsList: document.getElementById('threadsList'),
  openModelModalBtn: document.getElementById('openModelModalBtn'),

  // Main Chat
  sidebarToggleBtn: document.getElementById('sidebarToggleBtn'),
  appContainer: document.getElementById('appContainer'),
  chatThreadTitle: document.getElementById('chatThreadTitle'),
  currentModelDisplay: document.getElementById('currentModelDisplay'),
  clearChatBtn: document.getElementById('clearChatBtn'),
  messagesContainer: document.getElementById('messagesContainer'),
  welcomeHero: document.getElementById('welcomeHero'),
  messagesFeed: document.getElementById('messagesFeed'),

  // Composer
  pluginChipsBar: document.getElementById('pluginChipsBar'),
  promptInput: document.getElementById('promptInput'),
  modelPickerBtn: document.getElementById('modelPickerBtn'),
  pickerModelName: document.getElementById('pickerModelName'),
  modelPickerDropdown: document.getElementById('modelPickerDropdown'),
  pickerModelsList: document.getElementById('pickerModelsList'),
  pickerAddCustomBtn: document.getElementById('pickerAddCustomBtn'),
  stopBtn: document.getElementById('stopBtn'),
  sendBtn: document.getElementById('sendBtn'),

  // Model Modal
  modelModal: document.getElementById('modelModal'),
  closeModalBtn: document.getElementById('closeModalBtn'),
  cancelModalBtn: document.getElementById('cancelModalBtn'),
  presetPills: document.getElementById('presetPills'),
  addModelForm: document.getElementById('addModelForm'),
  providerId: document.getElementById('providerId'),
  providerName: document.getElementById('providerName'),
  providerBaseUrl: document.getElementById('providerBaseUrl'),
  providerApiKey: document.getElementById('providerApiKey'),
  toggleApiKeyBtn: document.getElementById('toggleApiKeyBtn'),
  modelName: document.getElementById('modelName'),
  wireApi: document.getElementById('wireApi'),
  setAsDefaultCheckbox: document.getElementById('setAsDefaultCheckbox'),
  testConnectionBtn: document.getElementById('testConnectionBtn'),
  testFeedback: document.getElementById('testFeedback'),
  saveModelBtn: document.getElementById('saveModelBtn'),

  // Workspace Modal (Web fallback)
  workspaceModal: document.getElementById('workspaceModal'),
  closeWorkspaceModalBtn: document.getElementById('closeWorkspaceModalBtn'),
  customWorkspaceInput: document.getElementById('customWorkspaceInput'),
  cancelWorkspaceBtn: document.getElementById('cancelWorkspaceBtn'),
  saveWorkspaceBtn: document.getElementById('saveWorkspaceBtn')
};

// Initialize Application
async function init() {
  setupEventListeners();
  initWebSocket();
  await loadStatus();
  await loadModels();
  await loadThreads();
  setupTextareaAutoResize();
  await maybeOpenSetupWizard();
}

// Setup Event Listeners
function setupEventListeners() {
  // New Chat
  el.newChatBtn.addEventListener('click', startNewChat);

  // Sidebar collapse
  if (el.sidebarToggleBtn && el.appContainer) {
    el.sidebarToggleBtn.addEventListener('click', () => {
      el.appContainer.classList.toggle('sidebar-collapsed');
    });
  }

  // Clear Chat
  el.clearChatBtn.addEventListener('click', startNewChat);

  // Send / Stop
  el.sendBtn.addEventListener('click', submitPrompt);
  el.stopBtn.addEventListener('click', stopGeneration);

  // Input Keyboard Handling (Enter to submit, Shift+Enter for newline)
  el.promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitPrompt();
    }
  });

  // Starter Cards
  document.querySelectorAll('.suggestion').forEach((card) => {
    card.addEventListener('click', () => {
      const prompt = card.getAttribute('data-prompt');
      el.promptInput.value = prompt;
      el.promptInput.focus();
      submitPrompt();
    });
  });

  // Plugin Quick Mention Chips
  el.pluginChipsBar.addEventListener('click', (e) => {
    const chip = e.target.closest('.mention');
    if (!chip) return;
    const tag = chip.getAttribute('data-tag');
    insertTagIntoInput(tag);
  });

  // Model Picker Dropdown Toggle
  el.modelPickerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    el.modelPickerDropdown.classList.toggle('open');
  });

  document.addEventListener('click', () => {
    el.modelPickerDropdown.classList.remove('open');
  });

  el.modelPickerDropdown.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  el.pickerAddCustomBtn.addEventListener('click', () => {
    el.modelPickerDropdown.classList.remove('open');
    openModelModal();
  });

  // Workspace change (Electron native dialog or modal fallback)
  el.changeWorkspaceBtn.addEventListener('click', changeWorkspace);
  el.workspacePill.addEventListener('click', changeWorkspace);

  // Refresh Threads
  el.refreshThreadsBtn.addEventListener('click', loadThreads);

  // Modals Open / Close
  el.topAddModalBtn.addEventListener('click', () => openModelModal());
  el.manageModelsBtn.addEventListener('click', () => openModelModal());
  el.openModelModalBtn.addEventListener('click', () => openSetupWizard());

  el.closeModalBtn.addEventListener('click', closeModelModal);
  el.cancelModalBtn.addEventListener('click', closeModelModal);

  // API Key Visibility Toggle
  el.toggleApiKeyBtn.addEventListener('click', () => {
    if (el.providerApiKey.type === 'password') {
      el.providerApiKey.type = 'text';
      el.toggleApiKeyBtn.textContent = 'Hide';
    } else {
      el.providerApiKey.type = 'password';
      el.toggleApiKeyBtn.textContent = 'Show';
    }
  });

  // Test Connection
  el.testConnectionBtn.addEventListener('click', testConnection);

  // Save Model
  el.saveModelBtn.addEventListener('click', saveCustomModel);

  // Workspace Modal Handlers
  el.closeWorkspaceModalBtn.addEventListener('click', () => el.workspaceModal.classList.remove('open'));
  el.cancelWorkspaceBtn.addEventListener('click', () => el.workspaceModal.classList.remove('open'));
  el.saveWorkspaceBtn.addEventListener('click', saveCustomWorkspace);

  // Keyboard shortcut: Cmd/Ctrl + N for new chat
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      startNewChat();
    }
  });

  // Escape closes dropdowns and modals
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    el.modelPickerDropdown.classList.remove('open');
    el.modelModal.classList.remove('open');
    el.workspaceModal.classList.remove('open');
  });
}

// Auto-expand textarea
function setupTextareaAutoResize() {
  el.promptInput.addEventListener('input', () => {
    el.promptInput.style.height = 'auto';
    el.promptInput.style.height = Math.min(el.promptInput.scrollHeight, 180) + 'px';
  });
}

function insertTagIntoInput(tag) {
  const input = el.promptInput;
  const val = input.value;
  if (!val.includes(tag)) {
    input.value = tag + ' ' + val;
  }
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// WebSocket Connection
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    console.log('Connected to Codex Studio WebSocket');
    updateEngineStatus('Ready', false);
  };

  state.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (err) {
      console.error('Failed to parse WebSocket message:', err);
    }
  };

  state.ws.onclose = () => {
    console.warn('WebSocket closed, attempting reconnect in 2s...');
    updateEngineStatus('Offline', false);
    setTimeout(initWebSocket, 2000);
  };

  state.ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };
}

// Handle Incoming Server Events
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'started':
      setGeneratingState(true);
      ensureAssistantBubble();
      break;

    case 'stopped':
      setGeneratingState(false);
      finishActiveBubble();
      break;

    case 'complete':
      setGeneratingState(false);
      finishActiveBubble();
      loadThreads();
      break;

    case 'error':
      setGeneratingState(false);
      finishActiveBubble();
      appendSystemError(msg.message || 'Unknown execution error');
      break;

    case 'stderr':
      if (msg.text) {
        state.lastStderr = (state.lastStderr + msg.text).slice(-800);
      }
      break;

    case 'codex_event':
      processCodexEvent(msg.event);
      break;

    case 'run_status':
      updateTurnStatusFromEngine(msg.status);
      break;
  }
}

// Parse Codex CLI JSONL Events (both live items and streaming deltas)
function processCodexEvent(event) {
  if (!event) return;

  // 1. Thread Started
  if (event.type === 'thread.started' && event.thread_id) {
    state.activeThreadId = event.thread_id;
    if (el.chatThreadTitle.textContent === 'New chat') {
      el.chatThreadTitle.textContent = `Chat ${event.thread_id.slice(0, 8)}`;
    }
    return;
  }

  // 2. Turn Started
  if (event.type === 'turn.started') {
    ensureAssistantBubble();
    scrollToBottom();
    return;
  }

  // 3. Item Started (Tool Call or Shell Command in progress)
  if (event.type === 'item.started' && event.item) {
    ensureAssistantBubble();
    const item = event.item;
    if (item.type === 'command_execution') {
      createToolCallCard({
        call_id: item.id,
        name: 'exec_command',
        arguments: item.command
      });
    } else if (item.type === 'McpToolCall') {
      createToolCallCard({
        call_id: item.id,
        name: `${item.server || 'mcp'}:${item.tool || 'action'}`,
        arguments: item.arguments
      });
    }
    scrollToBottom();
    return;
  }

  // 4. Item Completed (Agent Message, Command Finished, Mcp Tool Finished, Reasoning)
  if (event.type === 'item.completed' && event.item) {
    ensureAssistantBubble();
    const item = event.item;

    // A. Agent Message
    if (item.type === 'agent_message' || item.type === 'AgentMessage') {
      const text = item.text || (item.content && item.content[0] && item.content[0].text) || '';
      if (text) {
        if (state.currentText) {
          state.currentText += '\n\n' + text;
        } else {
          state.currentText = text;
        }
        renderAssistantMarkdown();
      }
    }

    // B. Command Execution Output
    else if (item.type === 'command_execution') {
      updateToolCallCardOutput({
        call_id: item.id,
        output: item.aggregated_output || (item.exit_code !== null ? `Completed with exit code ${item.exit_code}` : 'Done')
      });
    }

    // C. Mcp Tool Call Output (@computer, @chrome, etc.)
    else if (item.type === 'McpToolCall') {
      let outputText = '';
      if (item.result?.content && Array.isArray(item.result.content)) {
        outputText = item.result.content.map(c => c.text || JSON.stringify(c)).join('\n');
      } else if (item.result) {
        outputText = typeof item.result === 'object' ? JSON.stringify(item.result, null, 2) : String(item.result);
      }
      updateToolCallCardOutput({
        call_id: item.id,
        output: outputText
      });
    }

    // D. Reasoning Item
    else if (item.type === 'Reasoning' || item.type === 'reasoning') {
      const rText = (item.summary_text && item.summary_text.join('\n')) || (item.raw_content && item.raw_content.join('\n')) || '';
      if (rText) {
        ensureReasoningContainer();
        state.currentReasoning += (state.currentReasoning ? '\n' : '') + rText;
        state.currentReasoningContent.textContent = state.currentReasoning;
      }
    }

    scrollToBottom();
    return;
  }

  // 5. Turn Completed (Usage & stats)
  if (event.type === 'turn.completed' && event.usage) {
    appendTurnUsageBadge(event.usage);
    scrollToBottom();
    return;
  }

  // 6. Direct Streaming Deltas (if supported by wire protocol)
  if (event.type === 'text_delta') {
    ensureAssistantBubble();
    state.currentText += event.delta;
    renderAssistantMarkdown();
    scrollToBottom();
  } else if (event.type === 'reasoning_delta') {
    ensureAssistantBubble();
    ensureReasoningContainer();
    state.currentReasoning += event.delta;
    state.currentReasoningContent.textContent = state.currentReasoning;
    scrollToBottom();
  } else if (event.type === 'function_call') {
    ensureAssistantBubble();
    createToolCallCard(event);
    scrollToBottom();
  } else if (event.type === 'function_call_output') {
    updateToolCallCardOutput(event);
    scrollToBottom();
  }
}

// Ensure Assistant Bubble exists
function ensureAssistantBubble() {
  el.welcomeHero.style.display = 'none';

  if (!state.currentAssistantBubble) {
    const item = document.createElement('div');
    item.className = 'message-item assistant';

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';

    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'message-body-wrap';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.innerHTML = '<span class="status-dot"></span> <em>Working…</em>';

    bodyWrap.appendChild(bubble);
    item.appendChild(avatar);
    item.appendChild(bodyWrap);

    el.messagesFeed.appendChild(item);

    state.currentAssistantBubble = bubble;
    state.currentText = '';
    state.currentReasoning = '';
    state.currentReasoningContainer = null;
    state.currentReasoningContent = null;
  }
}

// Ensure Reasoning Container inside Assistant Bubble
function ensureReasoningContainer() {
  if (!state.currentReasoningContainer && state.currentAssistantBubble) {
    const container = document.createElement('div');
    container.className = 'reasoning-accordion';

    const header = document.createElement('div');
    header.className = 'reasoning-header';
    header.innerHTML = `
      <span class="reasoning-title">Reasoning</span>
      <span class="reasoning-arrow">▾</span>
    `;

    header.addEventListener('click', () => {
      container.classList.toggle('collapsed');
    });

    const content = document.createElement('div');
    content.className = 'reasoning-content';

    container.appendChild(header);
    container.appendChild(content);

    const bodyWrap = state.currentAssistantBubble.parentElement;
    bodyWrap.insertBefore(container, state.currentAssistantBubble);

    state.currentReasoningContainer = container;
    state.currentReasoningContent = content;
  }
}

// Render Assistant Markdown
function renderAssistantMarkdown() {
  if (!state.currentAssistantBubble) return;

  let rawHtml = '';
  if (window.marked && typeof window.marked.parse === 'function') {
    rawHtml = window.marked.parse(state.currentText);
  } else {
    rawHtml = escapeHtml(state.currentText).replace(/\n/g, '<br>');
  }

  state.currentAssistantBubble.innerHTML = rawHtml + (state.isGenerating ? '<span class="streaming-cursor"></span>' : '');
  attachCodeCopyButtons(state.currentAssistantBubble);
}

// Create Tool Execution Card
function createToolCallCard(event) {
  const callId = event.call_id || event.id || `tool_${Date.now()}`;
  if (state.activeToolCards.has(callId)) return;

  const toolName = event.name || event.tool || 'exec_command';
  const args = typeof event.arguments === 'object' ? JSON.stringify(event.arguments, null, 2) : String(event.arguments || '');

  const card = document.createElement('div');
  card.className = 'tool-call-card';
  card.id = `tool_card_${callId}`;

  let displayTool = toolName;
  if (toolName === 'exec_command') displayTool = 'Terminal';
  else if (toolName.includes('cua_repl') || toolName.includes('computer')) displayTool = 'Computer use';
  else if (toolName.includes('chrome')) displayTool = 'Chrome';
  else if (toolName.includes('browser') || toolName.includes('fetch')) displayTool = 'Web fetch';

  card.innerHTML = `
    <div class="tool-header">
      <div class="tool-badge">
        <span>${displayTool}</span>
      </div>
      <div class="tool-status running">
        <span class="status-dot"></span> Running
      </div>
    </div>
    <div class="tool-body">
      <div class="tool-command-preview">${escapeHtml(args.slice(0, 400))}</div>
      <div class="tool-output-area" style="display: none;"></div>
    </div>
  `;

  if (state.currentAssistantBubble) {
    const bodyWrap = state.currentAssistantBubble.parentElement;
    bodyWrap.insertBefore(card, state.currentAssistantBubble);
  } else {
    el.messagesFeed.appendChild(card);
  }

  state.activeToolCards.set(callId, card);
}

// Update Tool Card Output
function updateToolCallCardOutput(event) {
  const callId = event.call_id || event.id;
  const card = state.activeToolCards.get(callId) || document.querySelector('.tool-call-card:last-of-type');
  if (!card) return;

  const statusEl = card.querySelector('.tool-status');
  if (statusEl) {
    statusEl.className = 'tool-status completed';
    statusEl.innerHTML = '<span class="status-dot"></span> Done';
  }

  const outputEl = card.querySelector('.tool-output-area');
  if (outputEl) {
    let outputText = '';
    if (typeof event.output === 'object') {
      outputText = JSON.stringify(event.output, null, 2);
    } else {
      outputText = String(event.output || '');
    }

    if (outputText.trim()) {
      outputEl.style.display = 'block';
      outputEl.textContent = outputText.slice(0, 4000);
    }
  }
}

// Append token usage badge at bottom of turn
function appendTurnUsageBadge(usage) {
  if (!state.currentAssistantBubble) return;
  const existingBadge = state.currentAssistantBubble.parentElement.querySelector('.turn-usage-badge');
  if (existingBadge) return;

  const badge = document.createElement('div');
  badge.className = 'credit-bypass-indicator';
  badge.style.marginTop = '8px';
  badge.style.alignSelf = 'flex-start';
  const outToks = usage.output_tokens || 0;
  const inToks = usage.input_tokens || 0;
  badge.textContent = `${inToks} in · ${outToks} out tokens`;

  state.currentAssistantBubble.parentElement.appendChild(badge);
}

// Finish Active Streaming Bubble
function finishActiveBubble() {
  if (state.currentAssistantBubble) {
    const cursor = state.currentAssistantBubble.querySelector('.streaming-cursor');
    if (cursor) cursor.remove();

    if (!state.currentText && !state.currentReasoning && state.activeToolCards.size === 0) {
      if (state.lastStderr.trim()) {
        const errBox = document.createElement('div');
        errBox.className = 'run-error';
        errBox.innerHTML = '<em>No reply received. The run reported:</em>';
        const pre = document.createElement('pre');
        pre.textContent = state.lastStderr.trim().slice(-500);
        errBox.appendChild(pre);
        state.currentAssistantBubble.innerHTML = '';
        state.currentAssistantBubble.appendChild(errBox);
      } else {
        state.currentAssistantBubble.innerHTML = '<em>No reply received.</em>';
      }
    }

    state.currentAssistantBubble = null;
    state.currentReasoningContainer = null;
    state.currentReasoningContent = null;
    state.currentText = '';
    state.currentReasoning = '';
    state.activeToolCards.clear();
  }
}

// Submit Prompt
function submitPrompt() {
  const text = el.promptInput.value.trim();
  if (!text || state.isGenerating) return;

  // Append User message to UI
  el.welcomeHero.style.display = 'none';
  appendUserMessage(text);

  // Clear input
  el.promptInput.value = '';
  el.promptInput.style.height = 'auto';
  state.lastStderr = '';

  // Send via WebSocket
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    setGeneratingState(true);
    ensureAssistantBubble();
    state.ws.send(JSON.stringify({
      type: 'prompt',
      prompt: text,
      model: state.activeModel,
      provider: state.activeProvider,
      cwd: state.currentWorkspace,
      threadId: state.activeThreadId,
      bypassSandbox: true
    }));
  } else {
    appendSystemError('WebSocket connection is offline. Reconnecting...');
    initWebSocket();
  }
}

// Stop Prompt Generation
function stopGeneration() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'stop' }));
  }
}

// Append User Message Bubble
function appendUserMessage(text) {
  const item = document.createElement('div');
  item.className = 'message-item user';

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'message-body-wrap';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = text;

  bodyWrap.appendChild(bubble);
  item.appendChild(avatar);
  item.appendChild(bodyWrap);

  el.messagesFeed.appendChild(item);
  scrollToBottom();
}

// Append System Error
function appendSystemError(errText) {
  const errDiv = document.createElement('div');
  errDiv.className = 'test-feedback error';
  errDiv.style.margin = '10px 0';
  errDiv.textContent = `Error: ${errText}`;
  el.messagesFeed.appendChild(errDiv);
  scrollToBottom();
}

// Set Generating State
function setGeneratingState(generating) {
  state.isGenerating = generating;
  if (generating) {
    el.sendBtn.classList.add('hidden');
    el.stopBtn.classList.remove('hidden');
    updateEngineStatus('Running', true);
  } else {
    el.sendBtn.classList.remove('hidden');
    el.stopBtn.classList.add('hidden');
    updateEngineStatus('Ready', false);
  }
}

// Update Status Badge
function updateEngineStatus(text, isRunning) {
  el.engineStatusBadge.className = `engine-state${isRunning ? ' running' : ''}`;
  el.engineStatusBadge.innerHTML = `<span class="status-dot"></span>${text}`;
}

// New Chat
function startNewChat() {
  if (state.isGenerating) stopGeneration();
  finishActiveBubble();
  state.activeThreadId = null;
  el.messagesFeed.innerHTML = '';
  el.welcomeHero.style.display = 'flex';
  el.chatThreadTitle.textContent = 'New chat';
}

// Load App Status
async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    state.currentWorkspace = data.currentWorkspace;
    el.workspaceName.textContent = getFolderBasename(data.currentWorkspace);
    el.workspacePill.title = data.currentWorkspace;

    if (data.activeModel) {
      state.activeModel = data.activeModel;
      state.activeProvider = data.activeProvider;
      updateActiveModelUI(data.activeModel, data.activeProvider);
    }
  } catch (err) {
    console.error('Failed to load status:', err);
  }
}

// Load Models & Presets
async function loadModels() {
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    state.models = data.configured || [];
    state.presets = data.presets || [];

    renderModelPickerList(data.configured);
    renderPresetPills(data.presets);
  } catch (err) {
    console.error('Failed to load models:', err);
  }
}

// Update Active Model UI
function updateActiveModelUI(modelId, provider) {
  state.activeModel = modelId;
  state.activeProvider = provider;

  el.activeModelTag.textContent = modelId;
  el.sidebarModelId.textContent = modelId;
  el.sidebarProviderBadge.textContent = provider || 'Default';
  el.pickerModelName.textContent = modelId;
  el.currentModelDisplay.textContent = modelId;
}

// Render Model Picker Dropdown: every known model across all presets,
// annotated with provider setup state.
function renderModelPickerList(configured) {
  el.pickerModelsList.innerHTML = '';
  const byId = new Map((configured || []).map((p) => [p.id, p]));

  (state.presets || []).forEach((preset) => {
    (preset.defaultModels || []).forEach((modelId) => {
      const conf = byId.get(preset.id);
      const item = document.createElement('div');
      const isActive = state.activeModel === modelId && state.activeProvider === preset.id;
      item.className = `picker-option${isActive ? ' active' : ''}`;
      const status = conf ? (conf.has_key ? 'key saved' : 'no key') : 'not set up';
      item.innerHTML = `
        <span class="picker-opt-name">${escapeHtml(modelId)}</span>
        <span class="picker-opt-provider">${escapeHtml(preset.name)} · ${status}</span>
      `;

      item.addEventListener('click', async () => {
        await selectPickerModel(preset, modelId, conf);
        el.modelPickerDropdown.classList.remove('open');
      });

      el.pickerModelsList.appendChild(item);
    });
  });
}

// Activate a model, registering its provider section first when missing so
// the choice also exists for the codex engine in config.toml.
async function selectPickerModel(preset, modelId, conf) {
  try {
    if (!conf) {
      const res = await fetch('/api/models/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: preset.id,
          name: preset.name,
          baseUrl: preset.baseUrl,
          wireApi: preset.wireApi || 'responses',
          modelName: modelId,
          isDefault: true
        })
      });
      const result = await res.json();
      if (result.success) {
        updateActiveModelUI(modelId, preset.id);
        await loadModels();
      }
    } else {
      await setDefaultModel(modelId, preset.id);
    }
  } catch (err) {
    console.error('Failed to select model:', err);
  }
}

// Set Active Default Model
async function setDefaultModel(model, provider) {
  try {
    const res = await fetch('/api/models/set-default', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, provider })
    });
    const result = await res.json();
    if (result.success) {
      updateActiveModelUI(model, provider);
      await loadModels();
    }
  } catch (err) {
    console.error('Failed to set default model:', err);
  }
}

// Render Presets in Modal
function renderPresetPills(presets) {
  el.presetPills.innerHTML = '';
  presets.forEach((preset, index) => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = `preset-pill ${index === 0 ? 'active' : ''}`;
    pill.textContent = preset.name;

    pill.addEventListener('click', () => {
      document.querySelectorAll('.preset-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      selectPreset(preset);
    });

    el.presetPills.appendChild(pill);
  });

  if (presets.length > 0) {
    selectPreset(presets[0]);
  }
}

// Select Preset in Modal
function selectPreset(preset) {
  state.selectedPreset = preset;
  el.providerId.value = preset.id;
  el.providerName.value = preset.name;
  el.providerBaseUrl.value = preset.baseUrl;
  el.wireApi.value = preset.wireApi || 'responses';

  if (preset.defaultModels && preset.defaultModels.length > 0) {
    el.modelName.value = preset.defaultModels[0];
  }

  // Keys are per-provider and never echoed: always start empty so one
  // provider's key can never appear under another preset.
  el.providerApiKey.value = '';
  const existing = (state.models || []).find((m) => m.id === preset.id);
  el.providerApiKey.placeholder = existing && existing.has_key
    ? 'Key saved — leave blank to keep it'
    : 'Stored in ~/.codex/.env';

  el.testFeedback.className = 'test-feedback';
  el.testFeedback.style.display = 'none';
}

// Test Provider Connection
async function testConnection() {
  const baseUrl = el.providerBaseUrl.value.trim();
  const apiKey = el.providerApiKey.value.trim();

  if (!baseUrl) {
    el.testFeedback.className = 'test-feedback error';
    el.testFeedback.textContent = 'Please enter an API Base URL';
    return;
  }

  el.testFeedback.className = 'test-feedback';
  el.testFeedback.style.display = 'block';
  el.testFeedback.textContent = 'Connecting to endpoint...';

  try {
    const res = await fetch('/api/models/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey })
    });
    const data = await res.json();

    if (data.success) {
      el.testFeedback.className = 'test-feedback success';
      let msg = `Connected (${data.latency}ms, HTTP ${data.status})`;
      if (data.models && data.models.length > 0) {
        msg += ` — ${data.models.length} models found, e.g. ${data.models.slice(0, 3).join(', ')}`;
      }
      el.testFeedback.textContent = msg;
    } else {
      el.testFeedback.className = 'test-feedback error';
      el.testFeedback.textContent = `Connection failed: ${data.error || 'HTTP ' + data.status + ' ' + (data.statusText || '')}`;
    }
  } catch (err) {
    el.testFeedback.className = 'test-feedback error';
    el.testFeedback.textContent = `Connection error: ${err.message}`;
  }
}

// Save Custom Model
async function saveCustomModel() {
  const id = el.providerId.value.trim();
  const name = el.providerName.value.trim() || id;
  const baseUrl = el.providerBaseUrl.value.trim();
  const apiKey = el.providerApiKey.value.trim();
  const modelName = el.modelName.value.trim();
  const wireApi = el.wireApi.value;
  const isDefault = el.setAsDefaultCheckbox.checked;

  if (!id || !baseUrl || !modelName) {
    el.testFeedback.className = 'test-feedback error';
    el.testFeedback.textContent = 'Provider ID, Base URL, and Model Name are required.';
    return;
  }

  try {
    const res = await fetch('/api/models/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        name,
        baseUrl,
        apiKey,
        modelName,
        wireApi,
        isDefault
      })
    });
    const result = await res.json();

    if (result.success) {
      closeModelModal();
      await loadModels();
      if (isDefault) {
        updateActiveModelUI(modelName, id);
      }
    } else {
      el.testFeedback.className = 'test-feedback error';
      el.testFeedback.textContent = result.error || 'Failed to save model';
    }
  } catch (err) {
    el.testFeedback.className = 'test-feedback error';
    el.testFeedback.textContent = err.message;
  }
}

// Modal controls
function openModelModal() {
  if (state.selectedPreset) {
    document.querySelectorAll('.preset-pill').forEach((p) => {
      p.classList.toggle('active', p.textContent === state.selectedPreset.name);
    });
    selectPreset(state.selectedPreset);
  }
  el.modelModal.classList.add('open');
}

function closeModelModal() {
  el.modelModal.classList.remove('open');
}

// Workspace Management
async function changeWorkspace() {
  if (window.codexNative && window.codexNative.openFolderPicker) {
    try {
      const selected = await window.codexNative.openFolderPicker();
      if (selected) {
        await updateWorkspaceOnServer(selected);
      }
    } catch (err) {
      console.error('Electron folder picker error:', err);
    }
  } else {
    el.customWorkspaceInput.value = state.currentWorkspace;
    el.workspaceModal.classList.add('open');
  }
}

async function saveCustomWorkspace() {
  const pathVal = el.customWorkspaceInput.value.trim();
  if (pathVal) {
    await updateWorkspaceOnServer(pathVal);
    el.workspaceModal.classList.remove('open');
  }
}

async function updateWorkspaceOnServer(workspacePath) {
  try {
    const res = await fetch('/api/workspaces/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: workspacePath })
    });
    const data = await res.json();
    if (data.success) {
      state.currentWorkspace = data.workspace;
      el.workspaceName.textContent = getFolderBasename(data.workspace);
      el.workspacePill.title = data.workspace;
    }
  } catch (err) {
    console.error('Failed to update workspace:', err);
  }
}

// Load Threads from SQLite
async function loadThreads() {
  try {
    const res = await fetch('/api/threads?limit=30');
    const data = await res.json();
    renderThreadsList(data.threads || []);
  } catch (err) {
    console.error('Failed to load threads:', err);
  }
}

function renderThreadsList(threads) {
  el.threadsList.innerHTML = '';
  if (threads.length === 0) {
    el.threadsList.innerHTML = '<div class="threads-empty">No recent chats</div>';
    return;
  }

  threads.forEach((t) => {
    const item = document.createElement('div');
    item.className = `thread-item ${state.activeThreadId === t.id ? 'active' : ''}`;
    const dateFormatted = formatThreadDate(t.updated_at || t.created_at);

    item.innerHTML = `
      <span class="thread-title">${escapeHtml(t.title || 'Untitled Session')}</span>
      <span class="thread-meta">${dateFormatted} · ${escapeHtml(t.model || 'codex')}</span>
    `;

    item.addEventListener('click', () => loadThreadHistory(t.id, t.title));
    el.threadsList.appendChild(item);
  });
}

function formatThreadDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    return dateStr.slice(0, 16);
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Load Past Thread History
async function loadThreadHistory(threadId, title) {
  if (state.isGenerating) stopGeneration();
  finishActiveBubble();

  state.activeThreadId = threadId;
  el.chatThreadTitle.textContent = title || `Chat ${threadId.slice(0, 8)}`;
  el.welcomeHero.style.display = 'none';
  el.messagesFeed.innerHTML = '<div class="threads-loading">Loading…</div>';

  try {
    const res = await fetch(`/api/threads/${threadId}`);
    const data = await res.json();
    el.messagesFeed.innerHTML = '';

    if (data.messages && Array.isArray(data.messages) && data.messages.length > 0) {
      data.messages.forEach((msg) => {
        if (msg.role === 'user') {
          appendUserMessage(msg.content);
        } else {
          ensureAssistantBubble();
          state.currentText = msg.content;
          renderAssistantMarkdown();
          finishActiveBubble();
        }
      });
    } else {
      el.messagesFeed.innerHTML = '<div class="threads-empty">No messages in this thread.</div>';
    }

    // Highlight active thread in sidebar
    document.querySelectorAll('.thread-item').forEach(item => item.classList.remove('active'));
    const clickedItem = Array.from(document.querySelectorAll('.thread-item')).find(item => item.textContent.includes(title));
    if (clickedItem) clickedItem.classList.add('active');

    scrollToBottom();
  } catch (err) {
    el.messagesFeed.innerHTML = `<div class="test-feedback error">Failed to load thread history: ${err.message}</div>`;
  }
}

// Helper: Attach Copy buttons to code blocks
function attachCodeCopyButtons(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.previousElementSibling && pre.previousElementSibling.classList.contains('code-block-header')) return;

    const code = pre.querySelector('code');
    const lang = code && code.className ? code.className.replace('language-', '') : 'code';

    const header = document.createElement('div');
    header.className = 'code-block-header';
    header.innerHTML = `
      <span>${lang}</span>
      <button class="btn-copy-code" type="button">Copy</button>
    `;

    const copyBtn = header.querySelector('.btn-copy-code');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(code ? code.innerText : pre.innerText).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
    });

    pre.parentElement.insertBefore(header, pre);
  });
}

// Helper: Scroll feed to bottom
function scrollToBottom() {
  el.messagesContainer.scrollTop = el.messagesContainer.scrollHeight;
}

// Helper: Extract folder basename
function getFolderBasename(fullPath) {
  if (!fullPath) return 'Workspace';
  const parts = fullPath.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || fullPath;
}

// Helper: HTML escape
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ---------------------------------------------------------------------------
// Turn status timeline: shows exactly what the engine is doing while a turn
// runs (provider phases, elapsed time), so "Working…" is never a black box.
// ---------------------------------------------------------------------------

const PHASE_LABELS = {
  received: 'Request received',
  refreshing: 'Refreshing Google sign-in',
  contacting: 'Contacting Google',
  streaming: 'Streaming reply',
  retrying: 'Retrying',
  done: 'Done',
  error: 'Provider error',
  unreachable: 'Bridge unreachable',
  external: 'Running on external provider'
};

function ensureTurnStatusLine() {
  if (!state.currentAssistantBubble) return;
  const bodyWrap = state.currentAssistantBubble.parentElement;
  let line = bodyWrap.querySelector('.turn-status');
  if (!line) {
    line = document.createElement('div');
    line.className = 'turn-status is-active';
    line.innerHTML = '<span class="status-dot"></span><span class="turn-status-text">Starting…</span><span class="turn-status-time"></span>';
    bodyWrap.insertBefore(line, state.currentAssistantBubble);
    state.statusLine = line;
  }
  state.turnStartedAt = state.turnStartedAt || Date.now();
  startTurnClock();
}

function startTurnClock() {
  stopTurnClock();
  const tick = () => {
    if (!state.statusLine) return;
    const t = state.turnStartedAt ? Math.floor((Date.now() - state.turnStartedAt) / 1000) : 0;
    const timeEl = state.statusLine.querySelector('.turn-status-time');
    if (timeEl) timeEl.textContent = t > 0 ? `${t}s` : '';
  };
  tick();
  state.statusTimer = setInterval(tick, 1000);
  startProviderPoll();
}

function stopTurnClock() {
  if (state.statusTimer) { clearInterval(state.statusTimer); state.statusTimer = null; }
  stopProviderPoll();
}

function setTurnStatus(label, done) {
  if (!state.statusLine) return;
  const textEl = state.statusLine.querySelector('.turn-status-text');
  if (textEl) textEl.textContent = label;
  state.statusLine.classList.toggle('is-active', !done);
  state.statusLine.classList.toggle('is-done', Boolean(done));
  updateEngineStatus(done ? 'Ready' : label, !done);
}

function updateTurnStatusFromEngine(status) {
  if (!status || !state.isGenerating) return;
  if (status.state === 'starting') {
    state.turnStartedAt = Date.now();
    ensureTurnStatusLine();
    setTurnStatus('Starting engine…', false);
  }
}

async function pollProviderStatus() {
  if (!state.isGenerating || !state.statusLine) return;
  try {
    const res = await fetch('/api/provider-status');
    const data = await res.json();
    if (!state.isGenerating || !state.statusLine) return;
    const label = PHASE_LABELS[data.phase] || data.phase || 'Working…';
    let text = label;
    if (data.detail) text += ` — ${data.detail}`;
    if (data.phase === 'streaming' && data.chars) text += ` (${formatChars(data.chars)})`;
    if (data.phase === 'error' && data.last_error) text += `: ${String(data.last_error).slice(0, 160)}`;
    setTurnStatus(text, false);
  } catch (err) { /* keep last status on poll failure */ }
}

function startProviderPoll() {
  stopProviderPoll();
  state.providerPoll = setInterval(pollProviderStatus, 2000);
}

function stopProviderPoll() {
  if (state.providerPoll) { clearInterval(state.providerPoll); state.providerPoll = null; }
}

function formatChars(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k chars`;
  return `${n} chars`;
}

// Hook the timeline into turn start/finish.
const _ensureAssistantBubble = ensureAssistantBubble;
ensureAssistantBubble = function () {
  _ensureAssistantBubble();
  if (state.isGenerating) {
    state.turnStartedAt = state.turnStartedAt || Date.now();
    ensureTurnStatusLine();
  }
};

const _finishActiveBubble = finishActiveBubble;
finishActiveBubble = function () {
  if (state.statusLine) {
    const secs = state.turnStartedAt ? Math.round((Date.now() - state.turnStartedAt) / 1000) : 0;
    setTurnStatus(secs > 0 ? `Finished in ${secs}s` : 'Finished', true);
    state.statusLine = null;
  }
  state.turnStartedAt = null;
  stopTurnClock();
  _finishActiveBubble();
};

// ---------------------------------------------------------------------------
// First-run setup wizard: fresh-computer onboarding (DMG-friendly).
// Opens automatically when no provider keys and no Antigravity accounts exist.
// ---------------------------------------------------------------------------

const wizard = { step: 0, setup: null, oauthTimer: null };

async function maybeOpenSetupWizard() {
  try {
    const res = await fetch('/api/setup/status');
    wizard.setup = await res.json();
    if (wizard.setup.needsSetup) openSetupWizard();
  } catch (err) {
    console.error('Setup status failed:', err);
  }
}

function openSetupWizard() {
  refreshSetupState().then(() => {
    wizard.step = 0;
    renderWizard();
    document.getElementById('setupWizard').classList.add('open');
  });
}

function closeSetupWizard() {
  document.getElementById('setupWizard').classList.remove('open');
  if (wizard.oauthTimer) { clearInterval(wizard.oauthTimer); wizard.oauthTimer = null; }
}

async function refreshSetupState() {
  const res = await fetch('/api/setup/status');
  wizard.setup = await res.json();
  await loadModels();
}

const WIZARD_STEPS = ['Welcome', 'Antigravity', 'API keys', 'Default model'];

function renderWizard() {
  const stepsEl = document.getElementById('wizardSteps');
  stepsEl.innerHTML = WIZARD_STEPS.map((s, i) =>
    `<span class="wizard-step${i === wizard.step ? ' active' : ''}${i < wizard.step ? ' done' : ''}>${escapeHtml(s)}</span>`
  ).join('');
  const body = document.getElementById('wizardBody');
  const footer = document.getElementById('wizardFooter');
  body.innerHTML = '';
  footer.innerHTML = '';
  [renderWizardWelcome, renderWizardAntigravity, renderWizardKeys, renderWizardModel][wizard.step](body, footer);
}

function wizardButton(footer, label, primary, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = primary ? 'btn-primary' : 'btn-ghost';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  footer.appendChild(btn);
  return btn;
}

function renderWizardWelcome(body, footer) {
  document.getElementById('wizardTitle').textContent = 'Set up Codex Studio';
  document.getElementById('wizardSubtitle').textContent = 'Connect your models. This only takes a minute.';
  const hasAny = wizard.setup && (wizard.setup.antigravity.accounts.length > 0 ||
    wizard.setup.keyProviders.some((p) => p.has_key));
  body.innerHTML = `
    <p class="wizard-text">Codex Studio runs models from Google (via Antigravity) or any API-key
    provider. Your credentials stay on this machine: API keys in
    <code>~/.codex/.env</code>, Google sign-in in <code>~/.codex/antigravity_accounts.json</code>.</p>
    ${hasAny ? '<p class="wizard-text wizard-ok">This machine already has models set up — you can review or add more.</p>' : ''}`;
  wizardButton(footer, 'Continue', true, () => { wizard.step = 1; renderWizard(); });
}

function renderWizardAntigravity(body, footer) {
  document.getElementById('wizardTitle').textContent = 'Antigravity (Google models)';
  document.getElementById('wizardSubtitle').textContent = 'Sign in with Google once — sign-in refreshes itself.';
  const accounts = wizard.setup.antigravity.accounts;
  body.innerHTML = `
    <div class="wizard-accounts" id="wizardAccounts">
      ${accounts.length === 0 ? '<p class="wizard-text">No Google account connected yet.</p>' :
        accounts.map((a) => `
          <div class="wizard-account" style="display:flex; justify-content:space-between; align-items:center;">
            <span>${escapeHtml(a.email)}</span>
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="wizard-connected">connected</span>
              <button type="button" class="btn-ghost" data-remove-email="${escapeHtml(a.email)}" style="font-size:11px; padding:2px 6px;">Remove</button>
            </div>
          </div>
        `).join('')}
    </div>
    <div class="wizard-oauth-row">
      <button type="button" class="btn-primary" id="wizardGoogleBtn">Connect Google account</button>
    </div>
    <p class="wizard-note" id="wizardOAuthNote"></p>
    <div id="manualCodeSection" class="hidden" style="margin-top: 14px; text-align: left; padding: 12px; background: var(--bg-hover); border-radius: 8px; border: 1px solid var(--line);">
      <p style="font-size: 12px; color: var(--text-color); margin-bottom: 6px; font-weight: 500;">
        Signed in in your browser?
      </p>
      <p style="font-size: 11.5px; color: var(--muted); margin-bottom: 8px; line-height: 1.4;">
        If your browser did not redirect back automatically, copy the full URL from the browser address bar (or the authorization code) and paste it below:
      </p>
      <div style="display: flex; gap: 8px;">
        <input type="text" id="manualAuthCodeInput" class="form-input" style="font-size: 12px; padding: 6px 10px; flex: 1;" placeholder="http://localhost:51121/oauth-callback?code=... or 4/0xxx...">
        <button type="button" class="btn-secondary" id="submitManualCodeBtn" style="white-space: nowrap; font-size: 12px;">Submit Code</button>
      </div>
      <p id="manualCodeFeedback" style="font-size: 11.5px; margin-top: 6px; margin-bottom: 0;"></p>
    </div>`;

  body.querySelector('#wizardGoogleBtn').addEventListener('click', startGoogleOAuth);

  body.querySelectorAll('[data-remove-email]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const email = e.currentTarget.getAttribute('data-remove-email');
      if (!confirm(`Disconnect Google account ${email}?`)) return;
      await fetch('/api/antigravity/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      await refreshSetupState();
      renderWizard();
    });
  });

  wizardButton(footer, 'Back', false, () => { wizard.step = 0; renderWizard(); });
  wizardButton(footer, 'Continue', true, () => { wizard.step = 2; renderWizard(); });
}

async function startGoogleOAuth() {
  const note = document.getElementById('wizardOAuthNote');
  const manualSec = document.getElementById('manualCodeSection');
  const manualInput = document.getElementById('manualAuthCodeInput');
  const manualSubmit = document.getElementById('submitManualCodeBtn');
  const manualFb = document.getElementById('manualCodeFeedback');

  try {
    const res = await fetch('/api/antigravity/auth-url', { method: 'POST' });
    const { url, sessionId } = await res.json();
    window.open(url, '_blank');
    note.textContent = 'Google sign-in opened in your browser. Complete sign-in there…';
    if (manualSec) manualSec.classList.remove('hidden');

    if (manualSubmit) {
      manualSubmit.onclick = async () => {
        const val = manualInput.value.trim();
        if (!val) return;
        manualFb.textContent = 'Submitting code…';
        manualFb.style.color = 'var(--muted)';
        try {
          const resp = await fetch('/api/antigravity/submit-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, input: val })
          });
          const data = await resp.json();
          if (data.status === 'done') {
            if (wizard.oauthTimer) clearInterval(wizard.oauthTimer);
            manualFb.textContent = `Connected as ${data.account.email}!`;
            manualFb.style.color = 'var(--accent-color, #10a37f)';
            note.textContent = `Connected as ${data.account.email}.`;
            await refreshSetupState();
            setTimeout(() => renderWizard(), 800);
          } else {
            manualFb.textContent = `Sign-in failed: ${data.error || 'Invalid code'}`;
            manualFb.style.color = '#ef4444';
          }
        } catch (err) {
          manualFb.textContent = `Error: ${err.message}`;
          manualFb.style.color = '#ef4444';
        }
      };
    }

    if (wizard.oauthTimer) clearInterval(wizard.oauthTimer);
    wizard.oauthTimer = setInterval(async () => {
      try {
        const r = await fetch(`/api/antigravity/flow/${sessionId}`);
        const flow = await r.json();
        if (flow.status === 'done') {
          clearInterval(wizard.oauthTimer);
          note.textContent = `Connected as ${flow.account.email}.`;
          await refreshSetupState();
          renderWizard();
        } else if (flow.status === 'error') {
          clearInterval(wizard.oauthTimer);
          note.textContent = `Sign-in failed: ${flow.error}`;
        }
      } catch (err) { /* keep polling */ }
    }, 2000);
  } catch (err) {
    note.textContent = `Could not start sign-in: ${err.message}`;
  }
}

const KEY_PROVIDERS = [
  { id: 'openrouter', label: 'OpenRouter', hint: 'sk-or-v1-… · 200+ models' },
  { id: 'groq', label: 'Groq', hint: 'gsk_… · ultra-low latency' },
  { id: 'deepseek', label: 'DeepSeek', hint: 'sk-… · direct API' },
  { id: 'meta', label: 'Meta / Muse Spark', hint: 'local bridge key' }
];

function renderWizardKeys(body, footer) {
  document.getElementById('wizardTitle').textContent = 'API keys';
  document.getElementById('wizardSubtitle').textContent = 'Optional — add any you have. Stored in ~/.codex/.env.';
  const saved = new Map(wizard.setup.keyProviders.map((p) => [p.id, p.has_key]));
  body.innerHTML = KEY_PROVIDERS.map((p) => `
    <div class="wizard-key-row">
      <div class="wizard-key-meta">
        <span class="wizard-key-label">${escapeHtml(p.label)}</span>
        <span class="wizard-key-hint">${escapeHtml(p.hint)}${saved.get(p.id) ? ' · <b>saved</b>' : ''}</span>
      </div>
      <div class="input-with-action">
        <input type="password" class="form-input" data-key-for="${p.id}" placeholder="${saved.get(p.id) ? 'Saved — enter a new key to replace' : 'Paste API key'}">
        <button type="button" class="btn-secondary wizard-save-key" data-save-for="${p.id}">Save</button>
      </div>
    </div>`).join('');
  body.querySelectorAll('[data-save-for]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-save-for');
      const input = body.querySelector(`[data-key-for="${id}"]`);
      const key = input.value.trim();
      if (!key) return;
      btn.textContent = 'Saving…';
      try {
        const res = await fetch('/api/setup/key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, apiKey: key })
        });
        const result = await res.json();
        btn.textContent = result.success ? 'Saved' : 'Failed';
        if (result.success) { input.value = ''; await refreshSetupState(); await loadModels(); renderWizard(); }
      } catch (err) {
        btn.textContent = 'Failed';
      }
    });
  });
  wizardButton(footer, 'Back', false, () => { wizard.step = 1; renderWizard(); });
  wizardButton(footer, 'Continue', true, () => { wizard.step = 3; renderWizard(); });
}

function renderWizardModel(body, footer) {
  document.getElementById('wizardTitle').textContent = 'Choose your default model';
  document.getElementById('wizardSubtitle').textContent = 'You can switch anytime from the composer.';
  const options = [];
  (state.presets || []).forEach((preset) => {
    (preset.defaultModels || []).forEach((m) => options.push({ model: m, provider: preset.id, label: `${m} · ${preset.name}` }));
  });
  const usable = options.filter((o) => {
    if (o.provider === 'antigravity') return wizard.setup.antigravity.accounts.length > 0;
    const kp = wizard.setup.keyProviders.find((p) => p.id === o.provider);
    return kp && kp.has_key;
  });
  const list = usable.length > 0 ? usable : options;
  body.innerHTML = `
    <div class="form-group">
      <label class="form-label">Default model</label>
      <select id="wizardModelSelect" class="form-select">
        ${list.map((o) => `<option value="${escapeHtml(o.provider + '|' + o.model)}">${escapeHtml(o.label)}</option>`).join('')}
      </select>
      ${usable.length === 0 ? '<p class="wizard-note">No provider is connected yet — you can still pick one and add its key later from Settings.</p>' : ''}
    </div>`;
  wizardButton(footer, 'Back', false, () => { wizard.step = 2; renderWizard(); });
  wizardButton(footer, 'Finish', true, async () => {
    const [provider, ...rest] = document.getElementById('wizardModelSelect').value.split('|');
    await setDefaultModel(rest.join('|'), provider);
    closeSetupWizard();
  });
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init);
