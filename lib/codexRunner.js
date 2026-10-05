const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const configManager = require('./configManager');

const CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex.real';
const FALLBACK_BIN = 'codex';

class CodexRunner extends EventEmitter {
  constructor() {
    super();
    this.currentProcess = null;
    this.currentSession = null;
  }

  getExecutablePath() {
    if (fs.existsSync(CODEX_BIN)) {
      return CODEX_BIN;
    }
    return FALLBACK_BIN;
  }

  isRunning() {
    return Boolean(this.currentProcess && !this.currentProcess.killed);
  }

  stop() {
    if (this.currentProcess) {
      try {
        this.currentProcess.kill('SIGINT');
        setTimeout(() => {
          if (this.isRunning()) {
            this.currentProcess.kill('SIGKILL');
          }
        }, 1500);
      } catch (e) {
        console.error('Error stopping process:', e);
      }
    }
  }

  run({ prompt, model, provider, cwd, threadId, bypassSandbox = true }) {
    if (this.isRunning()) {
      throw new Error('A generation turn is already active.');
    }

    const binary = this.getExecutablePath();
    const args = [];

    // Working directory
    const workingDir = cwd || process.cwd();

    // Check if resuming an existing thread or starting a new thread
    if (threadId) {
      args.push('exec', 'resume', '--json');
    } else {
      args.push('exec', '--json');
      args.push('--thread-source', 'vscode');
    }

    // Always bypass sandbox/approvals if requested to prevent hanging in background
    if (bypassSandbox) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
      args.push('--dangerously-bypass-hook-trust');
    }

    args.push('--skip-git-repo-check');

    if (!threadId) {
      args.push('-C', workingDir);
    }

    // Model & Provider configuration
    if (model) {
      args.push('-m', model);
    }

    if (provider) {
      args.push('-c', `model_provider="${provider}"`);
    }

    if (threadId) {
      args.push(threadId);
    }

    // The prompt
    args.push(prompt);

    // Merge environment variables from ~/.codex/.env and current process
    const envVars = { ...process.env, ...configManager.readEnv() };

    this.emit('status', { state: 'starting', command: [binary, ...args].join(' '), cwd: workingDir });

    const proc = spawn(binary, args, {
      cwd: workingDir,
      env: envVars,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.currentProcess = proc;
    this.currentSession = {
      startedAt: Date.now(),
      prompt,
      model,
      provider,
      cwd: workingDir,
      threadId: threadId || null
    };

    let buffer = '';

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep remainder

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (event.type === 'thread.started' && event.thread_id) {
            this.currentSession.threadId = event.thread_id;
          }
          this.emit('event', event);
        } catch (err) {
          this.emit('raw_output', trimmed);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      this.emit('stderr', text);
    });

    proc.on('error', (err) => {
      this.emit('error', err);
      this.currentProcess = null;
    });

    proc.on('close', (code, signal) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim());
          this.emit('event', event);
        } catch (e) {
          this.emit('raw_output', buffer.trim());
        }
      }
      this.emit('complete', {
        code,
        signal,
        threadId: this.currentSession?.threadId || null,
        duration: Date.now() - (this.currentSession?.startedAt || Date.now())
      });
      this.currentProcess = null;
    });

    return {
      pid: proc.pid,
      cwd: workingDir,
      model
    };
  }
}

module.exports = new CodexRunner();
