'use strict';
// 走查 W1 #3 / #9(04-visual-pipeline):图像载荷判定与图片附件 MIME。真源码、临时 HOME、零网络;
// VisualPipeline 经 server.js 已导出的 dispatchTestHooks 取,不增加导出面。
//   [P] looksLikeImagePayload 的非 data: 分支不再只看字符集:`{image:'bitnami/postgresql'}` 这类全小写标识符(容器镜像名等)恰好全是 base64
//       字符集,修前被当成截图,生成非法图片块 → provider 400,还写进 providerHistory 反复 400,并抹掉原字段。现在:魔数认得出的是图;
//       认不出时排除全小写标识符形状(镜像名按规范必须全小写)。真图(PNG/JPEG/GIF/WEBP/BMP 的 base64,含 base64url)照旧识别;
//       魔数认不出的未知格式 / 占位串(unit/tool-dispatch-hardening F3 与 vision-loop 夹具锁着的行为)照旧当图。
//   [M] 图片附件的 MIME 以字节魔数为准、扩展名兜底:文件名 .png 字节却是 JPEG 时,Anthropic Messages 协议对 media_type 与字节不符直接 400。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-visual-payload-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { VisualPipeline } = srv.dispatchTestHooks;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF'), Buffer.alloc(40, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(40, 4)]);
const BMP = Buffer.concat([Buffer.from('BM'), Buffer.alloc(40, 5)]);

test('[P1] 全小写标识符(镜像名/路径片段)不是图像:不被提取、字段不被抹掉', () => {
  const samples = ['bitnami/postgresql', 'library/ubuntu2204lts', 'nginx-ingress-controller', 'my_module_release_v2', 'registry/team/service-api', 'abcdefghijklmnop'];
  for (const text of samples) {
    const result = { image: text, image_base64: text, screenshot: { image: text }, images: [{ mimeType: 'image/png', data: text }], note: 'keep' };
    assert.deepEqual(VisualPipeline.extractToolImages(result), [], `${text}:不当截图`);
    const stripped = VisualPipeline.stripToolImageFields(result);
    assert.equal(stripped.image, text, `${text}:原字段不被占位文本替换`);
    assert.equal(stripped.image_base64, text);
    assert.equal(stripped.screenshot.image, text);
    assert.equal(stripped.images[0].data, text);
    assert.equal(VisualPipeline.stripToolImageFields(result, 'no-vision').image, text, `${text}:非视觉路径同样不抹`);
  }
  // 太短 / 带非 base64 字符的老规则不变
  for (const text of ['redis/redis', 'nginx:latest', 'C:\\pics\\a.png', 'a b c d e f g h']) assert.deepEqual(VisualPipeline.extractToolImages({ image: text }), [], text);
});

test('[P1b] 魔数认不出的未知格式 / 占位串(混合大小写)照旧当图 —— 既有 F3 行为不被收窄', () => {
  assert.match(VisualPipeline.extractToolImages({ image: 'FAKE_IMAGE_B64' })[0], /^data:image\/png;base64,/, '无任何线索:回落 png');
  assert.match(VisualPipeline.extractToolImages({ screenshot: { image: 'FAKE_IMAGE_B64', format: 'jpeg' } })[0], /^data:image\/jpeg;base64,/, '兄弟键声明的类型生效');
  // 魔数优先于「看起来像标识符」:真 PNG 头即使整串都落在小写标识符字符里也不会被误排除(此处用带大写的真头验证主路径)
  assert.equal(VisualPipeline.extractToolImages({ image: PNG.toString('base64') }).length, 1);
});

test('[P2] 真图照旧识别(PNG/JPEG/GIF/WEBP/BMP,标准 base64 与 base64url),mime 由魔数给出', () => {
  const cases = [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [GIF, 'image/gif'], [WEBP, 'image/webp'], [BMP, 'image/bmp']];
  for (const [buf, mime] of cases) {
    const b64 = buf.toString('base64');
    assert.deepEqual(VisualPipeline.extractToolImages({ image: b64 }), [`data:${mime};base64,${b64}`], `${mime}:顶层 image`);
    assert.equal(VisualPipeline.extractToolImages({ screenshot: { image: b64 } }).length, 1, `${mime}:screenshot.image`);
    assert.equal(VisualPipeline.extractToolImages({ images: [{ data: b64 }] }).length, 1, `${mime}:images[].data`);
    const stripped = VisualPipeline.stripToolImageFields({ image: b64, w: 1 });
    assert.notEqual(stripped.image, b64, `${mime}:真图仍会被占位替换(视觉路径另走图片消息)`);
  }
  const urlSafe = Buffer.concat([PNG, Buffer.from([0xfb, 0xff, 0xfe])]).toString('base64url');
  assert.equal(VisualPipeline.extractToolImages({ image: urlSafe }).length, 1, 'base64url 字符集的真图也认');
  // data: 分支不变:声明 image/* 就算图;非 image 的 data URI 不算
  assert.equal(VisualPipeline.extractToolImages({ image: 'data:image/png;base64,AAAA' }).length, 1);
  assert.deepEqual(VisualPipeline.extractToolImages({ image: 'data:text/plain;base64,AAAA' }), []);
});

test('[P3] sniffImageMime:五种魔数各一,其余空串', () => {
  const sniff = b => VisualPipeline.sniffImageMime(b.toString('base64'));
  assert.deepEqual([PNG, JPEG, GIF, WEBP, BMP].map(sniff), ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
  assert.equal(VisualPipeline.sniffImageMime(Buffer.from('<svg xmlns="x"></svg>').toString('base64')), '');
  assert.equal(VisualPipeline.sniffImageMime('bitnami/postgresql'), '');
});

test('[M] 图片附件 MIME:字节魔数优先,扩展名兜底', async () => {
  const dir = path.join(root, 'att');
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, buf) => { const p = path.join(dir, name); fs.writeFileSync(p, buf); return { name, path: p }; };
  const mimeOf = async att => {
    const parts = await VisualPipeline.buildUserContentParts('hi', [att]);
    const img = parts.find(p => p.type === 'image_url');
    assert.ok(img, `${att.name}:产出了图片块`);
    return /^data:([^;]+);base64,/.exec(img.image_url.url)[1];
  };
  assert.equal(await mimeOf(write('shot.png', JPEG)), 'image/jpeg', '.png 却是 JPEG 字节 → image/jpeg(修前按扩展名发 image/png,Anthropic 400)');
  assert.equal(await mimeOf(write('photo.jpg', PNG)), 'image/png', '.jpg 却是 PNG 字节 → image/png');
  assert.equal(await mimeOf(write('real.png', PNG)), 'image/png', '名实相符不变');
  assert.equal(await mimeOf(write('anim.gif', Buffer.alloc(64, 9))), 'image/gif', '认不出魔数:回落扩展名');
  // sendPath(上传时压缩出的派生件)的 mime 跟实际发送的文件走
  const orig = write('big.png', PNG);
  const derived = write('big.sent.jpg', JPEG);
  assert.equal(await mimeOf({ ...orig, sendPath: derived.path }), 'image/jpeg', '派生件按它自己的字节');
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
