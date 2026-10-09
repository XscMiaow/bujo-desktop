'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 设置存储。
 *
 * - 设置文件写在用户目录（Electron 的 userData），不进项目、不进版本库。
 * - API Key 用注入的 encryptor 加密（Electron 里是 safeStorage，走系统钥匙串/DPAPI），
 *   渲染层永远拿不到明文，只能拿到「有没有配置」。
 * - encryptor 用注入方式，方便在 Node 里用假实现做单元测试。
 */

const DEFAULT_SETTINGS = {
  // OpenAI 兼容接口，换 provider 就是换 baseUrl + model
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  provider: 'openai',
  // 这里只写角色与语气；「对话 + 新增条目 + 笔记改动」的格式约定由 ai-reply.buildSystemPrompt() 自动追加
  systemPrompt: '你是子弹笔记（Bullet Journal）助手，中文作答。回答简洁、直接：结论、解释和追问说给用户听；先看笔记里已经记过什么，能改的就改，不要重复记一遍。',
  temperature: 0.7
};

/**
 * 早期版本的默认提示词。功能改成「对话 + 日记块」后，旧文案会让模型直接把要点写进回答，
 * 看到就自动换成新默认值；用户自己改过的提示词一律保留。
 */
const LEGACY_SYSTEM_PROMPTS = [
  '你是子弹笔记（Bullet Journal）助手，中文作答。回答简洁、直接：结论、解释和追问说给用户听，值得长期留存的内容才写成日记条目，不要堆砌。',
  '你是子弹笔记（Bullet Journal）助手。回答简洁、条理清晰；可以执行的动作请写成「- [ ] 事项」，普通要点写成「- 要点」。',
  '你是子弹笔记（Bullet Journal）助手。中文作答，回答简洁、条理清晰。'
];

/** 设置界面的服务商预设：都是 OpenAI 兼容的 /chat/completions 接口 */
const PROVIDER_PRESETS = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'moonshot', label: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { id: 'ollama', label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1' },
  { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', model: '' }
];

const LAST_KEY_HINT_LENGTH = 4;

class SettingsService {
  /**
   * @param {{ filePath: string, encryptor?: { isAvailable(): boolean, encrypt(s: string): Buffer, decrypt(b: Buffer): string } }} options
   */
  constructor({ filePath, encryptor } = {}) {
    if (!filePath) throw new Error('SettingsService 需要 filePath');
    this.filePath = filePath;
    this.encryptor = encryptor || {
      isAvailable: () => false,
      encrypt: () => {
        throw new Error('当前环境不支持加密存储');
      },
      decrypt: () => {
        throw new Error('当前环境不支持加密存储');
      }
    };
    this.cache = null;
  }

  /** 读设置文件；文件损坏时退回默认值，不抛异常 */
  readRaw() {
    if (this.cache) return this.cache;
    let parsed = {};
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') this.lastError = `设置文件无法解析：${err.message}`;
      parsed = {};
    }
    this.cache = parsed && typeof parsed === 'object' ? parsed : {};
    return this.cache;
  }

  /**
   * 读出生效的系统提示词：
   * - 没写过 → 新默认值
   * - 还是旧版默认文案 → 自动升级成新默认值（它描述的是旧行为）
   * - 用户自己写的（包括清空）→ 原样返回
   */
  resolveSystemPrompt(raw) {
    if (typeof raw.systemPrompt !== 'string') return DEFAULT_SETTINGS.systemPrompt;
    const trimmed = raw.systemPrompt.trim();
    if (LEGACY_SYSTEM_PROMPTS.includes(trimmed)) return DEFAULT_SETTINGS.systemPrompt;
    return raw.systemPrompt;
  }

  /** 可以安全交给渲染层的部分：不含 key，只含 key 是否已配置与末四位提示 */
  getPublic() {
    const raw = this.readRaw();
    return {
      baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : DEFAULT_SETTINGS.baseUrl,
      model: typeof raw.model === 'string' && raw.model ? raw.model : DEFAULT_SETTINGS.model,
      provider: typeof raw.provider === 'string' ? raw.provider : DEFAULT_SETTINGS.provider,
      systemPrompt: this.resolveSystemPrompt(raw),
      temperature: typeof raw.temperature === 'number' ? raw.temperature : DEFAULT_SETTINGS.temperature,
      hasApiKey: Boolean(raw.apiKeyCipher || raw.apiKey),
      apiKeyHint: typeof raw.apiKeyHint === 'string' ? raw.apiKeyHint : null,
      encrypted: Boolean(raw.apiKeyCipher) && this.encryptor.isAvailable(),
      encryptionAvailable: this.encryptor.isAvailable(),
      presets: PROVIDER_PRESETS
    };
  }

  /** 只给主进程用的完整配置（含明文 key） */
  getForRequest() {
    const raw = this.readRaw();
    return { ...this.getPublic(), apiKey: this.readApiKey() };
  }

  readApiKey() {
    const raw = this.readRaw();
    if (raw.apiKeyCipher && this.encryptor.isAvailable()) {
      try {
        return this.encryptor.decrypt(Buffer.from(raw.apiKeyCipher, 'base64'));
      } catch (err) {
        this.lastError = `密钥解密失败：${err.message}`;
        return '';
      }
    }
    return typeof raw.apiKey === 'string' ? raw.apiKey : '';
  }

  /**
   * 保存设置。patch.apiKey 为空字符串表示「不改动」；要删除请用 clearApiKey()。
   * @returns {{ ok: true, settings: object } | { ok: false, error: string }}
   */
  save(patch = {}) {
    const raw = { ...this.readRaw() };

    if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) raw.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '');
    if (typeof patch.model === 'string' && patch.model.trim()) raw.model = patch.model.trim();
    if (typeof patch.provider === 'string' && patch.provider) raw.provider = patch.provider;
    if (typeof patch.systemPrompt === 'string') raw.systemPrompt = patch.systemPrompt;
    if (typeof patch.temperature === 'number' && Number.isFinite(patch.temperature)) {
      raw.temperature = Math.min(2, Math.max(0, patch.temperature));
    }

    if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      const apiKey = patch.apiKey.trim();
      raw.apiKeyHint = apiKey.slice(-LAST_KEY_HINT_LENGTH);
      if (this.encryptor.isAvailable()) {
        raw.apiKeyCipher = this.encryptor.encrypt(apiKey).toString('base64');
        delete raw.apiKey;
      } else {
        // 系统不支持加密时降级为明文，并在 getPublic() 里如实告诉界面
        raw.apiKey = apiKey;
        delete raw.apiKeyCipher;
      }
    }

    if (patch.removeApiKey === true) {
      delete raw.apiKeyCipher;
      delete raw.apiKey;
      delete raw.apiKeyHint;
    }

    if (patch.baseUrl && !/^https?:\/\//i.test(raw.baseUrl)) {
      return { ok: false, error: '接口地址需要以 http:// 或 https:// 开头' };
    }

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(raw, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      return { ok: false, error: `设置保存失败：${err.message}` };
    }

    this.cache = raw;
    return { ok: true, settings: this.getPublic() };
  }

  clearApiKey() {
    return this.save({ removeApiKey: true });
  }
}

module.exports = { SettingsService, DEFAULT_SETTINGS, PROVIDER_PRESETS, LEGACY_SYSTEM_PROMPTS };
