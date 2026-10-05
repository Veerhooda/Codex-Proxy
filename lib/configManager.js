const fs = require('fs');
const path = require('path');
const os = require('os');
const TOML = require('@ltd/j-toml');

const CODEX_DIR = path.join(os.homedir(), '.codex');
const CONFIG_PATH = path.join(CODEX_DIR, 'config.toml');
const ENV_PATH = path.join(CODEX_DIR, '.env');

class ConfigManager {
  constructor() {
    this.configPath = CONFIG_PATH;
    this.envPath = ENV_PATH;
  }

  ensureCodexDir() {
    if (!fs.existsSync(CODEX_DIR)) {
      fs.mkdirSync(CODEX_DIR, { recursive: true });
    }
  }

  readConfigRaw() {
    if (!fs.existsSync(this.configPath)) {
      return '';
    }
    return fs.readFileSync(this.configPath, 'utf-8');
  }

  readEnv() {
    const env = {};
    if (!fs.existsSync(this.envPath)) {
      return env;
    }
    try {
      const content = fs.readFileSync(this.envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const [key, ...rest] = trimmed.split('=');
          env[key.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
        }
      }
    } catch (e) {
      console.error('Error reading .env:', e);
    }
    return env;
  }

  setEnvVar(key, value) {
    this.ensureCodexDir();
    let lines = [];
    if (fs.existsSync(this.envPath)) {
      lines = fs.readFileSync(this.envPath, 'utf-8').split('\n');
    }
    let found = false;
    const newLines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key}=`)) {
        found = true;
        return `${key}="${value}"`;
      }
      return line;
    });
    if (!found) {
      newLines.push(`${key}="${value}"`);
    }
    fs.writeFileSync(this.envPath, newLines.filter(l => l.trim() !== '').join('\n') + '\n', 'utf-8');
  }

  readConfig() {
    const raw = this.readConfigRaw();
    if (!raw.trim()) {
      return { model: 'gpt-4o', model_provider: 'openai', model_providers: {}, plugins: {} };
    }
    try {
      return TOML.parse(raw, 1.0, '\n');
    } catch (err) {
      console.error('Failed to parse config.toml:', err);
      return {};
    }
  }

  getProviders() {
    const config = this.readConfig();
    const providers = config.model_providers || {};
    const env = this.readEnv();
    const result = [];

    for (const [id, prov] of Object.entries(providers)) {
      const envKey = prov.env_key || '';
      const hasKey = Boolean(process.env[envKey] || env[envKey]);
      result.push({
        id,
        name: prov.name || id,
        base_url: prov.base_url || '',
        env_key: envKey,
        has_key: hasKey,
        wire_api: prov.wire_api || 'responses',
        requires_openai_auth: Boolean(prov.requires_openai_auth),
        supports_websockets: Boolean(prov.supports_websockets)
      });
    }
    return result;
  }

  getActiveModelInfo() {
    const config = this.readConfig();
    return {
      model: config.model || 'muse-spark-1.3-contributor',
      provider: config.model_provider || 'meta',
      reasoning_effort: config.model_reasoning_effort || 'high'
    };
  }

  backupConfig() {
    if (fs.existsSync(this.configPath)) {
      const bakPath = `${this.configPath}.${Date.now()}.bak`;
      fs.copyFileSync(this.configPath, bakPath);
      return bakPath;
    }
    return null;
  }

  addOrUpdateProvider({ id, name, baseUrl, apiKey, envKey, wireApi = 'responses', requiresOpenaiAuth = false, supportsWebsockets = false, isDefault = false, modelName = null }) {
    this.ensureCodexDir();
    this.backupConfig();

    const actualEnvKey = envKey || `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;

    if (apiKey) {
      this.setEnvVar(actualEnvKey, apiKey);
      process.env[actualEnvKey] = apiKey;
    }

    let raw = this.readConfigRaw();
    const sectionHeader = `[model_providers.${id}]`;

    const newSection = [
      sectionHeader,
      `name = "${name || id}"`,
      `base_url = "${baseUrl}"`,
      `env_key = "${actualEnvKey}"`,
      `wire_api = "${wireApi}"`,
      requiresOpenaiAuth ? 'requires_openai_auth = true' : null,
      supportsWebsockets ? 'supports_websockets = true' : 'supports_websockets = false'
    ].filter(Boolean).join('\n');

    if (raw.includes(sectionHeader)) {
      // Replace existing section (trailing `$` covers a last-in-file section;
      // JS has no `\Z` anchor, so the old lookahead silently missed it)
      const regex = new RegExp(`\\[model_providers\\.${id}\\][\\s\\S]*?(?=\\n\\[|$)`, 'g');
      raw = raw.replace(regex, newSection + '\n');
    } else {
      // Append section
      raw = raw.trim() + '\n\n' + newSection + '\n';
    }

    if (isDefault) {
      // Update top-level model and model_provider
      if (/^model_provider\s*=/m.test(raw)) {
        raw = raw.replace(/^model_provider\s*=.*$/m, `model_provider = "${id}"`);
      } else {
        raw = `model_provider = "${id}"\n` + raw;
      }
      if (modelName) {
        if (/^model\s*=/m.test(raw)) {
          raw = raw.replace(/^model\s*=.*$/m, `model = "${modelName}"`);
        } else {
          raw = `model = "${modelName}"\n` + raw;
        }
      }
    }

    fs.writeFileSync(this.configPath, raw, 'utf-8');
    return { success: true, id, envKey: actualEnvKey };
  }

  setDefaultModel(model, provider) {
    this.ensureCodexDir();
    this.backupConfig();
    let raw = this.readConfigRaw();

    if (/^model\s*=/m.test(raw)) {
      raw = raw.replace(/^model\s*=.*$/m, `model = "${model}"`);
    } else {
      raw = `model = "${model}"\n` + raw;
    }

    if (provider) {
      if (/^model_provider\s*=/m.test(raw)) {
        raw = raw.replace(/^model_provider\s*=.*$/m, `model_provider = "${provider}"`);
      } else {
        raw = `model_provider = "${provider}"\n` + raw;
      }
    }

    fs.writeFileSync(this.configPath, raw, 'utf-8');
    return { success: true, model, provider };
  }

  getPlugins() {
    const config = this.readConfig();
    const pluginsObj = config.plugins || {};
    const result = [];
    for (const [pluginId, details] of Object.entries(pluginsObj)) {
      const [name, marketplace] = pluginId.split('@');
      result.push({
        id: pluginId,
        name: name || pluginId,
        marketplace: marketplace || 'bundled',
        enabled: Boolean(details && details.enabled)
      });
    }
    return result;
  }
}

module.exports = new ConfigManager();
