'use strict';
// E2E: OpenAI 兼容 provider 的自定义请求头 (extraHeaders)。
// 后端 sanitizeProvider 已支持 extraHeaders;本轮补齐前端编辑入口 + 敏感头掩码(与 apiKey 同纪律)。
// 这里只测纯函数掩码往返(确定性,无网络):敏感头下发掩码、保存时还原、非敏感头明文往返、用户改值直通。
const { maskSecrets, unmaskSecrets } = require('../ruyi-workbench/app/server.js');

let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };

const disk = { providers: [{
  id: 'custom', label: 'Custom', type: 'openai-compat', baseUrl: 'https://api.example.com',
  apiKey: 'sk-secretkey12345',
  extraHeaders: {
    Authorization: 'Bearer tok_secret_9999',  // 敏感:掩码
    'X-API-Key': 'abcdef123456',              // 敏感:掩码
    'X-Organization': 'org-123',              // 非敏感:明文
    'X-Track-Token': 'track-abc',             // 敏感(token):掩码
  },
}] };

// 1) 下发掩码:敏感头值变 ••••末4,非敏感头明文不变;apiKey 仍掩码。
const masked = maskSecrets(disk);
const mh = masked.providers[0].extraHeaders;
ok(mh.Authorization === '••••9999', 'sensitive Authorization header is masked on the way out');
ok(mh['X-API-Key'] === '••••3456', 'sensitive X-API-Key header is masked');
ok(mh['X-Track-Token'] === '••••-abc' || mh['X-Track-Token'] === '••••k-abc' || mh['X-Track-Token'].startsWith('••••'), 'token-named header is masked');
ok(mh['X-Organization'] === 'org-123', 'non-sensitive header stays plaintext in the response');
ok(masked.providers[0].apiKey === '••••2345', 'apiKey masking still works alongside header masking');
ok(!masked.providers[0].extraHeaders.Authorization.includes('tok_secret'), 'masked response does not leak the real token value');

// 2) 保存往返:用户没改这些头(仍是掩码) -> 从磁盘还原真实值。
const echoedBack = { providers: [{ ...masked.providers[0] }] };
const unmasked = unmaskSecrets(echoedBack, disk);
const uh = unmasked.providers[0].extraHeaders;
ok(uh.Authorization === 'Bearer tok_secret_9999', 'untouched masked Authorization restored to real value on save');
ok(uh['X-API-Key'] === 'abcdef123456', 'untouched masked X-API-Key restored');
ok(uh['X-Organization'] === 'org-123', 'non-sensitive header round-trips unchanged');
ok(unmasked.providers[0].apiKey === 'sk-secretkey12345', 'apiKey restored alongside headers');

// 3) 用户改了某个敏感头(新值,非掩码前缀) -> 直通,不用磁盘旧值覆盖。
const edited = { providers: [{ ...masked.providers[0], extraHeaders: {
  ...mh, Authorization: 'Bearer brand-new-token-xyz',
} }] };
const unmasked2 = unmaskSecrets(edited, disk);
ok(unmasked2.providers[0].extraHeaders.Authorization === 'Bearer brand-new-token-xyz', 'user-edited sensitive header passes through (not overwritten by disk value)');
ok(unmasked2.providers[0].extraHeaders['X-API-Key'] === 'abcdef123456', 'other untouched headers still restored when one is edited');

// 4) 无 extraHeaders 的 provider 不报错(存量零回归)。
const noHeaders = maskSecrets({ providers: [{ id: 'plain', apiKey: 'sk-x' }] });
ok(noHeaders.providers[0].extraHeaders === undefined, 'provider without extraHeaders stays without the field');
const unmaskedNo = unmaskSecrets({ providers: [{ id: 'plain', apiKey: '••••sk-x' }] }, { providers: [{ id: 'plain', apiKey: 'real-key-9999' }] });
ok(unmaskedNo.providers[0].apiKey === 'real-key-9999', 'apiKey unmask still works for a provider with no extraHeaders');

console.log('\nPROVIDER CUSTOM HEADERS E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
process.exitCode = failures ? 1 : 0;
