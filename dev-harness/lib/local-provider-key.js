'use strict';
// live 件专用:从【本机真实如意配置】里取某个端点的密钥与地址。
//
// 为什么要有它:真模型评测(`*-live.js`)需要真 key,而此前的取法是**命令行参数**
// (`node dev-harness/deepseek-ab-live.js <API_KEY>`)—— 那会让密钥出现在 shell 历史、
// 进程列表、以及任何一份贴出来的日志里。改成由脚本自己去读配置,密钥就只在进程内存里待着。
//
// 三条纪律,写死在这里:
//   ① **只读**。本模块不写、不建、不改任何配置文件 —— 用户的真配置不是测试夹具。
//   ② **绝不打印**。本模块自己一行 console 都没有;调用方要报告用了哪个端点,
//      用下面的 `describe()`(只给 id / host / 模型名 / 有没有 key,不含 key 本身)。
//   ③ **只给 live 件用**。`run-all.js` 只收 `.e2e.js`,live 件不进全量 ——
//      任何进全量的件都不许引用本模块(引用了就意味着全量会去读用户的真密钥)。
//
// 找配置的顺序与产品一致:显式环境变量 > 家目录 > LOCALAPPDATA > 旧版目录。
const fs = require('fs');
const os = require('os');
const path = require('path');

function candidateRoots() {
  return [
    process.env.RUYI_HOME,
    process.env.WIN_CLAUDE_WORKBENCH_HOME,
    path.join(os.homedir(), 'Ruyi'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Ruyi') : '',
    path.join(os.homedir(), '.win-claude-workbench'),
  ].filter(Boolean);
}

function readLocalConfig() {
  for (const root of candidateRoots()) {
    const file = path.join(root, 'config.json');
    try {
      if (!fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && Array.isArray(raw.providers)) return { config: raw, file };
    } catch { /* 坏文件就当没有,继续找下一个 —— 绝不尝试修它 */ }
  }
  return { config: null, file: '' };
}

// 取一个端点。providerId 缺省按 host 猜(给 deepseek 这类常见的省一次查)。
// 回 { ok, id, label, host, apiKey, baseUrl, models, file } 或 { ok:false, why }。
// **apiKey 在返回值里,调用方自己负责别打印它。**
function localProvider(providerId, opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const { config, file } = readLocalConfig();
  if (!config) return { ok: false, why: '本机找不到如意配置(config.json)——先在工作台里配一个端点' };
  const wantHost = String(o.host || '').toLowerCase();
  const list = config.providers.filter(p => p && p.apiKey && String(p.apiKey).trim());
  const hit = list.find(p => providerId && p.id === providerId)
    || (wantHost ? list.find(p => { try { return new URL(p.baseUrl || '').host.toLowerCase().includes(wantHost); } catch { return false; } }) : null);
  if (!hit) {
    const seen = list.map(p => p.id).join(', ');
    return { ok: false, why: `本机配置里没有【配了密钥的】端点 "${providerId || wantHost}"(现有:${seen || '一个都没有'})` };
  }
  let host = '';
  try { host = new URL(hit.baseUrl || '').host; } catch { host = ''; }
  return {
    ok: true,
    id: hit.id,
    label: String(hit.label || hit.id),
    host,
    apiKey: String(hit.apiKey),
    baseUrl: String(hit.baseUrl || ''),
    models: (Array.isArray(hit.models) ? hit.models : []).map(m => String((m && m.id) || '')).filter(Boolean),
    file,
  };
}

// 给日志用的一行人话。**保证不含密钥**:只有 id / 标签 / host / 模型数 / 有没有 key。
function describe(found) {
  if (!found || !found.ok) return `(取不到端点:${(found && found.why) || '未知'})`;
  return `端点 ${found.id}「${found.label}」@ ${found.host} · ${found.models.length} 个模型 · 密钥已配`;
}

module.exports = { localProvider, describe, readLocalConfig };
