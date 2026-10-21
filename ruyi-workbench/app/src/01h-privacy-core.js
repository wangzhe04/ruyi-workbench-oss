// 81-P0: Pure privacy primitives. Not wired to requests or storage yet; see design 81 and ledger 82.
// Host policies are mandatory for restoration. This module never grants tool permission or performs I/O.
const PrivacyCore = ((cryptoApi, ruleCatalog) => {
  const LIMITS = Object.freeze({ bytes: 1024 * 1024, matches: 10000, mappings: 10000, mappingBytes: 1024 * 1024,
    learnedComparisons: 32 * 1024 * 1024, rules: 200, literal: 4096 });
  const TYPES = new Set(['CREDENTIAL', 'EMAIL', 'PHONE', 'IDENTITY', 'PAYMENT', 'INTERNAL', 'PATH']);
  const PREFIX = '[[RUYI_PVT:';
  const opaqueIntervals = Symbol('validated privacy reference intervals');
  const lexicalJsonSource = Symbol('JSON source matching provenance');
  const decodedSource = Symbol('one-level encoded privacy discovery');
  const insideOpaque = (start, end, intervals = []) => {
    let low = 0, high = intervals.length - 1, candidate = -1;
    while (low <= high) { const mid = (low + high) >>> 1; if (intervals[mid].start <= start) { candidate = mid; low = mid + 1; } else high = mid - 1; }
    // A full-reference value may itself be classified by an outer password/authorization
    // field. Only matches strictly within its opaque spelling are incidental token data.
    return candidate >= 0 && end <= intervals[candidate].end
      && (start > intervals[candidate].start || end < intervals[candidate].end);
  };
  const tokenPattern = () => /\[\[RUYI_PVT:([A-Z]+):([a-f0-9]{32})\]\]/g;
  const fail = code => { throw Object.assign(new Error('privacy.' + code), { code: 'privacy.' + code }); };
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  function checkText(value, max = LIMITS.bytes) {
    if (typeof value !== 'string') fail('text_required');
    if (Buffer.byteLength(value, 'utf8') > max) fail('text_limit');
    return value;
  }
  function category(value) { if (!TYPES.has(value)) fail('category_invalid'); return value; }
  const budgets = new WeakMap();
  function createMatchBudget(comparisons = LIMITS.learnedComparisons, matches = LIMITS.matches) {
    if (!Number.isSafeInteger(comparisons) || comparisons < 1 || comparisons > LIMITS.learnedComparisons
      || !Number.isSafeInteger(matches) || matches < 1 || matches > LIMITS.matches) fail('scan_budget_invalid');
    const budget = Object.freeze({}); budgets.set(budget, { comparisons, matches }); return budget;
  }
  function spend(budget, kind, amount = 1) {
    const state = budgets.get(budget);
    if (!state || !Number.isSafeInteger(amount) || amount < 0) fail('scan_budget_invalid');
    if (state[kind] < amount) fail('learned_scan_limit');
    state[kind] -= amount;
  }
  const stricter = (a, b) => a === 'CREDENTIAL' || b === 'CREDENTIAL' ? 'CREDENTIAL' : a === b ? a : 'INTERNAL';
  function mergeMatches(found) {
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const item of found) {
      const previous = merged[merged.length - 1];
      if (previous && item.start < previous.end) {
        previous.end = Math.max(previous.end, item.end);
        previous.category = stricter(previous.category, item.category);
        previous.ruleIds = [...new Set([...previous.ruleIds, ...item.ruleIds])];
      } else merged.push({ ...item, ruleIds: [...item.ruleIds] });
    }
    return merged;
  }
  function identity(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(value)) fail('identity_invalid');
    return value;
  }
  function isIdentityNumber(value) {
    value = value.toUpperCase();
    if (!/^[1-9]\d{16}[\dX]$/.test(value)) return false;
    const y = Number(value.slice(6, 10)), m = Number(value.slice(10, 12)), d = Number(value.slice(12, 14));
    const date = new Date(Date.UTC(y, m - 1, d));
    if (y < 1800 || y > 2199 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
    const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    return '10X98765432'[weights.reduce((sum, weight, i) => sum + weight * Number(value[i]), 0) % 11] === value[17];
  }
  function luhn(value) {
    const digits = value.replace(/[ -]/g, '');
    if (!/^\d{13,19}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
    let sum = 0, twice = false;
    for (let i = digits.length - 1; i >= 0; i--, twice = !twice) {
      let n = Number(digits[i]); if (twice) { n *= 2; if (n > 9) n -= 9; } sum += n;
    }
    return sum % 10 === 0;
  }
  function createDetector(options = {}) {
    // Custom regex source is schema-checked here; execution is supplied by the isolated worker adapter.
    if (own(options, 'patterns')) fail('regex_worker_required');
    const personal = options.personal === true;
    if (options.ruleOverrides !== undefined && (!options.ruleOverrides || typeof options.ruleOverrides !== 'object' || Array.isArray(options.ruleOverrides))) fail('rule_override_invalid');
    const catalogOptions = Object.freeze({ personal, technical: options.technical === true, confidential: options.confidential === true,
      ruleOverrides: Object.freeze({ ...(options.ruleOverrides || {}) }) });
    if (ruleCatalog) ruleCatalog.scan('', catalogOptions, () => {});
    const rules = [];
    const inputRules = options.rules === undefined ? [] : options.rules;
    const known = options.knownSecrets === undefined ? [] : options.knownSecrets;
    if (!Array.isArray(inputRules) || !Array.isArray(known) || inputRules.length + known.length > LIMITS.rules) fail('rules_limit');
    const ids = new Set();
    for (const input of inputRules) {
      if (!input || !['literal', 'field', 'regex'].includes(input.kind)) fail('rule_kind');
      const id = identity(input.id); if (ids.has(id)) fail('rule_duplicate'); ids.add(id);
      const type = category(input.category);
      const match = checkText(input.value, LIMITS.literal); if (!match.length) fail('rule_empty');
      if (input.kind === 'regex' && (match.length > 1024 || (input.flags !== undefined && typeof input.flags !== 'string') || !/^[gimsu]*$/.test(input.flags || '') || new Set(input.flags || '').size !== (input.flags || '').length)) fail('regex_invalid');
      if (input.kind === 'field' && (!match.startsWith('/') || /~(?![01])/.test(match))) fail('field_invalid');
      rules.push(Object.freeze({ id, kind: input.kind, value: match, category: type, flags: input.flags || '' }));
    }
    for (let i = 0; i < known.length; i++) {
      const value = checkText(known[i], LIMITS.bytes); if (!value) fail('rule_empty');
      rules.push(Object.freeze({ id: 'known-' + i, kind: 'literal', value, category: 'CREDENTIAL' }));
    }
    function detect(input, context = {}) {
      const privacyText = checkText(input), found = [];
      const add = (start, end, type, ruleId) => {
        if (start === end) return;
        if (insideOpaque(start, end, context[opaqueIntervals])) return;
        if (found.length >= LIMITS.matches) fail('matches_limit');
        found.push({ start, end, category: type, ruleIds: [ruleId] });
      };
      const scan = (regex, type, id, capture = 0, valid = () => true) => {
        for (const m of privacyText.matchAll(regex)) {
          const value = m[capture];
          if (value && valid(value, m.index + (capture ? m[0].lastIndexOf(value) : 0))) { const at = m.index + (capture ? m[0].lastIndexOf(value) : 0); add(at, at + value.length, type, id); }
        }
      };
      for (const rule of context[lexicalJsonSource] === 'automatic' ? [] : rules) {
        if (rule.kind === 'regex') continue;
        if (rule.kind === 'field') {
          if (context.pointer === rule.value) add(0, privacyText.length, rule.category, rule.id);
          continue;
        }
        let from = 0;
        while (from < privacyText.length) {
          const at = privacyText.indexOf(rule.value, from); if (at < 0) break;
          add(at, at + rule.value.length, rule.category, rule.id); from = at + 1;
        }
      }
      if (context[decodedSource] !== true && context[lexicalJsonSource] !== 'automatic' && rules.some(rule => rule.kind === 'regex')) {
        if (typeof options.regexMatches !== 'function') fail('regex_worker_required');
        for (const item of options.regexMatches(privacyText)) {
          if (!Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) || item.start < 0 || item.end > privacyText.length || item.start >= item.end || !Array.isArray(item.ruleIds)) fail('regex_result_invalid');
          category(item.category); add(item.start, item.end, item.category, item.ruleIds[0]);
        }
      }
      // Whole JSON spelling has escape syntax that is not part of any decoded value.
      // Keep explicit and automatic evidence separate for the lexical structural guard;
      // the host may defer only same-value automatic matches to decoded leaf evidence.
      if (context[lexicalJsonSource] === 'explicit') return mergeMatches(found);
      const field = typeof context.pointer === 'string' ? context.pointer.split('/').pop().replace(/~1/g, '/').replace(/~0/g, '~') : '';
      if (/^(?:[A-Za-z0-9_-]{0,128})(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token|pwd|_pass)$/i.test(field)) {
        add(0, privacyText.length, 'CREDENTIAL', 'builtin.structured-field');
      }
      scan(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9][A-Za-z0-9_-]{15,}(?![A-Za-z0-9_-])/g, 'CREDENTIAL', 'builtin.provider-key');
      scan(/(?<![A-Za-z0-9_-])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})(?![A-Za-z0-9_-])/g, 'CREDENTIAL', 'builtin.platform-token');
      // PEM is handled with delimiters, not an unbounded multi-line backtracking regex.
      const pem = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g;
      for (const m of privacyText.matchAll(pem)) {
        const endMarker = m[0].replace('BEGIN', 'END'), end = privacyText.indexOf(endMarker, m.index + m[0].length);
        add(m.index, end < 0 ? privacyText.length : end + endMarker.length, 'CREDENTIAL', 'builtin.private-key');
      }
      scan(/\b(?:Bearer|Basic)\s+([^\s"'<>]{4,})/gi, 'CREDENTIAL', 'builtin.authorization', 1);
      for (const match of privacyText.matchAll(/(?:^|[\r\n])[ \t]*(?:Authorization|Proxy-Authorization)[ \t]*:[ \t]*([^\r\n]*(?:\r?\n[ \t]+[^\r\n]+)*)/gi)) {
        let value = match[1].trim();
        // HTTP authentication schemes and header padding are syntax, not secret values.
        // Preserve all actual authentication parameters, including folded continuation lines.
        const scheme = /^[!#$%&'*+.^_`|~A-Za-z0-9-]+[ \t\r\n]+/.exec(value);
        if (scheme) value = value.slice(scheme[0].length).trim();
        if (!value || /^(?:Bearer|Basic|Digest|ApiKey|Token|Negotiate)$/i.test(value)) continue;
        const at = match.index + match[0].lastIndexOf(value);
        add(at, at + value.length, 'CREDENTIAL', 'builtin.authorization-header');
      }
      scan(/\beyJ[A-Za-z0-9_-]+\.[ \t]*(?:\r?\n[ \t]*)?[A-Za-z0-9_-]+\.[ \t]*(?:\r?\n[ \t]*)?[A-Za-z0-9_-]+\b/g, 'CREDENTIAL', 'builtin.jwt');
      scan(/(?:^|[\r\n])[ \t]*(?:Cookie|Set-Cookie)[ \t]*:[ \t]*([^\r\n]+)/gi, 'CREDENTIAL', 'builtin.cookie', 1, value => /\S/.test(value));
      // JSON wrapper spelling cannot form userinfo across quotes or escapes. Actual
      // decoded string values retain the full raw URL rule, including apostrophes.
      scan(context[lexicalJsonSource] === 'automatic'
        ? /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:@/"\\<>]{1,256}:([^\s@/"\\<>]{1,4096})@/gi
        : /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:@/]{1,256}:([^\s@/]{1,4096})@/gi, 'CREDENTIAL', 'builtin.url-password', 1);
      scan(/[?&](?:access_token|api_key|apikey|token|signature|x-amz-signature|x-amz-credential)=([^&#\s"']+)/gi, 'CREDENTIAL', 'builtin.signed-url', 1);
      // Match field names exactly at their suffix. maxTokens/tokenCount stay intact.
      scan(/(?:^|[\s{,;])(?:["']?)(?:[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token|pwd|_pass))["']?\s*[:=]\s*"([^"\r\n]+)"/gi, 'CREDENTIAL', 'builtin.quoted-field', 1);
      scan(/(?:^|[\s{,;])(?:["']?)(?:[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token|pwd|_pass))["']?\s*[:=]\s*'([^'\r\n]+)'/gi, 'CREDENTIAL', 'builtin.single-field', 1);
      scan(/(?:^|[\s{,;])(?:[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token|pwd|_pass))\s*[:=]\s*([^\s"'{}\[\],;&|]+)/gi, 'CREDENTIAL', 'builtin.bare-field', 1);
      scan(/(?:API[ _-]?密钥|访问(?:令牌|密钥)|刷新令牌|密码|口令|密钥|令牌)["']?[ \t]*(?:是|为|[:=：])[ \t]*(?:[:=：][ \t]*)?["“]([^"”\r\n]+)["”]/gi, 'CREDENTIAL', 'builtin.cn-secret-double', 1);
      scan(/(?:API[ _-]?密钥|访问(?:令牌|密钥)|刷新令牌|密码|口令|密钥|令牌)["']?[ \t]*(?:是|为|[:=：])[ \t]*(?:[:=：][ \t]*)?['‘]([^'’\r\n]+)['’]/gi, 'CREDENTIAL', 'builtin.cn-secret-single', 1);
      scan(/(?:API[ _-]?密钥|访问(?:令牌|密钥)|刷新令牌|密码|口令|密钥|令牌)["']?[ \t]*(?:是|为|[:=：])[ \t]*(?:[:=：][ \t]*)?([^\s"'“”‘’{}\[\],，;；&|<>]+)/gi, 'CREDENTIAL', 'builtin.cn-secret-bare', 1);
      scan(/(?:^|\s)--?(?:password|passwd|token|secret|api-key)\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"';&|]+))/gi, 'CREDENTIAL', 'builtin.cli-secret-double', 1);
      scan(/(?:^|\s)--?(?:password|passwd|token|secret|api-key)\s+'([^'\r\n]+)'/gi, 'CREDENTIAL', 'builtin.cli-secret-single', 1);
      scan(/(?:^|\s)--?(?:password|passwd|token|secret|api-key)\s+([^\s"';&|]+)/gi, 'CREDENTIAL', 'builtin.cli-secret', 1);
      if (personal) {
        scan(/\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?\.[A-Za-z]{2,63}\b/g, 'EMAIL', 'builtin.email', 0, value => !ruleCatalog?.alreadyMasked?.(value, 'EMAIL'));
        // A phone-shaped value in an explicitly named business identifier is not
        // phone evidence. This affects automatic discovery only: custom rules and
        // already learned private values still protect their exact duplicates.
        const businessField = /^(?:order[_ -]?(?:id|no|number)|tracking[_ -]?(?:id|no|number)|订单(?:号|编号)?|运单(?:号|编号)?|快递单号?|流水号?|计数|条码|isbn|学号|发票(?:号码|号|代码)?|票号)$/i;
        const businessLabel = /(?:订单(?:号|编号)?|运单(?:号|编号)?|快递单号?|流水号?|计数|条码|ISBN|学号|发票(?:号码|号|代码)?|票号|\border[_ -]?(?:id|no|number)|\btracking[_ -]?(?:id|no|number))[ \t]*(?:是|为|is|[:：=])?[ \t]*[:：=]?[ \t]*$/i;
        const phoneEvidence = (value, at) => !businessField.test(field) && !businessLabel.test(privacyText.slice(Math.max(0, at - 80), at));
        scan(/(?<!\d)(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)/g, 'PHONE', 'builtin.cn-mobile', 0, phoneEvidence);
        // Preserve original spelling and coordinates; these are eleven-digit mobile
        // forms, never a blanket normalization of business numbers or ordinary prose.
        scan(/(?<![0-9０-９零〇一二三四五六七八九幺壹贰叁肆伍陆柒捌玖][ \t-]{0,3})[1１一幺壹][3-9３-９三四五六七八九叁肆伍陆柒捌玖](?:[ \t-]{0,3}[0-9０-９零〇一二三四五六七八九幺壹贰叁肆伍陆柒捌玖]){9}(?![ \t-]{0,3}[0-9０-９零〇一二三四五六七八九幺壹贰叁肆伍陆柒捌玖])/g, 'PHONE', 'builtin.cn-mobile', 0,
          (value, at) => {
            const lead = privacyText.slice(Math.max(0, at - 80), at);
            return /(?:手机|电话|紧急联系人|联系人|原号码|新号码|微信|报号|读法|\bphone\b|\bmobile\b|\btel\b)[^\r\n]{0,64}$/i.test(lead)
              && phoneEvidence(value, at);
          });
        scan(/手机号(?:码)?[^0-9\r\n:：]{0,24}[:：][ \t]*([1][3-9](?:[ \t/\r\n-]{0,5}[0-9]){9})(?![0-9])/g, 'PHONE', 'builtin.cn-mobile', 1);
        scan(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}[ \t]*(?:\[at\]|[ \t]at[ \t])[ \t]*[A-Za-z0-9-]{1,63}(?:(?:\.|[ \t]+dot[ \t]+)[A-Za-z0-9-]{1,63}){0,6}(?:\.|[ \t]+dot[ \t]+)[A-Za-z]{2,63}/gi, 'EMAIL', 'builtin.email', 0,
          (value, at) => /(?:邮箱|email)[^\r\n]{0,96}$/i.test(privacyText.slice(Math.max(0, at - 112), at)));
        scan(/(?<!\d)[1-9]\d{16}[\dX](?!\d)/gi, 'IDENTITY', 'builtin.cn-identity', 0, isIdentityNumber);
        // A strong identity label is privacy evidence even when the number is mistyped, old-format,
        // full-width or grouped. Validation is useful for bare-number false positives, not permission
        // to disclose labelled personal data. Keep original text coordinates and spelling intact.
        scan(/(?:居民)?身份证(?:号码|号)?["']?[ \t]*(?:[^0-9０-９\r\n:=：,，;；。!?？！"'“”]{1,24}[:=：][ \t]*)?(?:是|为|[:=：])?[ \t]*(?:[:=：][ \t]*)?["'“”]?([0-9０-９](?:[ \t\u00a0\u3000-]{0,3}[0-9０-９]){16}[ \t\u00a0\u3000-]{0,3}[0-9０-９XxＸｘ]|[0-9０-９](?:[ \t\u00a0\u3000-]{0,3}[0-9０-９]){14})(?![ \t\u00a0\u3000-]{0,3}[0-9０-９XxＸｘ])/g, 'IDENTITY', 'builtin.cn-identity-labelled', 1);
        scan(/(?:银行卡(?:号)?|卡号|card(?:\s*number)?|pan)["']?[ \t]*(?:是|为|[:=：])[ \t]*["'“”]?([\d][\d -]{11,}\d)(?!\d)/gi, 'PAYMENT', 'builtin.payment', 1);
        scan(/(?:居民)?身份证(?:号码|号)?[^0-9０-９\r\n:：]{0,24}[:：][ \t]*([1-9１-９](?:[ \t/\r\n-]{0,5}[0-9０-９]){16}[ \t/\r\n-]{0,5}[0-9０-９XxＸｘ])(?![0-9０-９XxＸｘ])/g, 'IDENTITY', 'builtin.cn-identity-labelled', 1);
      }
      if (ruleCatalog) ruleCatalog.scan(privacyText, { ...catalogOptions, pointer: context.pointer }, add);

      // Common one-level text encodings only. Decode for detection, preserve the original
      // bytes for authorized tools, and never recurse or run user regex on decoded data.
      // Public documentation/base64 blobs are not secrets merely because they are encoded.
      if (context[decodedSource] !== true && context[lexicalJsonSource] !== 'automatic') {
        let candidates = 0, decodedBytes = 0;
        const inspectEncoded = (value, at, encoding) => {
          if (value.length < 12 || value.length > 8192 || candidates >= 64 || decodedBytes >= 65536) return;
          let decoded;
          try {
            if (encoding === 'uri') {
              if (!value.includes('%') || /%(?![0-9a-f]{2})/i.test(value)) return;
              decoded = decodeURIComponent(value);
            } else {
              if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return;
              const bytes = Buffer.from(value, 'base64');
              if (bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) return;
              decoded = bytes.toString('utf8');
              if (!Buffer.from(decoded, 'utf8').equals(bytes)) return;
            }
          } catch { return; }
          if (!decoded || decoded === value || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(decoded) || decoded.includes(PREFIX)) return;
          candidates++; decodedBytes += Buffer.byteLength(decoded, 'utf8');
          if (decodedBytes > 65536) return;
          const matches = detect(decoded, { ...context, [decodedSource]: true, [opaqueIntervals]: undefined });
          // Only a fully recognized value qualifies. Unrelated decoded prose never
          // inherits surrounding PII.
          const complete = matches.find(match => match.start === 0 && match.end === decoded.length);
          if (complete) add(at, at + value.length, complete.category, 'builtin.encoded-' + encoding);
        };
        for (const m of privacyText.matchAll(/[A-Za-z0-9+/]+={0,2}/g)) inspectEncoded(m[0], m.index, 'base64');
        for (const m of privacyText.matchAll(/[A-Za-z0-9_~+./%:-]+/g)) inspectEncoded(m[0], m.index, 'uri');
      }

      // Interval union avoids exposing an overlapping secret's suffix. Credential classification wins.
      return mergeMatches(found);
    }
    return Object.freeze({ detect });
  }
  function createScope(options) {
    const scopeId = identity(options.scopeId), detector = options.detector;
    if (!detector || typeof detector.detect !== 'function') fail('detector_required');
    const clock = options.clock || Date.now;
    const ttl = options.ttlMs === undefined ? 24 * 60 * 60 * 1000 : options.ttlMs;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 365 * 24 * 60 * 60 * 1000) fail('ttl_invalid');
    const entries = new Map(), byValue = new Map(), revokedValues = new Set(), aliases = new Map(), prefixes = new Map();
    let valueBytes = 0, revision = 0;
    function entryFor(token) {
      const entry = entries.get(token); if (!entry) fail('reference_unknown');
      const group = aliases.get(entry.value);
      if (group?.revoked) fail('reference_revoked');
      if (Math.min(entry.expiresAt, group?.expiresAt ?? Infinity) <= clock()) fail('reference_expired');
      return entry;
    }
    function issue(value, type, budget) {
      if (value.includes(PREFIX)) fail('reserved_literal');
      if (value && !/\S/.test(value)) fail('whitespace_sensitive');
      if (revokedValues.has(value)) fail('reference_revoked');
      const old = byValue.get(value);
      if (old) {
        const entry = entryFor(old);
        const next = stricter(entry.category, type), group = aliases.get(value);
        if (entry.category !== next) {
          if (group) { if (budget) spend(budget, 'comparisons', group.members.size); for (const member of group.members) entries.get(byValue.get(member)).category = next; }
          else entry.category = next;
          revision++;
        }
        return old;
      }
      if (!value) fail('rule_empty');
      const bytes = Buffer.byteLength(value, 'utf8');
      if (entries.size + revokedValues.size >= LIMITS.mappings || valueBytes + bytes > LIMITS.mappingBytes) fail('mapping_limit');
      let token;
      do { token = PREFIX + category(type) + ':' + cryptoApi.randomBytes(16).toString('hex') + ']]'; } while (entries.has(token));
      entries.set(token, { value, category: type, expiresAt: clock() + ttl }); byValue.set(value, token);
      valueBytes += bytes; revision++;
      return token;
    }
    function linkAliases(a, b, budget) {
      if (a === b || aliases.get(a) && aliases.get(a) === aliases.get(b)) return;
      const members = new Set([...(aliases.get(a)?.members || [a]), ...(aliases.get(b)?.members || [b])]);
      spend(budget, 'comparisons', members.size);
      let type, expiresAt = Infinity;
      for (const member of members) {
        const entry = entryFor(byValue.get(member));
        type = type === undefined ? entry.category : stricter(type, entry.category); expiresAt = Math.min(expiresAt, entry.expiresAt);
      }
      const group = { members, expiresAt, revoked: false };
      for (const member of members) { aliases.set(member, group); entries.get(byValue.get(member)).category = type; }
      revision++;
    }
    function protectAlias(value, decoded, type, context = {}) {
      checkText(value); checkText(decoded); category(type);
      const budget = context.budget === undefined ? createMatchBudget() : context.budget;
      const values = new Set([value, decoded]); let count = 0, bytes = 0;
      for (const item of values) {
        if (!item) fail('rule_empty'); if (!/\S/.test(item)) fail('whitespace_sensitive'); if (item.includes(PREFIX)) fail('reserved_literal');
        if (revokedValues.has(item)) fail('reference_revoked');
        if (byValue.has(item)) entryFor(byValue.get(item));
        else { count++; bytes += Buffer.byteLength(item, 'utf8'); }
      }
      if (entries.size + revokedValues.size + count > LIMITS.mappings || valueBytes + bytes > LIMITS.mappingBytes) fail('mapping_limit');
      // Reserve all potential category propagation and linking work before issuing either
      // representation. A failed budget must not leave two unlinked, differently trusted values.
      const members = new Set([...(aliases.get(value)?.members || [value]), ...(aliases.get(decoded)?.members || [decoded])]);
      const reserved = members.size * 3 + 2;
      spend(budget, 'comparisons', reserved);
      const localBudget = createMatchBudget(reserved);
      issue(decoded, type, localBudget); const token = issue(value, type, localBudget);
      linkAliases(value, decoded, localBudget); return token;
    }
    // KMP bounds both prefix construction and matching by actual character comparisons.
    // The budget belongs to the entire host transform, rather than each leaf or pass.
    function eachExact(input, needle, budget, found) {
      spend(budget, 'comparisons');
      if (needle.length > input.length) return;
      let prefix = prefixes.get(needle);
      if (!prefix) {
        prefix = new Uint32Array(needle.length);
        for (let i = 1, j = 0; i < needle.length; i++) {
          let equal = false;
          while (j > 0) { spend(budget, 'comparisons'); equal = needle[i] === needle[j]; if (equal) break; j = prefix[j - 1]; }
          if (j === 0) { spend(budget, 'comparisons'); equal = needle[i] === needle[j]; }
          if (equal) j++;
          prefix[i] = j;
        }
        prefixes.set(needle, prefix);
      }
      for (let i = 0, j = 0; i < input.length; i++) {
        let equal = false;
        while (j > 0) { spend(budget, 'comparisons'); equal = input[i] === needle[j]; if (equal) break; j = prefix[j - 1]; }
        if (j === 0) { spend(budget, 'comparisons'); equal = input[i] === needle[j]; }
        if (equal) j++;
        if (j === needle.length) { spend(budget, 'matches'); found(i - needle.length + 1, i + 1); j = prefix[j - 1]; }
      }
    }
    function appendLearned(privacyText, budget, found, intervals) {
      const embeddedShortNumber = (value, start, end) => /^[0-9]{1,6}$/.test(value)
        && (/[\p{L}\p{N}_.-]/u.test(privacyText[start - 1] || '') || /[\p{L}\p{N}_.-]/u.test(privacyText[end] || ''));
      for (const [token, entry] of entries) {
        // Legacy whitespace mappings still resolve their issued tokens, but must never
        // turn every unrelated formatting space into a newly learned secret.
        if (!/\S/.test(entry.value)) continue;
        eachExact(privacyText, entry.value, budget, (start, end) => {
          if (insideOpaque(start, end, intervals)) return;
          if (embeddedShortNumber(entry.value, start, end)) return;
          if (entry.category === 'PHONE' && (/[0-9０-９零〇一二三四五六七八九幺壹贰叁肆伍陆柒捌玖]/.test(privacyText[start - 1] || '') || /[0-9０-９零〇一二三四五六七八九幺壹贰叁肆伍陆柒捌玖]/.test(privacyText[end] || ''))) return;
          const current = entryFor(token);
          found.push({ start, end, category: current.category, ruleIds: ['scope.learned-exact'] });
        });
      }
      for (const value of revokedValues) if (/\S/.test(value)) eachExact(privacyText, value, budget, (start, end) => {
        if (!insideOpaque(start, end, intervals) && !embeddedShortNumber(value, start, end)) fail('reference_revoked');
      });
      return mergeMatches(found);
    }
    function detectLearned(privacyText, context = {}) {
      checkText(privacyText);
      const budget = context.budget === undefined ? createMatchBudget() : context.budget;
      spend(budget, 'comparisons', 0);
      return appendLearned(privacyText, budget, []);
    }
    function detect(privacyText, context = {}) {
      checkText(privacyText);
      const budget = context.budget === undefined ? createMatchBudget() : context.budget;
      spend(budget, 'comparisons', 0);
      let intervals;
      if (context.opaqueReferences === true) {
        validateProtected(privacyText);
        intervals = [...privacyText.matchAll(tokenPattern())].map(match => ({ start: match.index, end: match.index + match[0].length }));
      }
      const mode = context.lexicalJsonSource === true ? 'explicit' : context.automaticJsonSource === true ? 'automatic' : undefined;
      const found = detector.detect(privacyText, { ...context, [opaqueIntervals]: intervals, [lexicalJsonSource]: mode });
      spend(budget, 'matches', found.length);
      return mode === 'automatic' ? found : appendLearned(privacyText, budget, found, intervals);
    }
    function protectRaw(privacyText, context = {}) {
      checkText(privacyText);
      // Raw inputs cannot impersonate issued references. Structured provenance is added at gateway integration.
      if (privacyText.includes(PREFIX)) fail('reserved_literal');
      const budget = context.budget === undefined ? createMatchBudget() : context.budget;
      const matches = detect(privacyText, { ...context, budget });
      let from = 0, output = '';
      for (const match of matches) {
        output += privacyText.slice(from, match.start) + issue(privacyText.slice(match.start, match.end), match.category, budget);
        from = match.end;
      }
      return { text: checkText(output + privacyText.slice(from)), matches: matches.map(({ start, end, category: type, ruleIds }) => ({ start, end, category: type, ruleIds })) };
    }
    function validateProtected(privacyText, context = {}) {
      checkText(privacyText);
      if (context.requiredCategory !== undefined && context.requiredCategory !== 'CREDENTIAL') fail('category_invalid');
      const remainder = privacyText.replace(tokenPattern(), token => {
        const entry = entryFor(token);
        if (context.requiredCategory === 'CREDENTIAL' && entry.category !== 'CREDENTIAL') fail('credential_context');
        return '';
      });
      if (remainder.includes(PREFIX)) fail('reference_malformed');
      return privacyText;
    }
    function restoreForTool(privacyText, context) {
      validateProtected(privacyText);
      if (!context || context.scopeId !== scopeId) fail('scope_mismatch');
      identity(context.tool);
      if (typeof context.pointer !== 'string' || !context.pointer.startsWith('/')) fail('field_invalid');
      // The host authorizer binds tool, pointer, destination and purpose. A boolean field cannot grant access.
      if (typeof context.authorize !== 'function') fail('policy_required');
      const references = [...privacyText.matchAll(tokenPattern())];
      let outputBytes = Buffer.byteLength(privacyText, 'utf8');
      for (const match of references) {
        const entry = entryFor(match[0]);
        outputBytes += Buffer.byteLength(entry.value, 'utf8') - Buffer.byteLength(match[0], 'utf8');
        if (outputBytes > LIMITS.bytes) fail('text_limit');
        const embedded = match[0] !== privacyText;
        const permitted = context.authorize(Object.freeze({ scopeId, tool: context.tool, pointer: context.pointer,
          category: entry.category, token: match[0], embedded, destination: context.destination, purpose: context.purpose }));
        if (permitted !== true || (entry.category === 'CREDENTIAL' && embedded && context.allowCredentialEmbedding !== true)) fail('restore_denied');
      }
      const output = privacyText.replace(tokenPattern(), token => entryFor(token).value);
      checkText(output); return output;
    }
    function revoke(token) {
      const entry = entries.get(token); if (!entry) return false;
      entries.delete(token); byValue.delete(entry.value); revokedValues.add(entry.value);
      const group = aliases.get(entry.value); if (group) group.revoked = true;
      revision++; return true;
    }
    function clear() { entries.clear(); byValue.clear(); revokedValues.clear(); aliases.clear(); prefixes.clear(); valueBytes = 0; revision++; }
    function exportState() { return { version: 1, scopeId, entries: [...entries].map(([token, entry]) => ({ token, ...entry })),
      ...(revokedValues.size ? { revokedValues: [...revokedValues] } : {}),
      ...(aliases.size ? { aliasGroups: [...new Set(aliases.values())].map(group => [...group.members]) } : {}) }; }
    function importState(state) {
      if (!state || state.version !== 1 || state.scopeId !== scopeId || !Array.isArray(state.entries)
        || Object.keys(state).some(key => !['version', 'scopeId', 'entries', 'revokedValues', 'aliasGroups'].includes(key))) fail('state_invalid');
      const revoked = state.revokedValues === undefined ? [] : state.revokedValues;
      const groups = state.aliasGroups === undefined ? [] : state.aliasGroups;
      if (!Array.isArray(revoked) || !Array.isArray(groups) || state.entries.length + revoked.length > LIMITS.mappings || groups.length > LIMITS.mappings) fail('state_invalid');
      const checked = [], values = new Set(), tokens = new Set(); let bytes = 0;
      const checkValue = value => {
        if (typeof value !== 'string' || !value || value.includes(PREFIX) || values.has(value)) fail('state_invalid');
        checkText(value); values.add(value); bytes += Buffer.byteLength(value, 'utf8'); if (bytes > LIMITS.mappingBytes) fail('state_invalid');
      };
      for (const entry of state.entries) {
        if (!entry || typeof entry.token !== 'string' || !/^\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]$/.test(entry.token)
          || !TYPES.has(entry.token.split(':')[1]) || entry.token.split(':')[1] === 'CREDENTIAL' && entry.category !== 'CREDENTIAL'
          || tokens.has(entry.token) || !Number.isSafeInteger(entry.expiresAt)
          || Object.keys(entry).sort().join(',') !== 'category,expiresAt,token,value') fail('state_invalid');
        checkValue(entry.value); category(entry.category); tokens.add(entry.token);
        checked.push({ token: entry.token, value: entry.value, category: entry.category, expiresAt: entry.expiresAt });
      }
      for (const value of revoked) checkValue(value);
      const grouped = new Set();
      for (const group of groups) {
        if (!Array.isArray(group) || group.length < 2 || group.length > LIMITS.mappings) fail('state_invalid');
        for (const value of group) { if (!values.has(value) || grouped.has(value)) fail('state_invalid'); grouped.add(value); }
      }
      clear(); valueBytes = bytes;
      for (const { token, ...entry } of checked) { entries.set(token, entry); byValue.set(entry.value, token); }
      for (const value of revoked) revokedValues.add(value);
      for (const members of groups) {
        let type, expiresAt = Infinity;
        for (const member of members) { const entry = entries.get(byValue.get(member)); if (entry) { type = type === undefined ? entry.category : stricter(type, entry.category); expiresAt = Math.min(expiresAt, entry.expiresAt); } }
        const group = { members: new Set(members), expiresAt, revoked: members.some(value => revokedValues.has(value)) };
        for (const member of members) { aliases.set(member, group); const entry = entries.get(byValue.get(member)); if (entry) entry.category = type; }
      }
      revision++;
    }
    return Object.freeze({ detect, detectLearned, protectRaw, protectValue: (value, type, context = {}) => { checkText(value); category(type); if (!value) fail('rule_empty'); return issue(value, type, context.budget); },
      protectAlias, revision: () => revision, validateProtected, restoreForTool, revoke, clear, exportState, importState, size: () => entries.size });
  }
  function checkKey(key) { if (!Buffer.isBuffer(key) || key.length !== 32) fail('key_invalid'); }
  function aadFor(binding, keyId) {
    if (!binding || typeof binding !== 'object') fail('binding_invalid');
    return Buffer.from(JSON.stringify(['ruyi-privacy', 1, identity(keyId), identity(binding.instanceId), identity(binding.purpose), identity(binding.recordId)]), 'utf8');
  }
  function seal(plaintext, key, binding, keyId) {
    checkKey(key); const privacyText = checkText(plaintext); const aad = aadFor(binding, keyId);
    if (Buffer.from(privacyText, 'utf8').toString('utf8') !== privacyText) fail('unicode_invalid');
    const nonce = cryptoApi.randomBytes(12), cipher = cryptoApi.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(privacyText, 'utf8'), cipher.final()]);
    return Object.freeze({ version: 1, algorithm: 'A256GCM', keyId, nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
  }
  function decode(value, size, max) {
    if (typeof value !== 'string' || value.length > max || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('envelope_invalid');
    const bytes = Buffer.from(value, 'base64');
    if ((size !== null && bytes.length !== size) || bytes.toString('base64') !== value) fail('envelope_invalid');
    return bytes;
  }
  function open(envelope, key, binding, expectedKeyId) {
    // Uniform errors prevent accidental disclosure of values or crypto internals through tool errors.
    try {
      checkKey(key);
      if (!envelope || Object.keys(envelope).sort().join(',') !== 'algorithm,ciphertext,keyId,nonce,tag,version'
        || envelope.version !== 1 || envelope.algorithm !== 'A256GCM' || envelope.keyId !== expectedKeyId) fail('envelope_invalid');
      const aad = aadFor(binding, expectedKeyId), nonce = decode(envelope.nonce, 12, 16), tag = decode(envelope.tag, 16, 24);
      const ciphertext = decode(envelope.ciphertext, null, Math.ceil(LIMITS.bytes / 3) * 4);
      if (ciphertext.length > LIMITS.bytes) fail('envelope_invalid');
      const decipher = cryptoApi.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(aad); decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch { fail('decrypt_failed'); }
  }
  // Filled by the storage adapter after config primitives exist; no forward dependency from config.
  const configHooks = {};
  return Object.freeze({ LIMITS, ruleCatalogVersion: ruleCatalog?.version || 1, createMatchBudget, createDetector, createScope, seal, open, configHooks });
})(require('node:crypto'), typeof PrivacyRuleCatalog === 'undefined' ? null : PrivacyRuleCatalog);
