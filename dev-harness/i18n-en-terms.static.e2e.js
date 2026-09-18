#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js');
// 静态锁（122 波 §2.10 · 36 号文）：en-US.json 值里的「chat/session」归一成「thread」。
//
// 现状（本波实测清点）:改动前 en-US.json 值里含 \b(chat|chats|session|sessions)\b（大小写不敏感）
// 的键有 144 个；键名本身含 "chat."/"session." 前缀的（如 chat.send、session.new）不计入 ——
// 判据只看【值】，键名不动（36 号文 §2.10 原话）。逐条核对 zh-CN 对应值后，134 个改成 thread/
// conversation 一类的中性译法，10 个保留在下面 ALLOWED 表。
//
// 允许名单（逐键附理由，任何一条改动都会让下面第②段先报出具体哪一键）：
const ALLOWED = {
  'error.api.authToken':
    '"session token" 是安全用语（工作台鉴权令牌），36 号文 §2.10 原话点名的允许项。',
  'settings.agentCli.hint.kimi':
    '"session resume"／"native session" 描述的是 Kimi ACP 协议自身的会话续接机制（原生概念），不是 Ruyi 线程。',
  'ctx.compact.hintExternal':
    '"native session" 指 Agent CLI 的 --resume 原生会话目标（引擎原生概念），不是 Ruyi 线程。',
  'turnActivity.notice.resumeRecovery':
    '"engine session" 指底层引擎会话（引擎原生概念），不是 Ruyi 线程。',
  'settings.resumeClaude':
    '"Claude sessions" 指 config.autoResumeClaudeSessions 控制的 --resume 原生会话续接开关（引擎原生概念）；' +
    '本波把原文里错用的 chats 改成了 sessions，让措辞对上它描述的真实机制。',
  'settings.resumeAgentCli':
    '同 settings.resumeClaude，Agent CLI 版本。',
  'provider.apiStyle.chat':
    '"Chat Completions" 是 OpenAI 兼容 Provider 的官方 API 风格名（第三方专有名词，不可意译）。',
  'provider.apiStyle.hint':
    '同上，引用同一个第三方 API 名 "Chat Completions"。',
  'onboarding.wizard.steward.modelPlaceholder':
    '"deepseek-chat" 是 DeepSeek 官方真实模型 ID（第三方专有名词），占位符必须给可复制的真实例子。',
  'settings.providers.hint':
    '"/chat/completions" 是 OpenAI 兼容协议的字面 REST 路径（第三方接口名，不可意译）；' +
    '本键其余散文已把 "chats" 改成 "conversations"，只留这一处字面路径。',
  'provider.asrProtocol.chatAudio':
    '107-A1：选项名要说清这条协议打的是哪个端点，"/chat/completions" 是 OpenAI 兼容协议的字面 REST 路径' +
    '（第三方接口名，不可意译）；与 provider.apiStyle.chat 同类。',
  'provider.asrProtocol.hint':
    '同上，说明文字里引用的是同一个字面路径 /chat/completions 与它的风格名 "Chat style"（第三方协议名），' +
    '不是 Ruyi 的线程概念。',
};

// 反向验证（已实测，见提交说明）：① 把 session.new 的值改回 "New chat" → 下面第①段红；
// ② 从 ALLOWED 表删掉 error.api.authToken 一条 → 第②段把它当新增违规重新报出来，红。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EN_PATH = path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'locales', 'en-US.json');
const RE = /\b(chat|chats|session|sessions)\b/i;

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const en = JSON.parse(fs.readFileSync(EN_PATH, 'utf8'));
const violations = [];
for (const [key, value] of Object.entries(en)) {
  if (typeof value !== 'string') continue;
  if (!RE.test(value)) continue;
  if (Object.prototype.hasOwnProperty.call(ALLOWED, key)) continue;
  violations.push(key);
}

ok(violations.length === 0,
  '除允许名单外，en-US.json 的值里零 chat/chats/session/sessions（大小写不敏感）' +
  (violations.length ? `；实得违规键:${JSON.stringify(violations)}` : ''));

// 允许名单本身必须原样存在(键还在、值还含那个词)——防止有人把某个键删了/改了却忘记同步这张表,
// 让"允许名单"名不副实。
const staleAllowed = Object.keys(ALLOWED).filter(key => {
  const v = en[key];
  return typeof v !== 'string' || !RE.test(v);
});
ok(staleAllowed.length === 0,
  '允许名单里每一键在 en-US.json 里都还存在且值仍命中该词(否则这条豁免已经名不副实)' +
  (staleAllowed.length ? `；失效项:${JSON.stringify(staleAllowed)}` : ''));

// 键名不动:本锁只看值。抽查几个确定改过值的键,键名字面必须原样在(36 号文 §2.10「键名不动」)。
for (const key of ['session.new', 'session.name', 'chat.newSession', 'palette.newSession', 'storage.store.sessions']) {
  ok(Object.prototype.hasOwnProperty.call(en, key), `键名不动:${key} 仍在(只改值,不改键)`);
}

// zh-CN 零改动(36 号文 §2.10):本波不碰 zh-CN.json,这里读一次做记录性断言(键集不变才谈得上"零改动",
// 逐字节比较交给版本控制,这里只钉"键还在、这把锁不认为它被本波波及")。
const ZH_PATH = path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'locales', 'zh-CN.json');
const zh = JSON.parse(fs.readFileSync(ZH_PATH, 'utf8'));
ok(Object.keys(zh).length === Object.keys(en).length, 'zh-CN 与 en-US 键数仍相等(本波只改值不改键,不会打乱两份目录的键集对齐)');

console.log('\nI18N EN TERMS STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
