'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingsService, PROVIDER_PRESETS } = require('../src/main/settings-service.js');

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
