// 81-P1: Versioned offline rule extensions. Input and matching budgets are enforced by PrivacyCore;
// built-in delimiter runs are linear, and no user regex runs here.
const PrivacyRuleCatalog = (() => {
  const version = 5;
  const rules = [];
  const add = (id, category, tier, pattern, capture = 0) => rules.push(Object.freeze({ id, category, tier, pattern, capture }));
  // Quoted JSON/property labels and prose labels carry the same privacy evidence. The optional
  // opening quote belongs to the value syntax, never its capture, so tool restoration is exact.
  const labelled = (label, value, flags = 'gi') => new RegExp('(?:' + label + ')["\']?\\s*(?:[:=：]|是|为)\\s*["\']?(' + value + ')', flags);
  const chineseLabelled = (label, value, flags = 'gi') => new RegExp('(?:' + label + ')["\']?[ \\t]*(?:[:=：]|是|为)?[ \\t]*["\']?(' + value + ')', flags);
  const combine = (...patterns) => new RegExp(patterns.map(pattern => '(?:' + pattern.source + ')').join('|'), 'gi');
  // Prefix detection complements exact configured-secret matching; it is not a credential validity test.
  add('credential.gitlab', 'CREDENTIAL', 'basic', /\bglpat-[A-Za-z0-9_-]{20,256}/g);
  add('credential.npm', 'CREDENTIAL', 'basic', /\bnpm_[A-Za-z0-9]{36,256}/g);
  add('credential.pypi', 'CREDENTIAL', 'basic', /\bpypi-[A-Za-z0-9_-]{50,2048}/g);
  add('credential.huggingface', 'CREDENTIAL', 'basic', /\bhf_[A-Za-z0-9]{20,256}/g);
  add('credential.google-api', 'CREDENTIAL', 'basic', /\bAIza[A-Za-z0-9_-]{35}/g);
  add('credential.google-oauth', 'CREDENTIAL', 'basic', /\bya29\.[A-Za-z0-9._-]{20,2048}/g);
  add('credential.stripe', 'CREDENTIAL', 'basic', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,256}/g);
  add('credential.sendgrid', 'CREDENTIAL', 'basic', /\bSG\.[A-Za-z0-9_-]{16,128}\.[A-Za-z0-9_-]{20,256}/g);
  add('credential.slack-webhook', 'CREDENTIAL', 'basic', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]{8,64}\/[A-Za-z0-9]{8,64}\/[A-Za-z0-9]{16,128}/g);
  add('credential.discord-webhook', 'CREDENTIAL', 'basic', /https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d{10,24}\/[A-Za-z0-9_-]{20,256}/g);
  add('credential.teams-webhook', 'CREDENTIAL', 'basic', /https:\/\/[A-Za-z0-9.-]{1,200}\.webhook\.office\.com\/webhookb2\/[^\s"'<>]{20,2048}/gi);
  add('credential.aws-temporary-id', 'CREDENTIAL', 'basic', /\bASIA[0-9A-Z]{16}/g);
  add('credential.azure-sas', 'CREDENTIAL', 'basic', /[?&]sig=([^&#\s"']{1,4096})/gi, 1);
  add('credential.signed-query', 'CREDENTIAL', 'basic', /[?&](?:X-Amz-Security-Token|X-Goog-Signature|X-Goog-Credential|OSSAccessKeyId|SecurityToken|credential|client_secret|refresh_token|id_token|access_key|secret_key|sign|sig|signature|key|auth_token)=([^&#\s"']{1,4096})/gi, 1);
  add('credential.redis-auth', 'CREDENTIAL', 'basic', /\brediss?:\/\/:([^\s@/]+)/gi, 1);
  add('credential.sql-password', 'CREDENTIAL', 'basic', combine(
    /\b(?:Password|Pwd)[ \t]*=[ \t]*"([^"\r\n]+)(?:"|(?=\r?\n|$))/gi,
    /\b(?:Password|Pwd)[ \t]*=[ \t]*'([^'\r\n]+)(?:'|(?=\r?\n|$))/gi,
    /\b(?:Password|Pwd)[ \t]*=[ \t]*([^\s;"'\r\n][^;"'\r\n]*)/gi), 1);
  add('credential.xml-secret', 'CREDENTIAL', 'basic', /<(?:password|passwd|apiKey|api_key|client_secret|access_token|refresh_token)\b[^>]{0,256}>([^<]+)/gi, 1);
  add('credential.docker-auth', 'CREDENTIAL', 'basic', /"auth"\s*:\s*"([A-Za-z0-9+/]{8,}={0,2})"/g, 1);
  add('credential.ssh-password', 'CREDENTIAL', 'basic', /\bsshpass\s+-p\s+(?:'([^'\r\n]+)'?|"([^"\r\n]+)"?|([^\s"';&|]+))/g, 1);
  add('credential.otp', 'CREDENTIAL', 'basic', labelled('验证码|动态口令|一次性密码|\\bOTP\\b|\\bone[ ._-]time[ ._-]password\\b', '[A-Za-z0-9-]{4,16}'), 1);
  add('credential.recovery-code', 'CREDENTIAL', 'basic', labelled('恢复码|备用码|\\brecovery[ ._-]code\\b|\\bbackup[ ._-]code\\b', '[A-Za-z0-9-]{6,128}'), 1);
  add('credential.wallet-private', 'CREDENTIAL', 'basic', labelled('钱包私钥|\\bprivate[ ._-]key\\b', '0x[A-Fa-f0-9]{64}|[A-Fa-f0-9]{64}'), 1);
  const integrationLead = '(?:\\b(?:qiniu[ _-]?(?:ak|sk|access[ _-]?key|secret[ _-]?key)|aws[ _-]?(?:access[ _-]?key[ _-]?id|secret[ _-]?access[ _-]?key)|smtp[ _-]?password|app[ _-]?secret|access[ _-]?key|secret[ _-]?key|webhook(?:[ _-]?url)?)\\b|七牛(?:云)?[ _-]?(?:AK|SK|访问密钥|私密密钥))["\']?\\s*(?:[:=：]|是|为)\\s*';
  add('credential.integration-secret', 'CREDENTIAL', 'basic', combine(
    // A quoted value is one complete secret, including whitespace and punctuation. Bare matching
    // must never consume its opening quote and silently expose the remaining suffix. A truncated
    // quoted copy still protects its remaining line. Escape alternatives are disjoint and linear.
    new RegExp(integrationLead + '"((?:[^"\\\\\\r\\n]|\\\\(?:[^\\r\\n]|(?=\\r?\\n|$)))+)(?:"|(?=\\r?\\n|$))', 'gi'),
    new RegExp(integrationLead + "'((?:[^'\\\\\\r\\n]|\\\\(?:[^\\r\\n]|(?=\\r?\\n|$)))+)(?:'|(?=\\r?\\n|$))", 'gi'),
    new RegExp(integrationLead + '(?!["\'])([^\\s"\'<>，,;；。！？]{1,4096})', 'gi'),
    // Relative callback paths need a long hex secret, not an ordinary /hooks/documentation route.
    /(?<![A-Za-z0-9_./-])(\/(?:hooks?|webhooks?)\/[A-Fa-f0-9]{32,})(?![A-Za-z0-9_-])/g,
    /(https:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?\/(?:[^\s"'<>?#/]{1,80}\/){0,5}(?:hooks?|webhooks?)\/[A-Za-z0-9_-]{16,4096})/gi,
    /(https:\/\/(?:open\.feishu\.cn|open\.larksuite\.com)\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{16,4096})/gi), 1);
  // Personal rules require a label when the format alone is ambiguous.
  const landline = '(?:\\+?86[ -]?)?0\\d{2,3}[ -]?\\d{3,4}[ -]?\\d{4}(?:[ \\t-]*(?:转(?:分机)?|ext\\.?|x)[ \\t:-]*\\d{1,6})?';
  add('personal.cn-landline', 'PHONE', 'enhanced', combine(labelled('电话|座机|传真|\\btel\\b|\\bphone\\b|\\bfax\\b', landline), chineseLabelled('(?:回拨)?座机|固定电话|父亲|母亲|备用(?:电话|号码)?', landline)), 1);
  const international = '\\+[1-9][\\d ()-]{6,24}\\d';
  const phoneValue = '(?:(?:' + international + ')(?:[ \\t]*(?:和|、|,|，)[ \\t]*(?:' + international + ')){0,15}|(?:\\+?86[ -]?)?1[3-9]\\d[ -]{1,3}\\d{4}[ -]{1,3}\\d{4})';
  add('personal.international-phone', 'PHONE', 'enhanced', combine(labelled('\\b(?:mobile|phone|tel)(?:[ _-]?(?:no|number))?\\b|(?:联系)?电话(?:号码|号)?|(?:联系)?手机(?:号码|号)?|原号码|新号(?:码)?', phoneValue), chineseLabelled('境外来电|境外电话|国际电话|来电|手机(?:号码|号)?|电话(?:号码|号)?', phoneValue)), 1);
  add('personal.passport-labelled', 'IDENTITY', 'enhanced', combine(labelled('护照(?:号码|号)?|\\bpassport(?:[ ._-]?(?:no|number))?\\b', '[A-Za-z0-9]{6,16}'), chineseLabelled('回乡证(?:号码|号)?|台胞证(?:号码|号)?|港澳通行证(?:号码|号)?|台湾通行证(?:号码|号)?|护照(?:号码|号)?', '[A-Za-z0-9][A-Za-z0-9()（） -]{5,23}[A-Za-z0-9)]?')), 1);
  // An explicit identity label remains sensitive even when a user has mistyped an invalid number.
  add('personal.social-security', 'IDENTITY', 'enhanced', combine(labelled('\\bSSN\\b|\\bsocial[ ._-]security(?:[ ._-]number)?\\b', '\\d{3}[- ]?\\d{2}[- ]?\\d{4}'), chineseLabelled('社保卡号|社保(?:个人)?(?:账号|编号|号码)|医保(?:卡号|个人编号|号码|账号)|公积金(?:账号|个人编号|号码)', '[A-Za-z0-9][A-Za-z0-9 -]{4,39}')), 1);
  add('personal.driver-license', 'IDENTITY', 'enhanced', labelled('驾驶证(?:号码|号)|\\bdriver[ ._-]?s?[ ._-]licen[sc]e(?:[ ._-]number)?\\b', '[A-Za-z0-9-]{5,24}'), 1);
  add('personal.tax-id', 'IDENTITY', 'enhanced', combine(labelled('税号|纳税人识别号|\\btax[ ._-]id\\b|\\bTIN\\b', '[A-Za-z0-9-]{8,24}'), chineseLabelled('统一社会信用代码|社会信用代码|纳税人识别号|税号', '[A-Za-z0-9-]{8,24}')), 1);
  add('personal.bank-account', 'PAYMENT', 'enhanced', combine(labelled('银行账号|银行账户|\\bbank[ ._-]account(?:[ ._-]number)?\\b|\\baccount[ ._-]number\\b', '[A-Za-z0-9][A-Za-z0-9 -]{3,32}[A-Za-z0-9]'), chineseLabelled('开户行|开票(?:账号|账户)|收款(?:账号|账户)|账号', '(?:[A-Za-z0-9][A-Za-z0-9 -]{3,32}[A-Za-z0-9]|[\\u4e00-\\u9fff][^\\r\\n,，;；<>"\']{1,79})')), 1);
  add('personal.payment-security', 'CREDENTIAL', 'basic', combine(labelled('\\bCVV2?\\b|\\bCVC2?\\b|支付密码|取款密码', '\\d{3,8}'), /\b(?:CVV2?|CVC2?)\b[ \t]*(?:在背面(?:的)?|[=:：])[ \t]*(\d{3,8})/gi), 1);
  add('personal.payment-expiry', 'PAYMENT', 'enhanced', chineseLabelled('(?:信用卡|银行卡|卡片)?有效期|卡到期日', '(?:[0-9]{1,2}[/.-][0-9]{2,4}|[0-9]{4}[/.-][0-9]{1,2})'), 1);
  add('personal.birth-date', 'INTERNAL', 'enhanced', combine(labelled('出生日期|生日|\\bdate[ ._-]of[ ._-]birth\\b|\\bDOB\\b', '\\d{4}[-/.年]\\d{1,2}[-/.月]\\d{1,2}日?'), chineseLabelled('出生日期|生日', '\\d{4}[-/.年]\\d{1,2}[-/.月]\\d{1,2}日?'),
    // Clear birth labels may precede a short explanation, never punctuation or another number.
    /(?:出生日期|生日)[\u4e00-\u9fffA-Za-z \t]{1,16}(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/gi), 1);
  add('personal.contact-name', 'INTERNAL', 'enhanced', labelled('姓名|联系人|收件人|\\bfull[ ._-]name\\b|\\bpatient[ ._-]name\\b', '(?:[^\\r\\n,，;；<>"\']{1,80}?(?=[ \\t]+(?:手机|电话|座机|邮箱)|[,，;；\\r\\n"\']|$)|[^\\r\\n,，;；<>"\']{80})'), 1);
  add('personal.address', 'INTERNAL', 'enhanced', combine(labelled('家庭住址|收货地址|通讯地址|\\bhome[ ._-]address\\b|\\bshipping[ ._-]address\\b|\\bpostal[ ._-]address\\b', '[^\\r\\n,，;；<>"\']{2,256}'), chineseLabelled('现住址|户籍地|户籍地址|户口所在地', '[^\\r\\n,，;；<>"\']{2,256}')), 1);
  add('personal.health-record', 'INTERNAL', 'enhanced', labelled('病历号|就诊号|医保号|\\bpatient[ ._-]id\\b|\\bmedical[ ._-]record(?:[ ._-]number)?\\b', '[A-Za-z0-9-]{3,40}'), 1);
  add('personal.diagnosis', 'INTERNAL', 'enhanced', labelled('诊断结果|疾病诊断|\\bdiagnosis\\b', '[^\\r\\n;；<>"\']{2,256}'), 1);
  add('personal.vehicle', 'IDENTITY', 'enhanced', chineseLabelled('车牌(?:号码|号)?|车架号|车辆识别(?:代号|代码)|\\bVIN\\b', '(?:[\\u4e00-\\u9fff][A-Za-z][·. -]?[A-Za-z0-9]{5,7}|[A-Za-z0-9]{11,24})'), 1);
  add('personal.work-identifier', 'IDENTITY', 'enhanced', chineseLabelled('工号|员工(?:编号|号码)|门禁卡(?:号码|号)|考勤卡(?:号码|号)', '[A-Za-z0-9][A-Za-z0-9-]{3,39}'), 1);
  add('personal.profile-url', 'INTERNAL', 'enhanced', /(?<![A-Za-z0-9_@./-])(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_%~-]{2,256}\/?/gi);
  // Optional technical privacy is not enabled merely by enabling personal data protection.
  add('technical.ipv4', 'INTERNAL', 'technical', combine(/(?<![\d.])((?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}))(?![\d.])/g,
    labelled('\\b(?:client[ _-]?ip|xff|x[ _-]?forwarded[ _-]?for|remote[ _-]?addr|ip[ _-]?address)\\b', '(?:[0-9]{1,3}\\.){3}[0-9]{1,3}(?![0-9.])')), 1);
  add('technical.mac', 'INTERNAL', 'technical', /\b(?:[A-Fa-f0-9]{2}:){5}[A-Fa-f0-9]{2}\b/g);
  add('technical.windows-user-path', 'PATH', 'technical', /\b[A-Za-z]:[\\/]Users[\\/]([^\\/\r\n:*?"<>|]{1,128})/gi, 1);
  add('technical.posix-user-path', 'PATH', 'technical', /\/(?:home|Users)\/([^/\r\n\s]{1,128})/g, 1);
  add('internal.classified-line', 'INTERNAL', 'confidential', labelled('内部项目|保密代号|商业秘密|\\bconfidential[ ._-]value\\b', '[^\\r\\n;；<>"\']{1,256}'), 1);
  // Narrow variants share the existing catalog IDs and tier switches. Ambiguous
  // business numbers, bare hashes and arbitrary paths are deliberately excluded.
  const extend = (id, ...patterns) => {
    const index = rules.findIndex(rule => rule.id === id), rule = rules[index];
    rules[index] = Object.freeze({ ...rule, pattern: combine(rule.pattern, ...patterns) });
  };
  extend('credential.integration-secret',
    /\b(?:api[ _-]?v[0-9]+[ _-]?key)["']?[ \t]*[:=：][ \t]*["']?([A-Za-z0-9_./+!-]{16,256})/gi,
    /\b(?:SecretId|AccessKeyId)["']?[ \t]*(?:[:=：][ \t]*)?["']?([A-Za-z0-9_-]{16,128})/gi,
    /\b(?:API[ _-]?key|API[ _-]?密钥)[^\r\n:=：]{0,24}[:=：][ \t]*([a-f0-9]{32,64})(?![a-f0-9])/gi,
    /\/(?:sig|signature|secret)\/([a-f0-9]{32,128})(?![A-Za-z0-9_-])/gi);
  extend('personal.bank-account', chineseLabelled('银行卡号|信用卡号|卡号', '[0-9](?:[ -]{0,3}[0-9]){12,18}(?![0-9])'));
  extend('personal.payment-security', /(?:银行卡|信用卡|卡号)[^\r\n]{0,120}?背面(?:的)?三位[ \t:：]*(\d{3})(?!\d)/g);
  extend('personal.social-security', /医保[^\r\n。；;]{0,40}个人编号[ \t:：]*([A-Za-z0-9-]{6,32})/g);
  extend('personal.health-record', chineseLabelled('病历号|就诊号|检查报告(?:单)?号|检查单号', '[A-Za-z0-9-]{3,40}'));
  extend('personal.diagnosis',
    /(?:过敏史|过敏药物|过敏药品)[^"“\r\n]{0,24}["“]([^"”\r\n]{1,128})["”]/g,
    labelled('过敏史|过敏药物|过敏药品', '[^\\r\\n,，;；<>"\']{1,128}'));
  extend('personal.contact-name', /紧急联系人[^\r\n:：0-9]{0,12}[:：][ \t]*([\u4e00-\u9fff]{2,8})(?=[ \t]+(?:1[3-9]|手机|电话)|[,，。；;\r\n]|$)/g);
  extend('personal.address',
    /(?:家庭住址|收货地址|通讯地址)[^\r\n0-9:：=]{0,12}[:：=][ \t]*([^\r\n,，;；<>"']{2,256})/g,
    /(?:房子|房屋|租房)(?:地址)?(?:在|位于)[ \t]*([\u4e00-\u9fff][^\r\n,，;；<>"']{2,100}(?:路|街|大道|巷|弄)[ \t]*\d{1,6}号[^\r\n,，;；<>"']{0,100})/g);

  // Practical accidental-disclosure coverage: explicit labels and recognizable formats,
  // not generic names, business numbers or recursive deobfuscation.
  extend('credential.integration-secret',
    /\b([0-9]{6,16}:AA[A-Za-z0-9_-]{25,256})(?![A-Za-z0-9_-])/g,
    /\b(?:Telegram|电报)[^\r\n:：]{0,32}[:：][ \t]*([0-9]{6,16}:[A-Za-z0-9_-]{20,256})/gi,
    /\bAWS[^\r\n:：]{0,24}[:：][ \t]*(ASIA[A-Z0-9]{10,32}(?:[ \t]*\+[ \t]*[A-Za-z0-9+/=_-]{20,4096})?)(?![A-Z0-9])/gi,
    /\b[A-Za-z0-9_]*_PASS["']?[ \t]*[:=：][ \t]*["']?([^\s"'{}\[\],，;；。！？]{1,4096})/gi,
    /(?:Wi[ -]?Fi|无线网|无线网络|门禁)(?:的)?密码(?:[ \t]*[:：=是为][ \t]*|[ \t]+)([A-Za-z0-9!@#$%^&*()_+=.\/-]{4,128})/gi,
    /(?:Wi[ -]?Fi|无线网|无线网络)(?:的)?密码[^\r\n。；;]{0,24}以前是[ \t]*([A-Za-z0-9!@#$%^&*()_+=.\/-]{4,128})/gi,
    chineseLabelled('门禁密码', '[0-9]{4,12}(?![0-9])'));
  extend('credential.otp', /(?:动态口令|一次性密码|验证码)(?:刚收到的是|刚收到的|是|为|[:：=])?[ \t]*([0-9]{4,8})(?![0-9])/g);
  extend('personal.bank-account', /收款卡[ \t:：]*(?:[\u4e00-\u9fff]{2,16}[ \t]*)?([0-9](?:[ -]{0,3}[0-9]){12,18})(?![0-9])/g);
  extend('personal.work-identifier', chineseLabelled('保单号', '[A-Za-z0-9][A-Za-z0-9-]{5,39}'));
  extend('personal.driver-license', chineseLabelled('驾照档案编号|驾驶证档案编号', '[0-9]{12}(?![0-9])'));
  extend('personal.health-record', /(?:病历号|就诊号)[^\r\n。；;0-9]{0,24}[ \t]([A-Za-z]{1,6}[0-9][A-Za-z0-9-]{2,32})(?![A-Za-z0-9-])/g);
  extend('personal.contact-name', /(?:车主|投保人|被保险人|患者)-([\u4e00-\u9fff]{2,4})(?=[:：])/g,
    /受益人(?:写|填)(?:我)?(?:爱人|妻子|丈夫|父亲|母亲|配偶)[ \t:：]*([\u4e00-\u9fff]{2,4})(?=[,，。；;]|[ \t]+(?:手机|身份证)|$)/g);
  extend('personal.address', /(?:^|[\s,，。；;])地址(?:也照旧|照旧|不变)?[ \t:：]*([\u4e00-\u9fff][^\r\n,，;；。<>"']{1,60}(?:路|街|大道|巷|弄)[ \t]*[0-9]{1,6}号[^\r\n,，;；。<>"']{0,100})/g);
  extend('personal.cn-landline', chineseLabelled('座机|电话|备用', '\\(0[0-9]{2,3}\\)[ \\t-]*[0-9]{3,4}[ \\t-]*[0-9]{4}(?:[ \\t-]*(?:转(?:分机)?|ext\\.?|x)[ \\t:-]*[0-9]{1,6})?'));

  const frozen = Object.freeze(rules);
  const fieldCategories = Object.freeze({
    pass: 'CREDENTIAL',
    auth: 'CREDENTIAL', authorization: 'CREDENTIAL', proxyauthorization: 'CREDENTIAL', cookie: 'CREDENTIAL', setcookie: 'CREDENTIAL',
    apikey: 'CREDENTIAL', secretkey: 'CREDENTIAL', clientsecret: 'CREDENTIAL', password: 'CREDENTIAL', passwd: 'CREDENTIAL',
    accesstoken: 'CREDENTIAL', refreshtoken: 'CREDENTIAL', idtoken: 'CREDENTIAL', sessiontoken: 'CREDENTIAL',
    awssecretaccesskey: 'CREDENTIAL', awssecuritytoken: 'CREDENTIAL', privatekey: 'CREDENTIAL', signingkey: 'CREDENTIAL',
    connectionstring: 'CREDENTIAL', recoverycode: 'CREDENTIAL', backupcode: 'CREDENTIAL', mnemonic: 'CREDENTIAL', seedphrase: 'CREDENTIAL',
    otp: 'CREDENTIAL', onetimepassword: 'CREDENTIAL', pincode: 'CREDENTIAL',
    email: 'EMAIL', emailaddress: 'EMAIL', phone: 'PHONE', phonenumber: 'PHONE', mobile: 'PHONE',
    idcard: 'IDENTITY', identitynumber: 'IDENTITY', passport: 'IDENTITY', ssn: 'IDENTITY',
    passportnumber: 'IDENTITY', driverlicense: 'IDENTITY', driverlicensenumber: 'IDENTITY',
    driverslicense: 'IDENTITY', driverslicensenumber: 'IDENTITY', driverlicence: 'IDENTITY', driverlicencenumber: 'IDENTITY',
    taxid: 'IDENTITY', tin: 'IDENTITY', socialsecuritynumber: 'IDENTITY', nationalid: 'IDENTITY',
    身份证: 'IDENTITY', 身份证号: 'IDENTITY', 身份证号码: 'IDENTITY', 居民身份证号: 'IDENTITY',
    bankaccount: 'PAYMENT', cardnumber: 'PAYMENT', iban: 'PAYMENT', cvv: 'CREDENTIAL', cvc: 'CREDENTIAL',
    bankaccountnumber: 'PAYMENT', accountnumber: 'PAYMENT',
    fullname: 'INTERNAL', patientname: 'INTERNAL', homeaddress: 'INTERNAL', shippingaddress: 'INTERNAL',
    medicalrecord: 'INTERNAL', diagnosis: 'INTERNAL', dateofbirth: 'INTERNAL', biometrictemplate: 'INTERNAL',
    medicalrecordnumber: 'INTERNAL', patientid: 'INTERNAL', postaladdress: 'INTERNAL', contactname: 'INTERNAL', birthdate: 'INTERNAL',
    口令: 'CREDENTIAL', 密码: 'CREDENTIAL', 密钥: 'CREDENTIAL', 私钥: 'CREDENTIAL', 令牌: 'CREDENTIAL',
    接口密钥: 'CREDENTIAL', 验证码: 'CREDENTIAL', 动态口令: 'CREDENTIAL', 一次性密码: 'CREDENTIAL',
    api密钥: 'CREDENTIAL', 访问令牌: 'CREDENTIAL', 刷新令牌: 'CREDENTIAL',
    qiniuak: 'CREDENTIAL', qiniusk: 'CREDENTIAL', qiniuaccesskey: 'CREDENTIAL', qiniusecretkey: 'CREDENTIAL',
    awsaccesskeyid: 'CREDENTIAL', smtppassword: 'CREDENTIAL', appsecret: 'CREDENTIAL', webhook: 'CREDENTIAL', webhookurl: 'CREDENTIAL',
    cvv2: 'CREDENTIAL', cvc2: 'CREDENTIAL', apiv3key: 'CREDENTIAL', secretid: 'CREDENTIAL', accesskeyid: 'CREDENTIAL', accesskeysecret: 'CREDENTIAL',
    恢复码: 'CREDENTIAL', 备用码: 'CREDENTIAL', 支付密码: 'CREDENTIAL', 取款密码: 'CREDENTIAL',
    邮箱: 'EMAIL', 电子邮箱: 'EMAIL', 邮件地址: 'EMAIL', 手机: 'PHONE', 手机号: 'PHONE', 手机号码: 'PHONE', 电话: 'PHONE',
    护照: 'IDENTITY', 护照号: 'IDENTITY', 驾驶证号: 'IDENTITY', 税号: 'IDENTITY', 纳税人识别号: 'IDENTITY',
    银行卡: 'PAYMENT', 银行卡号: 'PAYMENT', 银行账号: 'PAYMENT', 银行账户: 'PAYMENT',
    姓名: 'INTERNAL', 联系人: 'INTERNAL', 收件人: 'INTERNAL', 家庭住址: 'INTERNAL', 收货地址: 'INTERNAL', 通讯地址: 'INTERNAL',
    出生日期: 'INTERNAL', 生日: 'INTERNAL', 病历号: 'INTERNAL', 就诊号: 'INTERNAL', 医保号: 'INTERNAL', 诊断结果: 'INTERNAL', 检查报告单号: 'INTERNAL', 检查报告号: 'INTERNAL', 过敏史: 'INTERNAL',
    回乡证: 'IDENTITY', 回乡证号: 'IDENTITY', 台胞证: 'IDENTITY', 台胞证号: 'IDENTITY', 港澳通行证: 'IDENTITY',
    社保卡号: 'IDENTITY', 公积金账号: 'IDENTITY', 医保个人编号: 'IDENTITY', 统一社会信用代码: 'IDENTITY',
    现住址: 'INTERNAL', 户籍地: 'INTERNAL', 户籍地址: 'INTERNAL', 户口所在地: 'INTERNAL',
    工号: 'IDENTITY', 员工编号: 'IDENTITY', 门禁卡号: 'IDENTITY', employeeid: 'IDENTITY', accesscardid: 'IDENTITY',
    车牌: 'IDENTITY', 车牌号: 'IDENTITY', 车架号: 'IDENTITY', vin: 'IDENTITY', licenseplate: 'IDENTITY',
    cardexpiry: 'PAYMENT', cardexpirydate: 'PAYMENT', 开票账号: 'PAYMENT', 收款账号: 'PAYMENT', 开户行: 'PAYMENT',
    linkedin: 'INTERNAL', linkedinurl: 'INTERNAL',
  });
  // A maximum regex capture must not expose a secret's remaining suffix. These simple character
  // classes only extend an already identified value, linearly, within PrivacyCore's input budget.
  // Delimiter-terminated rules (Redis/XML/SSH) instead consume their entire bounded input run.
  const continuations = Object.freeze({
    'credential.gitlab': /[A-Za-z0-9_-]/, 'credential.npm': /[A-Za-z0-9]/,
    'credential.pypi': /[A-Za-z0-9_-]/, 'credential.huggingface': /[A-Za-z0-9]/,
    'credential.google-api': /[A-Za-z0-9_-]/, 'credential.google-oauth': /[A-Za-z0-9._-]/,
    'credential.stripe': /[A-Za-z0-9]/, 'credential.sendgrid': /[A-Za-z0-9_-]/,
    'credential.slack-webhook': /[A-Za-z0-9]/, 'credential.discord-webhook': /[A-Za-z0-9_-]/,
    'credential.teams-webhook': /[^\s"'<>]/, 'credential.aws-temporary-id': /[A-Z0-9]/,
    'credential.azure-sas': /[^&#\s"']/, 'credential.signed-query': /[^&#\s"']/,
    'credential.docker-auth': /[A-Za-z0-9+/=]/,
    'credential.otp': /[A-Za-z0-9-]/, 'credential.recovery-code': /[A-Za-z0-9-]/,
    'credential.wallet-private': /[A-Fa-f0-9]/,
    'credential.integration-secret': /[^\s"'<>，,;；。！？]/,
    'personal.cn-landline': /[0-9 -]/, 'personal.international-phone': /[0-9 ()-]/,
    'personal.social-security': /[A-Za-z0-9 -]/, 'personal.payment-security': /[0-9]/, 'personal.payment-expiry': /[0-9/.-]/,
    'personal.birth-date': /[0-9]/,
    'personal.passport-labelled': /[A-Za-z0-9()（） -]/, 'personal.driver-license': /[A-Za-z0-9-]/,
    'personal.tax-id': /[A-Za-z0-9-]/, 'personal.bank-account': /[\p{L}\p{N} -]/u,
    'personal.contact-name': /[^\r\n,，;；<>"']/, 'personal.address': /[^\r\n,，;；<>"']/,
    'personal.health-record': /[A-Za-z0-9-]/, 'personal.diagnosis': /[^\r\n;；<>"']/,
    'internal.classified-line': /[^\r\n;；<>"']/,
    'personal.vehicle': /[A-Za-z0-9·.-]/, 'personal.work-identifier': /[A-Za-z0-9-]/,
    'personal.profile-url': /[A-Za-z0-9_%~/-]/,
    'technical.windows-user-path': /[^\\/\r\n:*?"<>|]/, 'technical.posix-user-path': /[^/\r\n\s]/,
  });
  const proseValues = new Set(['personal.contact-name', 'personal.address', 'personal.diagnosis', 'internal.classified-line']);
  // Preserve clearly pre-redacted personal fields. Explicit custom rules and learned
  // exact secrets remain authoritative; this filter applies only to discovery.
  const alreadyMasked = (text, type) => /^(?:EMAIL|PHONE|IDENTITY|PAYMENT)$/.test(type)
    && /(?:\*{2,}|[＊×]{2,}|•{2,})/.test(text)
    || type === 'INTERNAL' && /^[\u4e00-\u9fff]{1,2}[*＊×•]{1,4}[\u4e00-\u9fff]{0,2}[。.]?$/.test(text.trim());
  function scan(inputText, options, emitRaw) {
    const emit = (start, end, type, id) => { if (!alreadyMasked(inputText.slice(start, end), type)) emitRaw(start, end, type, id); };
    const overrides = options.ruleOverrides || {};
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).length > 200
      || Object.entries(overrides).some(([id, value]) => !frozen.some(rule => rule.id === id) || typeof value !== 'boolean')) {
      throw Object.assign(new Error('privacy.rule_override_invalid'), { code: 'privacy.rule_override_invalid' });
    }
    for (const rule of frozen) {
      const active = Object.hasOwn(overrides, rule.id) ? overrides[rule.id] : rule.tier === 'basic'
        || (rule.tier === 'enhanced' && options.personal === true) || (rule.tier === 'technical' && options.technical === true)
        || (rule.tier === 'confidential' && options.confidential === true);
      if (!active) continue;
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match;
      while ((match = regex.exec(inputText)) !== null) {
        const value = rule.capture ? match.slice(rule.capture).find(part => typeof part === 'string' && part.length) : match[0]; if (!value) continue;
        if (rule.id === 'technical.ipv4' && value.split('.').some(part => Number(part) > 255)) continue;
        const start = match.index + (rule.capture ? match[0].lastIndexOf(value) : 0);
        let end = start + value.length;
        const continuation = continuations[rule.id];
        if (continuation) while (end < inputText.length) {
          if (rule.id === 'personal.contact-name' && /[:：]/.test(inputText[end])) break;
          if (rule.id === 'personal.contact-name' && /^[ \t]+(?:手机|电话|座机|邮箱)/.test(inputText.slice(end, end + 16))) break;
          if (continuation.test(inputText[end])) { end++; continue; }
          // Apostrophes inside names, addresses and descriptions are data. A single-quoted value
          // still stops at its closing quote; contractions such as O'Brien continue across it.
          if (proseValues.has(rule.id) && inputText[end] === "'" && (inputText[start - 1] !== "'"
            || /[\p{L}\p{N}]/u.test(inputText[end + 1] || ''))) { end++; continue; }
          break;
        }
        emit(start, end, rule.category, rule.id);
        // An extended run is already fully covered. Re-entering it at another token-looking
        // prefix would rescan the same suffix repeatedly and turn a linear scan into O(n²).
        regex.lastIndex = Math.max(regex.lastIndex, end);
      }
    }
    const pointer = typeof options.pointer === 'string' ? options.pointer : '';
    const rawField = pointer.split('/').pop().replace(/~1/g, '/').replace(/~0/g, '~').toLowerCase();
    const field = rawField.replace(/[-_ ]/g, '');
    let type = Object.hasOwn(fieldCategories, field) ? fieldCategories[field] : undefined;
    // Only explicit field-family suffixes qualify. request_id, file_name and token_count stay ordinary.
    if (!type && /^[a-z0-9_ -]{1,160}$/.test(rawField)) {
      const parts = rawField.replace(/[_ -](?:old|new|backup|primary|secondary|[0-9]{1,2})$/, '').split(/[_ -]+/);
      for (let index = 0; index < parts.length && !type; index++) {
        const suffix = parts.slice(index).join('');
        if (Object.hasOwn(fieldCategories, suffix)) type = fieldCategories[suffix];
      }
    }
    if (type && (type === 'CREDENTIAL' || options.personal === true)) emit(0, inputText.length, type, 'structured.' + field);
  }
  // Expose metadata, never the mutable RegExp instances.
  const list = () => frozen.map(({ id, category, tier }) => Object.freeze({ id, category, tier }));
  return Object.freeze({ version, list, scan, alreadyMasked });
})();
