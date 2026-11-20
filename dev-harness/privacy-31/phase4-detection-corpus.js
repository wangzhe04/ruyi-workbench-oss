'use strict';
// Synthetic equivalents of the 3.1 walkthrough false positives and false negatives (150 号文 §4 P12/P13/P17).
// Every number and key-shaped string is assembled from fixture digits at runtime; none is a real account.
function luhnComplete(prefix) {
  // Append the check digit that makes prefix + digit pass Luhn.
  for (let check = 0; check < 10; check++) {
    const digits = prefix + check;
    let sum = 0, twice = false;
    for (let i = digits.length - 1; i >= 0; i--, twice = !twice) { let n = Number(digits[i]); if (twice) { n *= 2; if (n > 9) n -= 9; } sum += n; }
    if (sum % 10 === 0) return digits;
  }
  throw new Error('unreachable');
}
const group = (digits, size = 4, sep = ' ') => digits.match(new RegExp('.{1,' + size + '}', 'g')).join(sep);
const fullWidth = text => text.replace(/[0-9A-Za-z@.]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xfee0));

function createPhase4Corpus() {
  // tier: basic (always on), personal (enhanced), technical (technical switch). visible: text after the
  // value that must stay outside every match (the value ends where it should).
  const cases = [], add = (id, tier, sample, secret, visible) => cases.push({ id, tier, sample, secret, ...(visible ? { visible } : {}) });
  // P13: mobile numbers grouped with spaces or hyphens, without a phone label.
  add('mobile-spaced-bare', 'personal', '有事打 138 0013 8000，我晚上在', '138 0013 8000', '，我晚上在');
  add('mobile-dashed-bare', 'personal', '换成 139-0000-0123 了', '139-0000-0123', ' 了');
  add('mobile-plus86-spaced', 'personal', 'WhatsApp +86 186 1122 4455 也行', '+86 186 1122 4455', ' 也行');
  // P13: full-width digits, zero-width characters and a full-width at-sign.
  add('mobile-full-width-bare', 'personal', '新号' + fullWidth('13800138000') + '，存一下', fullWidth('13800138000'), '，存一下');
  add('mobile-zero-width', 'personal', 'call 138\u200b0013\u200b8000 later', '138\u200b0013\u200b8000', ' later');
  add('email-zero-width', 'personal', '发到 zhang\u200bsan.fixture@example.test 吧', 'zhang\u200bsan.fixture@example.test', ' 吧');
  add('email-full-width-at', 'personal', '邮箱 zhangsan.fixture＠example.test 收', 'zhangsan.fixture＠example.test', ' 收');
  add('email-full-width-all', 'personal', '联系 ' + fullWidth('ops.fixture@example.test') + ' 即可', fullWidth('ops.fixture@example.test'), ' 即可');
  add('provider-key-zero-width', 'basic', 'key sk-Synthetic\u200bFixtureOnly0123456789 end', 'sk-Synthetic\u200bFixtureOnly0123456789', ' end');
  add('provider-key-soft-hyphen', 'basic', 'key sk-Synthetic\u00adFixtureOnly0123456789 end', 'sk-Synthetic\u00adFixtureOnly0123456789', ' end');
  // P13: unlabelled card numbers (Luhn plus a card-network prefix), grouped or contiguous.
  const visa = luhnComplete('453914880343646'), unionPay = luhnComplete('622202123456789012'), master = luhnComplete('545454545454545');
  add('card-grouped-bare', 'personal', '退款请打到 ' + group(visa) + ' 这张', group(visa), ' 这张');
  add('card-dashed-bare', 'personal', 'card on file ' + group(master, 4, '-') + ', thanks', group(master, 4, '-'), ', thanks');
  add('card-contiguous-bare', 'personal', '用这张：' + unionPay + '。', unionPay, '。');
  // P13: IPv6 under the technical switch, like the IPv4 rule (unique-local, link-local, labelled).
  add('ipv6-unique-local', 'technical', '内网服务 fd12:3456:789a::1 挂了', 'fd12:3456:789a::1', ' 挂了');
  add('ipv6-link-local', 'technical', '网卡地址 fe80::1ff:fe23:4567:890a 不通', 'fe80::1ff:fe23:4567:890a', ' 不通');
  add('ipv6-labelled', 'technical', 'client_ip: 2001:db8::8a2e:370:7334 被拦', '2001:db8::8a2e:370:7334', ' 被拦');
  // P17: a bare field value ends at full-width punctuation instead of swallowing the sentence.
  add('bare-field-full-width-comma', 'basic', 'password=Synth3ticPass，然后重启服务', 'Synth3ticPass', '，然后重启服务');
  add('bare-field-full-width-period', 'basic', 'token=Synth3ticTok。下一步', 'Synth3ticTok', '。下一步');
  // P12 neighbours that must stay protected while the false positives below are removed.
  add('bank-branch-still-cjk', 'personal', '开户行：示例银行测试支行，账号另给', '示例银行测试支行', '，账号另给');
  add('account-bank-name-digits', 'personal', '收款账号：示例银行 6222 0210 0100 6677 889 请核对', '示例银行 6222 0210 0100 6677 889', ' 请核对');
  add('account-digits-then-prose', 'personal', '账号 6222021001006677 已冻结请处理', '6222021001006677', ' 已冻结请处理');
  add('labelled-phone-before-unit-word', 'personal', '手机 13800138000 个人用', '13800138000');
  // Review 4B-B1: a CJK unit character that starts a name or word is not a unit; bare phones stay protected.
  add('phone-before-name', 'personal', '李四 13900001111 张三', '13900001111');
  add('phone-glued-name', 'personal', '13800138000张先生', '13800138000');
  add('phone-before-ben-ren', 'personal', '13800138000 本人接听', '13800138000');
  add('phone-before-tian', 'personal', '13800138000 天天在线', '13800138000');
  add('phone-before-wei-yu', 'personal', '13800138000 位于北京', '13800138000');
  add('phone-before-ming-xia', 'personal', '13800138000 名下', '13800138000');
  add('grouped-phone-before-name', 'personal', '138-0013-8000 张三', '138-0013-8000');
  // Review 4B round 2: 共 inside a word is not a quantity label.
  add('phone-after-gong-gong', 'personal', '公共服务热线 13800138000', '13800138000');
  add('phone-after-gong-xiang', 'personal', '共享给你：13800138000', '13800138000');
  add('phone-after-gong-yong', 'personal', '我们共用 13800138000', '13800138000');
  add('phone-after-zhong-gong', 'personal', '中共党员 13800138000', '13800138000');
  // Review 4B v2: every phone version 6 caught after a price/amount/count word or before 元/人 stays caught.
  for (const [id, sample] of [['price-negotiable', '价格 面议 13800138000'], ['unit-price-ask', '单价请咨询13800138000'], ['sale-price', '售价 13800138000'],
    ['amount-ask-finance', '金额问题找财务 13800138000'], ['limited-quantity', '数量有限，速联13800138000'], ['amount-yuan', '金额：13800138000元'],
    ['count-colon', 'count: 13800138000'], ['phone-ren', '13800138000人'], ['price-ask', '价格咨询：13800138000'], ['phone-ming', '13800138000 名'],
    ['total-contact', 'Total contact 13800138000'], ['price-contact', '联系电话(价格咨询) 13800138000']]) add('v6-kept-' + id, 'personal', sample, '13800138000');
  // Review 4B v2: a bank name with a bracketed branch or a separator before the account digits.
  add('account-bank-bracket-ascii', 'personal', '收款账号：工商银行(北京)6222000011112222', '工商银行(北京)6222000011112222');
  add('account-bank-bracket-full', 'personal', '收款账号：中国工商银行（北京分行）6222 0000 1111 2222', '中国工商银行（北京分行）6222 0000 1111 2222');
  add('account-bank-middle-dot', 'personal', '账号：建行·6217000010001234567', '建行·6217000010001234567');
  add('account-bank-comma', 'personal', '收款账号：工商银行，6222000011112222', '工商银行，6222000011112222');
  add('account-name-card', 'personal', '账号：张三的工资卡 6222000011112222', '张三的工资卡 6222000011112222');
  // Review 4B v3: a hyphen, slash or colon between the bank name and the account digits.
  add('account-bank-hyphen', 'personal', '账号：工商银行-6222000011112222', '工商银行-6222000011112222');
  add('account-bank-slash', 'personal', '账号：工商银行/6222000011112222', '工商银行/6222000011112222');
  add('account-bank-colon', 'personal', '账号：工商银行：6222000011112222', '工商银行：6222000011112222');
  // Review 4B v2: a full-width comma inside a bare password is part of it.
  add('bare-field-inner-comma', 'basic', 'token=hun，ter2', 'hun，ter2');

  const negatives = [];
  const keep = (tier, sample) => negatives.push({ tier, sample });
  // P12: CJK prose after an account label is not a bank account.
  keep('personal', '账号登录后在个人中心修改昵称，再到设置页绑定手机就可以了，记得先退出旧设备上的登录状态');
  keep('personal', '收款账号写公司对公户就行，财务会核对');
  keep('personal', '账号：请联系管理员开通');
  // P12: placeholders after credential labels.
  keep('basic', 'token: none');
  keep('basic', 'api_key = TODO');
  // P12: phone-shaped counts and amounts.
  keep('personal', '库存 13800138000 件');
  keep('personal', '本月共 13912345678 次请求');
  keep('personal', '数量：15800000000，单位箱');
  keep('personal', 'total 13800138000 items processed');
  // P13 neighbours: business numbers, grouped prose numbers, versions and timestamps stay visible.
  keep('personal', '业务编号 158 0123 4567 8');
  keep('personal', '订单号 ' + luhnComplete('453914880343646'));
  keep('personal', 'IMEI ' + luhnComplete('35693803564380'));
  keep('personal', '商品编号' + luhnComplete('694202688888'));
  keep('personal', '时间戳 1761024000123');
  keep('personal', '流水 ' + luhnComplete('62220212345678901'));
  keep('personal', '1234 5678 9012 3456');
  // Review 4B v3: trace/request/span ids, logistics numbers and order-number columns are not cards.
  keep('personal', 'trace_id=' + luhnComplete('453914880343646'));
  keep('personal', 'request-id: ' + luhnComplete('545454545454545'));
  keep('personal', 'span_id ' + luhnComplete('622202123456789012'));
  keep('personal', '物流 ' + luhnComplete('453914880343646'));
  keep('personal', '| 订单号 | 金额 |\n| ' + luhnComplete('453914880343646') + ' | 99 |');
  // Zero-width and full-width text that holds no value.
  keep('personal', '\ufeff普通文本，开头是字节序标记');
  keep('personal', '表情 👨\u200d👩\u200d👧 和软连字符 co\u00adoperate');
  keep('personal', '全角数字' + fullWidth('12345') + '和全角字母' + fullWidth('ABC'));
  // IPv6 look-alikes.
  keep('technical', '时间 12:30:45，C++ 的 std::vector 和 Foo::Bar');
  keep('technical', 'docker -p 8080:80 映射，回环 ::1 与 [::1]:3000');
  keep('technical', '文档地址 2001:db8::1 只是示例');
  return { cases, negatives };
}
module.exports = { createPhase4Corpus, luhnComplete };
