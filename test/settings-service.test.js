'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingsService, PROVIDER_PRESETS, DEFAULT_SETTINGS, LEGACY_SYSTEM_PROMPTS } = require('../src/main/settings-service.js');
const { buildSystemPrompt } = require('../src/shared/ai-reply.js');

let tmpDir;
let file;

/** 用 base64 冒充系统钥匙串，测试里能验证「密文可还原、明文不落盘」 */
const fakeEncryptor = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(`enc:${value}`, 'utf8'),
  decrypt: (buffer) => buffer.toString('utf8').replace(/^enc:/, '')
};

const noEncryptor = { isAvailable: () => false };

function makeService(encryptor = fakeEncryptor, name = 'settings.json') {
  return new SettingsService({ filePath: path.join(tmpDir, name), encryptor });
}

test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bujo-settings-'));
  file = path.join(tmpDir, 'settings.json');
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('默认设置：没有密钥，返回预设列表', () => {
  const service = makeService();
  const settings = service.getPublic();

  assert.equal(settings.hasApiKey, false);
  assert.equal(settings.apiKey, undefined, '给渲染层的设置里不能有 apiKey 字段');
  assert.equal(settings.baseUrl, 'https://api.openai.com/v1');
  assert.equal(settings.encryptionAvailable, true);
  assert.ok(settings.presets.some((preset) => preset.id === 'deepseek'));
  assert.ok(PROVIDER_PRESETS.length >= 5);
});

test('保存密钥后：磁盘上是密文，渲染层只拿到末四位', () => {
  const service = makeService();
  const result = service.save({ apiKey: 'sk-test-1234abcd', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1/' });

  assert.equal(result.ok, true);
  assert.equal(result.settings.hasApiKey, true);
  assert.equal(result.settings.apiKeyHint, 'abcd');
  assert.equal(result.settings.model, 'deepseek-chat');
  assert.equal(result.settings.baseUrl, 'https://api.deepseek.com/v1', '结尾斜杠被去掉');

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(onDisk.apiKeyCipher, '密钥以密文形式保存');
  assert.equal(onDisk.apiKey, undefined, '磁盘上不能出现明文密钥');
  assert.ok(!JSON.stringify(onDisk).includes('sk-test-1234abcd'), '磁盘内容里搜不到明文');

  assert.equal(service.getForRequest().apiKey, 'sk-test-1234abcd', '主进程能解出明文用于请求');
  assert.equal(service.getPublic().apiKey, undefined, '渲染层永远拿不到明文');
});

test('patch.apiKey 为空表示不改动；clearApiKey 才删除', () => {
  const service = makeService(fakeEncryptor, 'second.json');
  service.save({ apiKey: 'sk-keepme-9999' });
  service.save({ apiKey: '', model: 'gpt-4o-mini' });

  assert.equal(service.getPublic().hasApiKey, true);
  assert.equal(service.getPublic().apiKeyHint, '9999');
  assert.equal(service.getForRequest().apiKey, 'sk-keepme-9999');

  service.clearApiKey();
  assert.equal(service.getPublic().hasApiKey, false);
  assert.equal(service.getPublic().apiKeyHint, null);
  assert.equal(service.getForRequest().apiKey, '');
});

test('系统不支持加密时降级为明文存储，并如实告知界面', () => {
  const service = makeService(noEncryptor, 'plain.json');
  service.save({ apiKey: 'sk-plain-0001' });

  const settings = service.getPublic();
  assert.equal(settings.hasApiKey, true);
  assert.equal(settings.encrypted, false);
  assert.equal(settings.encryptionAvailable, false);

  const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'plain.json'), 'utf8'));
  assert.equal(onDisk.apiKey, 'sk-plain-0001');
});

test('接口地址必须是 http(s)，非法时拒绝保存', () => {
  const service = makeService(fakeEncryptor, 'third.json');
  const result = service.save({ baseUrl: 'file:///etc/passwd' });
  assert.equal(result.ok, false);
  assert.match(result.error, /http/);
  assert.equal(service.getPublic().baseUrl, 'https://api.openai.com/v1', '拒绝后设置保持不变');
});

