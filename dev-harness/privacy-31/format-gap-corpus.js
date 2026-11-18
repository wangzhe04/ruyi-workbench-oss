'use strict';
// Synthetic equivalents of the 3.1 walkthrough format gaps (150 号文 §4 P2/P3). No value here is a usable
// credential: every key-shaped string is assembled from fixture words at runtime.
function createFormatGapCorpus() {
  const cases = [], add = (id, tier, sample, secret) => cases.push({ id, tier, sample, secret });
  // P2: WHATWG userinfo runs to the LAST @ before the authority ends at / ? # or whitespace.
  add('url-password-at-sign', 'basic', 'postgres://admin:p@ssw0rd!2024@db.internal:5432/x', 'p@ssw0rd!2024');
  add('url-password-colon', 'basic', '连接串 mongodb://svc:pa:ss:word9@mongo.example.test/app 已更新', 'pa:ss:word9');
  add('url-password-percent', 'basic', 'amqp://worker:p%40ss%3Aw0rd%2F1@mq.example.test:5672/vhost', 'p%40ss%3Aw0rd%2F1');
  add('url-password-ipv6', 'basic', 'postgres://admin:v6@Synthetic1@[fd00::25]:5432/x', 'v6@Synthetic1');
  add('url-password-email-user', 'basic', 'ftp://ops@example.test:Ftp@Synthetic2@files.example.test/in', 'Ftp@Synthetic2');
  const multi = 'primary=postgres://a:Pri@mary1@h1.example.test/db replica=mysql://b:Rep@lica2@h2.example.test/db';
  add('url-password-multi-first', 'basic', multi, 'Pri@mary1');
  add('url-password-multi-second', 'basic', multi, 'Rep@lica2');
  // An unencoded / ? # cuts the WHATWG authority before any @: the whole userinfo is protected.
  add('url-password-query-char', 'basic', 'postgres://admin:Syn?thetic@db.example.test/x', 'admin:Syn?thetic');
  add('url-password-slash-char', 'basic', 'redis://cache:Syn/thetic9@cache.example.test:6379/0', 'cache:Syn/thetic9');
  // v5 already protected these (numeric segment before # or ?, # in the user name); P2 must only add.
  add('url-password-numeric-hash', 'basic', 'mysql://root:2024#Pass@localhost:3306/db', '2024#Pass');
  add('url-password-jdbc-numeric-hash', 'basic', 'jdbc:mysql://root:2026#pass@10.0.0.8:3306/orderdb', '2026#pass');
  add('url-password-numeric-query', 'basic', 'amqp://guest:2023?x@rabbit/', '2023?x');
  add('url-password-hash-user', 'basic', 'https://us#er:Synthetic-pw1@h.example.test/x', 'Synthetic-pw1');
  // P3: high-value formats that previously went out verbatim.
  const pgp = '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBGSyntheticFixtureOnlyNotAKey0123456789abcdefABCDEF\nSyntheticSecondLineOfArmor+/==\n=SyNt\n-----END PGP PRIVATE KEY BLOCK-----';
  add('pgp-private-key-block', 'basic', '导出的私钥：\n' + pgp + '\n别外传', pgp);
  const ppkPrivate = 'AAAAIFN5bnRoZXRpY1ByaXZhdGVGaXh0dXJlT25seQ==';
  const ppk = ['PuTTY-User-Key-File-3: ssh-ed25519', 'Encryption: none', 'Comment: synthetic-fixture', 'Public-Lines: 2',
    'AAAAC3NzaC1lZDI1NTE5AAAAIFN5bnRoZXRpY1B1YmxpY0ZpeHR1cmU=', 'AAAA', 'Private-Lines: 1', ppkPrivate,
    'Private-MAC: ' + '0f'.repeat(32)].join('\r\n');
  add('putty-ppk-file', 'basic', ppk, ppk);
  const truncated = ppk.split('\r\n').slice(0, 8).join('\n');
  add('putty-ppk-truncated', 'basic', truncated + '\n\n下面是我的问题：为什么连不上？', truncated);
  add('putty-private-lines-only', 'basic', '只贴了后半段：\nPrivate-Lines: 2\n' + ppkPrivate + '\nAAAASecondSyntheticLine=\n完', ppkPrivate + '\nAAAASecondSyntheticLine=');
  const accountKey = 'U3ludGhldGljQWNjb3VudEtleUZpeHR1cmVPbmx5' + 'PT0=';
  add('azure-storage-account-key', 'basic', 'DefaultEndpointsProtocol=https;AccountName=synthacct;AccountKey=' + accountKey + ';EndpointSuffix=core.windows.net', accountKey);
  const busKey = 'c3ludGhldGljLXNiLWtleS1maXh0dXJl' + 'LW9ubHk=';
  add('azure-servicebus-key', 'basic', 'Endpoint=sb://synthetic.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=' + busKey, busKey);
  const sas = 'sv=2022-11-02&ss=b&srt=co&sp=rl&se=2030-01-01T00:00:00Z&sig=c3ludGhldGljU2ln%3D';
  add('azure-sas-connection', 'basic', 'BlobEndpoint=https://synth.blob.core.windows.net/;SharedAccessSignature=' + sas, sas);
  add('mysql-attached-password', 'basic', 'mysql -h db.internal -P 3306 -uroot -pS3cr3t!Synthetic orderdb', 'S3cr3t!Synthetic');
  add('mysqldump-quoted-password', 'basic', "mysqldump -u backup -p'synthetic dump pass' --all-databases > all.sql", 'synthetic dump pass');
  add('mariadb-double-quoted-password', 'basic', 'mariadb -u app -p"Synthetic;Pass" app_db', 'Synthetic;Pass');
  // Neighbors that must stay visible: username-only userinfo, ports, interactive -p and other -p flags.
  const negatives = ['postgres://admin@localhost:5432/x', 'http://[::1]:8080/health', 'https://example.test:8443/a?email=ops', 'https://medium.example/@writer/post',
    'mysql -h db.internal -P 3306 -u root -p orderdb', 'mysql -u root -p', 'ssh -p2222 deploy@localhost', 'mkdir -p build/output',
    'Endpoint=sb://synthetic.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey', 'PuTTY 密钥文件格式说明：Private-Lines 后面跟行数',
    '-----BEGIN PGP PUBLIC KEY BLOCK----- 公钥可以公开',
    // Code that builds URLs is not userinfo (review of the v1 fallback).
    'import "http://localhost:{port}/@vite/client"', 'const u = `http://${host}:${port}/@fs/src/main.ts`',
    'fetch("http://localhost:"+port+"/api/x");el.on("a@b")',
    'docker run -d --name mysql -p3306:3306 mysql:8', 'const accountKey = process.env.AZURE_KEY', 'AccountKey=后面是密钥',
    'SharedAccessSignature=见文档'];
  return { cases, negatives };
}
module.exports = { createFormatGapCorpus };
