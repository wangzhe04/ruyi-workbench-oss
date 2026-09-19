// Unit(128d,48 号文 §1):像素基线的尺子 lib/png-grid —— dom-screenshot(经典壳)与 steward-shell-pixels(管家壳)共用。
//
// 尺子本身错了,两件像素件就一起「量得很准地错」:解码把某种行过滤器还原错,整张图的格子均色就偏,
// 基线与实拍一起偏、比对照样绿。所以这里用手搓的 PNG(五种行过滤器、RGB 与 RGBA 各一张)钉住解码逐字节正确,
// 再钉住格子均色与两道判据的算术。
//   A 五种过滤器(None／Sub／Up／Average／Paeth)逐行轮换编码,解出来与原像素逐字节相同(RGBA 与 RGB 各一张);
//   B 不认的格式(16 位、调色板、隔行)当场报错,不静默给出错图;
//   C 格子均色:左黑右白的图切 2×1,两格恰好是 (0,0,0) 与 (255,255,255);
//   D 比对:同一张 → 通过、平均差 0;只动一格 → 变了 1 格且点名是哪一格;尺寸不同 → 不通过(shapeMismatch)。
'use strict';

const assert = require('assert');
const path = require('path');
const zlib = require('zlib');
const { describe, it } = require('node:test');

const repo = path.resolve(__dirname, '../..');
const { decodePng, signature, compare } = require(path.join(repo, 'dev-harness', 'lib', 'png-grid.js'));

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}
// 按行轮换过滤器 0..4 编码(编码端独立实现,不复用被测的解码)。
function encodePng(width, height, channels, pixels, { bitDepth = 8, colorType = channels === 4 ? 6 : 2, interlace = 0 } = {}) {
  const stride = width * channels;
  const rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const filter = y % 5;
    const out = Buffer.alloc(stride + 1);
    out[0] = filter;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = prev[x];
      const ul = x >= channels ? prev[x - channels] : 0;
      const pred = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, ul);
      out[x + 1] = (row[x] - pred) & 0xff;
    }
    rows.push(out);
    prev = Buffer.from(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = interlace;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function noisy(width, height, channels, seed) {
  const buf = Buffer.alloc(width * height * channels);
  let s = seed;
  for (let i = 0; i < buf.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; buf[i] = s % 256; }
  return buf;
}

describe('png-grid:解码', () => {
  it('A RGBA:五种行过滤器轮换,逐字节还原', () => {
    const w = 7, h = 10, src = noisy(w, h, 4, 42);
    const got = decodePng(encodePng(w, h, 4, src));
    assert.equal(got.width, w); assert.equal(got.height, h);
    assert.ok(got.pixels.equals(src), 'RGBA 像素逐字节相同');
  });
  it('A RGB:补出 alpha=255,其余逐字节还原', () => {
    const w = 6, h = 10, src = noisy(w, h, 3, 7);
    const got = decodePng(encodePng(w, h, 3, src));
    for (let i = 0; i < w * h; i++) {
      assert.deepEqual([...got.pixels.subarray(i * 4, i * 4 + 4)], [src[i * 3], src[i * 3 + 1], src[i * 3 + 2], 255]);
    }
  });
  it('B 不认的格式当场报错', () => {
    const src = noisy(2, 2, 4, 1);
    assert.throws(() => decodePng(encodePng(2, 2, 4, src, { bitDepth: 16 })), /unsupported PNG/);
    assert.throws(() => decodePng(encodePng(2, 2, 4, src, { colorType: 3 })), /unsupported PNG/);
    assert.throws(() => decodePng(encodePng(2, 2, 4, src, { interlace: 1 })), /unsupported PNG/);
    assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
  });
});

describe('png-grid:格子与比对', () => {
  const w = 8, h = 4;
  const halves = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = x < w / 2 ? 0 : 255; const i = (y * w + x) * 4;
    halves[i] = v; halves[i + 1] = v; halves[i + 2] = v; halves[i + 3] = 255;
  }
  const png = encodePng(w, h, 4, halves);
  it('C 左黑右白切 2×1:两格恰好是黑与白', () => {
    const sig = signature(png, 2, 1);
    assert.deepEqual(sig.grid, [0, 0, 0, 255, 255, 255]);
    assert.equal(sig.cols, 2); assert.equal(sig.rows, 1);
  });
  it('D 同一张通过、平均差 0', () => {
    const r = compare(signature(png, 2, 1), signature(png, 2, 1));
    assert.equal(r.ok, true); assert.equal(r.mean, 0); assert.equal(r.changed, 0);
  });
  it('D 只动一格:变了 1 格且点名 (行 0, 列 1)', () => {
    const a = signature(png, 2, 1);
    const b = { ...a, grid: [0, 0, 0, 200, 200, 200] };
    const r = compare(a, b, { cellDelta: 18, meanMax: 100, changedMax: 1 });
    assert.equal(r.changed, 1);
    assert.deepEqual(r.changedCells.map(c => c.slice(0, 2)), [[0, 1]]);
    const strict = compare(a, b, { cellDelta: 18, meanMax: 8, changedMax: 0.12 });
    assert.equal(strict.ok, false, '平均差 27.5 超过 8 → 不通过');
  });
  it('D 尺寸不同不通过', () => {
    const other = encodePng(4, 4, 4, noisy(4, 4, 4, 3));
    const r = compare(signature(png, 2, 1), signature(other, 2, 1));
    assert.equal(r.ok, false); assert.equal(r.shapeMismatch, true);
  });
});
