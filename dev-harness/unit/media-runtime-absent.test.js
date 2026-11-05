'use strict';
// M4 的媒体运行时缺席拒绝面:ffmpeg / ffprobe 不在时,media_probe 与 audio_inspect 必须给出
// 具体依赖名 + 可执行的下一步,而不是空结果、也不是「解码失败」。把「找不到」做成确定的:
// PATH 只留一个空目录,三个能把真实 ffmpeg 指进来的入口(IMAGEIO_FFMPEG_EXE / FFMPEG_BINARY /
// RUYI_BUNDLED_PYTHON)全部指到不存在的位置 —— 本机装了 ffmpeg 也不会误绿。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-media-absent-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
const emptyBin = path.join(root, 'empty-bin'); fs.mkdirSync(emptyBin);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
process.env.PATH = emptyBin;
process.env.IMAGEIO_FFMPEG_EXE = path.join(root, 'missing-ffmpeg.exe');
process.env.FFMPEG_BINARY = path.join(root, 'missing-ffmpeg-2.exe');
process.env.RUYI_BUNDLED_PYTHON = path.join(root, 'missing-python.exe');
delete process.env.VIRTUAL_ENV;
const app = require('../lib/server-internals').loadServerInternals(['MediaInspection']);

test('media_probe:ffmpeg / ffprobe 缺席时给 available:false + 可执行 hint,且不做安装', async () => {
  const probe = await app.MediaInspection.dependencies(true);
  assert.equal(probe.ok, true);
  assert.equal(probe.installsPerformed, false);
  for (const kind of ['ffmpeg', 'ffprobe']) {
    const value = probe.dependencies[kind];
    assert.equal(value.available, false, kind + ' 不该被找到');
    assert.equal(value.path, null);
    assert.equal(typeof value.hint, 'string');
    assert.ok(value.hint.length > 20, kind + ' 的 hint 要说清怎么装');
  }
  assert.match(probe.dependencies.ffmpeg.hint, /IMAGEIO_FFMPEG_EXE|PATH/);
});

test('audio_inspect:运行时缺席给 dependency_missing(不是解码失败,也不是空结果)', async () => {
  const wav = path.join(data, 'clip.wav');
  fs.writeFileSync(wav, Buffer.from('RIFF0000WAVEfmt '));   // 存在但不需要真的可解码:缺席判定在解码之前
  const r = await app.MediaInspection.inspectAudio(wav, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'dependency_missing');
  assert.equal(r.dependency, 'ffmpeg');
  assert.match(r.hint, /ffmpeg|FFmpeg/);
  // 扩展名这一支仍是 unsupported_media —— 与「依赖缺席」分开,别把两件事混成一个码。
  const other = await app.MediaInspection.inspectAudio(path.join(data, 'playlist.m3u'), {});
  assert.equal(other.code, 'unsupported_media');
});

after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
