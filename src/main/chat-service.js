'use strict';

/**
 * OpenAI 兼容的聊天补全（/chat/completions），支持流式输出。
 *
 * 只依赖 fetch，主进程直接调用；API Key 只在主进程里出现。
 * fetch 以参数注入，方便单元测试用假实现验证 SSE 解析与错误处理。
 */

const DEFAULT_TIMEOUT_MS = 120000;

/** 把 SSE 文本流切成 data 负载：处理跨块的半行、CRLF 与 [DONE] */
function createSseParser(onEvent) {
  let buffer = '';

  function feed(chunk) {
    buffer += chunk;
    let match;
    // SSE 事件以空行分隔；半行留在 buffer 里等下一块
    while ((match = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const rawEvent = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      emit(rawEvent);
    }
  }

  function emit(rawEvent) {
    for (const line of rawEvent.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') {
        onEvent({ done: true });
        continue;
      }
      try {
        onEvent({ json: JSON.parse(data), done: false });
      } catch {
        onEvent({ raw: data, done: false });
      }
    }
  }

  function flush() {
    if (buffer.trim()) {
      emit(buffer);
      buffer = '';
    }
  }

  return { feed, flush };
}

/** 从一条流式 data 里取出增量文本（兼容 OpenAI 与少数变体） */
function extractDelta(json) {
  if (!json || typeof json !== 'object') return '';
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  if (!choice) return '';
  const delta = choice.delta || choice.message || {};
  if (typeof delta.content === 'string') return delta.content;
  // 有些实现把内容放在 reasoning_content / text 里
  if (typeof delta.reasoning_content === 'string') return '';
  if (typeof json.text === 'string') return json.text;
  return '';
}

function describeHttpError(status, bodyText) {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = (parsed.error && (parsed.error.message || parsed.error.type)) || parsed.message || '';
  } catch {
    detail = (bodyText || '').slice(0, 300);
  }
  const hints = {
    401: 'API Key 无效或已过期，请在设置里重新填写',
    403: '该 Key 没有调用这个模型的权限',
    404: '接口地址或模型名不对（检查 baseURL 是否以 /v1 结尾）',
    429: '请求太频繁或额度用尽，稍后再试',
    500: '服务端错误',
    502: '网关错误',
    503: '服务暂时不可用'
  };
  const hint = hints[status] ? `（${hints[status]}）` : '';
  return `请求失败 ${status}${hint}${detail ? `：${detail}` : ''}`;
}

/**
 * 发送一次流式对话请求。
 *
 * @param {object} options
 * @param {string} options.baseUrl    例如 https://api.deepseek.com/v1
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {Array<{role:string, content:string}>} options.messages
 * @param {number} [options.temperature]
 * @param {(text: string) => void} [options.onDelta] 每收到一段增量文本回调一次
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ ok: boolean, content?: string, error?: string, aborted?: boolean, model?: string }>}
 */
async function streamChat(options) {
  const {
    baseUrl,
    apiKey,
    model,
    messages,
    temperature,
    onDelta,
    signal,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = options;

  if (!baseUrl) return { ok: false, error: '还没有配置接口地址，请在设置里填写' };
  if (!model) return { ok: false, error: '还没有配置模型名，请在设置里填写' };
  if (!apiKey) return { ok: false, error: '还没有配置 API Key，请点击右上角设置' };
  if (typeof fetchImpl !== 'function') return { ok: false, error: '当前环境不支持 fetch' };

  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  let content = '';
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: typeof temperature === 'number' ? temperature : undefined,
        stream: true
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      return { ok: false, error: describeHttpError(response.status, bodyText) };
    }
    if (!response.body) return { ok: false, error: '服务端没有返回流式内容' };

    const parser = createSseParser((event) => {
      if (event.done) return;
      const delta = extractDelta(event.json);
      if (delta) {
        content += delta;
        if (onDelta) onDelta(delta);
      }
    });

    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      parser.feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    }
    parser.flush();

    if (!content) return { ok: false, error: '模型没有返回内容（可能是模型名不对或该模型不支持流式）' };
    return { ok: true, content, model };
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      if (signal && signal.aborted) return { ok: false, aborted: true, error: '已取消' };
      return { ok: false, error: `请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）` };
    }
    const message = err && err.message ? err.message : String(err);
    return { ok: false, error: `无法连接服务：${message}` };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

module.exports = { streamChat, createSseParser, extractDelta, describeHttpError };
