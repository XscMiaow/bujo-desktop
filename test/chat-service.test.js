'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { streamChat, createSseParser, extractDelta, describeHttpError } = require('../src/main/chat-service.js');

/** 造一个「像 fetch 返回」的响应：body 是异步可迭代的字符串流 */
function fakeResponse(chunks, { ok = true, status = 200, bodyText = '' } = {}) {
  async function* stream() {
    for (const chunk of chunks) {
      if (chunk.delay) await new Promise((resolve) => setTimeout(resolve, chunk.delay));
      if (chunk.abort) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      yield chunk.text ?? chunk;
    }
  }
  return {
    ok,
    status,
    body: ok ? stream() : null,
    text: async () => bodyText
  };
}

function sse(content) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

test('SSE 解析：跨块半行、CRLF、[DONE]', () => {
  const events = [];
  const parser = createSseParser((event) => events.push(event));

  parser.feed(sse('你好').slice(0, 20)); // 故意的半截
  parser.feed(sse('你好').slice(20) + 'data: {"choices":[{"delta":{"content":"世界"}}]}\r\n\r\n');
  parser.feed('data: [DONE]\n\n');
  parser.flush();

  const texts = events.filter((e) => e.json).map((e) => extractDelta(e.json));
  assert.deepEqual(texts, ['你好', '世界']);
  assert.equal(events.at(-1).done, true);
});

test('无换行的尾块在 flush 时也会处理', () => {
  const events = [];
  const parser = createSseParser((event) => events.push(event));
  parser.feed('data: {"choices":[{"delta":{"content":"尾巴"}}]}');
  assert.equal(events.length, 0, '还没遇到事件分隔符');
  parser.flush();
  assert.equal(extractDelta(events[0].json), '尾巴');
});

test('流式聊天：逐段回调并返回完整内容', async () => {
  const deltas = [];
  const result = await streamChat({
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    messages: [{ role: 'user', content: '你好' }],
    onDelta: (text) => deltas.push(text),
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://example.com/v1/chat/completions');
      assert.equal(init.headers.Authorization, 'Bearer sk-test');
      const body = JSON.parse(init.body);
      assert.equal(body.stream, true);
      assert.equal(body.model, 'test-model');
      return fakeResponse([sse('要点'), sse('一'), { text: sse('要点二') }]);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.content, '要点一要点二');
  assert.deepEqual(deltas, ['要点', '一', '要点二']);
  assert.equal(result.model, 'test-model');
});

test('缺少配置时给出可操作的提示，且不会发请求', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return fakeResponse([]);
  };

  assert.match((await streamChat({ baseUrl: '', apiKey: 'k', model: 'm', messages: [], fetchImpl })).error, /接口地址/);
  assert.match((await streamChat({ baseUrl: 'https://x/v1', apiKey: '', model: 'm', messages: [], fetchImpl })).error, /API Key/);
  assert.match((await streamChat({ baseUrl: 'https://x/v1', apiKey: 'k', model: '', messages: [], fetchImpl })).error, /模型名/);
  assert.equal(called, false, '配置不全时不应该发出请求');
});

test('HTTP 错误会翻译成看得懂的话', async () => {
  const cases = [
    [401, { error: { message: 'Invalid key' } }, /API Key 无效/],
    [404, {}, /接口地址或模型名/],
    [429, {}, /额度|频繁/]
  ];

  for (const [status, body, pattern] of cases) {
    const result = await streamChat({
      baseUrl: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
      messages: [],
      fetchImpl: async () => fakeResponse([], { ok: false, status, bodyText: JSON.stringify(body) })
    });
    assert.equal(result.ok, false);
    assert.match(result.error, pattern, `status ${status}`);
  }
});

test('网络异常与超时都有清晰错误', async () => {
  const offline = await streamChat({
    baseUrl: 'https://x/v1',
    apiKey: 'k',
    model: 'm',
    messages: [],
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }
  });
  assert.equal(offline.ok, false);
  assert.match(offline.error, /无法连接服务/);

  const timeout = await streamChat({
    baseUrl: 'https://x/v1',
    apiKey: 'k',
    model: 'm',
    messages: [],
    timeoutMs: 10,
    fetchImpl: async () => fakeResponse([{ delay: 60, abort: true }])
  });
  assert.equal(timeout.ok, false);
  assert.match(timeout.error, /超时/);
});

test('取消请求返回 aborted，已生成的内容不当作成功', async () => {
  const controller = new AbortController();
  const result = await streamChat({
    baseUrl: 'https://x/v1',
    apiKey: 'k',
    model: 'm',
    messages: [],
    signal: controller.signal,
    fetchImpl: async () => {
      controller.abort();
      return fakeResponse([{ abort: true }]);
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
});

test('返回空内容的流会被判定为失败', async () => {
  const result = await streamChat({
    baseUrl: 'https://x/v1',
    apiKey: 'k',
    model: 'm',
    messages: [],
    fetchImpl: async () => fakeResponse(['data: [DONE]\n\n'])
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /没有返回内容/);
});

test('describeHttpError 带上状态码与后端原文', () => {
  const message = describeHttpError(400, JSON.stringify({ error: { message: 'bad request detail' } }));
  assert.match(message, /400/);
  assert.match(message, /bad request detail/);
  assert.match(describeHttpError(500, 'plain text body'), /plain text body/);
});
