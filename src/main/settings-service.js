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
 * 每种界面语言一句默认提示词。用户没写过（或仍是其它语言的默认值）时，
 * 系统提示词自动跟着界面语言走；用户自己改过的一律保留。
 */
const DEFAULT_SYSTEM_PROMPTS = {
  'zh-CN': DEFAULT_SETTINGS.systemPrompt,
  en: 'You are the Bullet Journal assistant. Answer in English, concisely and directly: conclusions, explanations and follow-up questions go to the user; check what is already in the note first — edit existing entries instead of writing the same thing twice.'
};

/** 所有会内部当作默认值的提示词（各语言默认 + 旧版默认），对上任何一个都视为「没自定义过」 */
const ALL_DEFAULT_PROMPTS = [
  ...Object.values(DEFAULT_SYSTEM_PROMPTS),
  '你是子弹笔记（Bullet Journal）助手，中文作答。回答简洁、直接：结论、解释和追问说给用户听，值得长期留存的内容才写成日记条目，不要堆砌。',
  '你是子弹笔记（Bullet Journal）助手。回答简洁、条理清晰；可以执行的动作请写成「- [ ] 事项」，普通要点写成「- 要点」。',
  '你是子弹笔记（Bullet Journal）助手。中文作答，回答简洁、条理清晰。'
].map((prompt) => prompt.trim());

/**
 * 早期版本的默认提示词（中文）。功能改成「对话 + 日记块」后，旧文案会让模型直接把要点写进回答；
 * 这些文案现在包含在 ALL_DEFAULT_PROMPTS 里，会被自动升级成当前语言的默认值。
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

/** 没存过 locale 时的默认界面语言 */
const DEFAULT_LOCALE_ID = 'zh-CN';

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
   * 读出当前界面语言下生效的系统提示词：
   * - 没写过 → 当前语言的默认值
   * - 还是某个语言的默认文案（含旧版默认）→ 自动跟着界面语言走
   * - 用户自己写的（包括清空）→ 原样返回，不随语言变
   * @param {string} [locale] 当前界面语言（settings.locale，如 'zh-CN' / 'en'）
   */
  resolveSystemPrompt(raw, locale) {
    const currentLocale = typeof locale === 'string' && locale ? locale : DEFAULT_LOCALE_ID;
    if (typeof raw.systemPrompt !== 'string') return DEFAULT_SYSTEM_PROMPTS[currentLocale] || DEFAULT_SETTINGS.systemPrompt;
    const trimmed = raw.systemPrompt.trim();
    if (ALL_DEFAULT_PROMPTS.includes(trimmed)) return DEFAULT_SYSTEM_PROMPTS[currentLocale] || DEFAULT_SETTINGS.systemPrompt;
    return raw.systemPrompt;
  }

    /** 可以安全交给渲染层的部分：不含 key，只含 key 是否已配置与末四位提示 */
  getPublic() {
    const raw = this.readRaw();
    const locale = typeof raw.locale === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(raw.locale) ? raw.locale : DEFAULT_LOCALE_ID;
    return {
      baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : DEFAULT_SETTINGS.baseUrl,
      model: typeof raw.model === 'string' && raw.model ? raw.model : DEFAULT_SETTINGS.model,
      provider: typeof raw.provider === 'string' ? raw.provider : DEFAULT_SETTINGS.provider,
      // 系统提示词：没自定义过（或是另一个语言的默认文案）时自动用当前语言那一句
      systemPrompt: this.resolveSystemPrompt(raw, locale),
      temperature: typeof raw.temperature === 'number' ? raw.temperature : DEFAULT_SETTINGS.temperature,
      // 界面主题（styles/ 文件夹里那份 css 的 id）；坏值/conflict 都回落到默认深色
      theme: typeof raw.theme === 'string' && /^[a-z0-9-]{1,24}$/.test(raw.theme) ? raw.theme : 'dark',
      // 界面语言（locales/ 文件夹里那份字典的 id）；坏值回落默认中文
      locale,
      hasApiKey: Boolean(raw.apiKeyCipher || raw.apiKey),
      apiKeyHint: typeof raw.apiKeyHint === 'string' ? raw.apiKeyHint : null,
      encrypted: Boolean(raw.apiKeyCipher) && this.encryptor.isAvailable(),
      encryptionAvailable: this.encryptor.isAvailable(),
      presets: PROVIDER_PRESETS,
      // 悬浮小窗上次的位置/大小（可能为 null，从未开过悬浮窗时没有）
      floatingBounds: raw.floatingBounds && typeof raw.floatingBounds === 'object'
        ? {
            x: typeof raw.floatingBounds.x === 'number' ? raw.floatingBounds.x : null,
            y: typeof raw.floatingBounds.y === 'number' ? raw.floatingBounds.y : null,
            width: typeof raw.floatingBounds.width === 'number' ? raw.floatingBounds.width : null,
            height: typeof raw.floatingBounds.height === 'number' ? raw.floatingBounds.height : null
          }
        : null
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
    // 界面主题：只认短小写字母数字与连字符，别的不动
    if (typeof patch.theme === 'string' && /^[a-z0-9-]{1,24}$/.test(patch.theme)) {
      raw.theme = patch.theme;
    }
    // 界面语言：BCP-47 风格的短 id（zh-CN / en / pt-BR…）
    if (typeof patch.locale === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(patch.locale)) {
      raw.locale = patch.locale;
    }

    // 悬浮小窗位置（bounds 才能完整恢复；只存数字，坏值直接忽略）
    if (patch.floatingBounds && typeof patch.floatingBounds === 'object') {
      const b = patch.floatingBounds;
      if ([b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n) && n > -16000 && n < 16000)) {
        raw.floatingBounds = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
      }
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
