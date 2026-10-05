const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DB_PATH = path.join(os.homedir(), '.codex', 'state_5.sqlite');

class SessionManager {
  listRecentThreads(limit = 30) {
    if (!fs.existsSync(DB_PATH)) {
      return [];
    }
    try {
      const sql = `SELECT id, title, model, cwd, preview, source, datetime(created_at, 'unixepoch', 'localtime') as created_at, datetime(recency_at, 'unixepoch', 'localtime') as updated_at, rollout_path FROM threads ORDER BY recency_at DESC LIMIT ${limit};`;
      const cmd = `sqlite3 -json "${DB_PATH}" "${sql}"`;
      const out = execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
      if (!out.trim()) return [];
      return JSON.parse(out);
    } catch (e) {
      console.error('Error querying state_5.sqlite:', e);
      return [];
    }
  }

  getThreadHistory(threadId) {
    if (!threadId) return null;
    let rolloutPath = null;
    if (fs.existsSync(DB_PATH)) {
      try {
        const sql = `SELECT rollout_path FROM threads WHERE id = '${threadId.replace(/'/g, "''")}';`;
        const cmd = `sqlite3 -json "${DB_PATH}" "${sql}"`;
        const out = execSync(cmd, { encoding: 'utf-8', timeout: 5000 });
        const res = JSON.parse(out);
        if (res && res[0] && res[0].rollout_path) {
          rolloutPath = res[0].rollout_path;
        }
      } catch (e) {
        // fallback
      }
    }

    if (!rolloutPath || !fs.existsSync(rolloutPath)) {
      // Find dynamically in ~/.codex/sessions
      const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
      try {
        const findCmd = `find "${sessionsDir}" -name "*${threadId}*.jsonl" | head -n 1`;
        const found = execSync(findCmd, { encoding: 'utf-8' }).trim();
        if (found && fs.existsSync(found)) {
          rolloutPath = found;
        }
      } catch (e) {}
    }

    if (!rolloutPath || !fs.existsSync(rolloutPath)) {
      return { threadId, events: [], messages: [], error: 'Rollout file not found' };
    }

    const lines = fs.readFileSync(rolloutPath, 'utf-8').split('\n');
    const events = [];
    const messages = [];
    const seenTexts = new Set();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        events.push(event);

        // Normalize into chat messages
        if (event.type === 'event_msg' && event.payload?.type === 'user_input') {
          const text = event.payload.message || event.payload.text;
          if (text && !text.includes('<environment_context>') && !seenTexts.has(text)) {
            seenTexts.add(text);
            messages.push({ role: 'user', content: text });
          }
        } else if (event.type === 'response_item' && event.payload?.role === 'user') {
          const text = event.payload.content?.map(c => c.text).join('\n');
          if (text && !text.includes('<environment_context>') && !seenTexts.has(text)) {
            seenTexts.add(text);
            messages.push({ role: 'user', content: text });
          }
        } else if (event.type === 'event_msg' && event.payload?.type === 'item_completed') {
          const item = event.payload.item;
          if (item?.type === 'AgentMessage' || item?.type === 'agent_message') {
            const text = item.text || item.content?.map(c => c.text).join('\n');
            if (text && !seenTexts.has(text)) {
              seenTexts.add(text);
              messages.push({ role: 'assistant', content: text });
            }
          }
        } else if (event.type === 'response_item' && event.payload?.role === 'assistant') {
          const text = event.payload.content?.map(c => c.text).join('\n');
          if (text && !seenTexts.has(text)) {
            seenTexts.add(text);
            messages.push({ role: 'assistant', content: text });
          }
        }
      } catch (e) {}
    }

    return {
      threadId,
      rolloutPath,
      messages,
      events
    };
  }
}

module.exports = new SessionManager();