test('默认系统提示词只写角色，三段式协议由请求时追加', () => {
  const service = makeService(fakeEncryptor, 'prompt.json');
  const prompt = service.getPublic().systemPrompt;

  assert.equal(prompt, DEFAULT_SETTINGS.systemPrompt);
  assert.match(prompt, /子弹笔记/);
  assert.ok(!prompt.includes('<journal>'), '默认提示词里不写死协议，避免和自动追加的内容重复');
  // 提示词要描述现在真的会发生的分工：说给用户的 / 先看已有笔记再决定改还是新增
  assert.match(prompt, /先看笔记/);
  assert.match(prompt, /不要重复/);

  const built = buildSystemPrompt(prompt);
  assert.ok(built.startsWith(prompt));
  assert.ok(built.includes('<chat>') && built.includes('<journal>') && built.includes('<note-edit>'));
});

test('旧版本的默认提示词会被自动升级，用户自己写的原样保留', () => {
  for (const [index, legacy] of LEGACY_SYSTEM_PROMPTS.entries()) {
    const service = makeService(fakeEncryptor, `legacy-${index}.json`);
    service.save({ systemPrompt: legacy });
    assert.equal(service.getPublic().systemPrompt, DEFAULT_SETTINGS.systemPrompt);
    assert.equal(service.getForRequest().systemPrompt, DEFAULT_SETTINGS.systemPrompt, '真正发出去的也是新提示词');
  }

  const custom = '你是我的私人秘书，说话像朋友。';
  const service = makeService(fakeEncryptor, 'custom-prompt.json');
  service.save({ systemPrompt: custom });
  assert.equal(service.getPublic().systemPrompt, custom, '用户改过的提示词不动');

  const blank = makeService(fakeEncryptor, 'blank-prompt.json');
  blank.save({ systemPrompt: '' });
  assert.equal(blank.getPublic().systemPrompt, '', '清空就是清空，不偷偷塞回默认值');
  assert.ok(buildSystemPrompt(blank.getForRequest().systemPrompt).includes('<journal>'), '清空后仍然带上格式约定');
});

test('设置文件损坏时退回默认值，不抛异常', () => {
  const broken = path.join(tmpDir, 'broken.json');
  fs.writeFileSync(broken, '{ 这不是 json', 'utf8');

  const service = new SettingsService({ filePath: broken, encryptor: fakeEncryptor });
  assert.equal(service.getPublic().baseUrl, 'https://api.openai.com/v1');
  assert.equal(service.getPublic().hasApiKey, false);
});

test('加密不可用时读旧密文不会崩溃，只是拿不到密钥', () => {
  const service = makeService(fakeEncryptor, 'mixed.json');
  service.save({ apiKey: 'sk-encrypted-7777' });

  const downgraded = new SettingsService({ filePath: path.join(tmpDir, 'mixed.json'), encryptor: noEncryptor });
  assert.equal(downgraded.getForRequest().apiKey, '');
  assert.equal(downgraded.getPublic().hasApiKey, true, '仍然知道曾经配置过密钥');
});

test('悬浮窗 bounds：合法存取，非法值丢弃，没存过返回 null', () => {
  const service = makeService(fakeEncryptor, 'bounds.json');
  assert.equal(service.getPublic().floatingBounds, null, '从未开过悬浮窗时没有位置记录');

  service.save({ floatingBounds: { x: 120, y: 80, width: 360, height: 560 } });
  assert.deepEqual(service.getPublic().floatingBounds, { x: 120, y: 80, width: 360, height: 560 });

  // 非法值（含 NaN/负尺寸/超大坐标）不入盘，旧值保留
  service.save({ floatingBounds: { x: NaN, y: 0, width: 360, height: 560 } });
  assert.deepEqual(service.getPublic().floatingBounds, { x: 120, y: 80, width: 360, height: 560 });
  service.save({ floatingBounds: { x: 1e9, y: 0, width: 360, height: 560 } });
  assert.deepEqual(service.getPublic().floatingBounds, { x: 120, y: 80, width: 360, height: 560 });

  const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'bounds.json'), 'utf8'));
  assert.deepEqual(onDisk.floatingBounds, { x: 120, y: 80, width: 360, height: 560 });
});
