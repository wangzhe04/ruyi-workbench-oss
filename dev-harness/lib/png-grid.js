'use strict';
// 像素基线的公共尺子(第 54 波 dom-screenshot 的那一套,128d 抽出来给管家壳像素基线共用)。
// 零 npm 依赖:只认 8 位 RGB/RGBA、非隔行的 PNG(Edge/Chrome 截图恰好就是这种);比对不逐像素,
// 而是把画面切成 cols×rows 格、每格取均色(隔一取一),再按「平均差」与「变了的格子占比」两道判。
// 这样字体抗锯齿、子像素这类机器间的小抖动被格子平均掉,而「一块面板换了底色／整块没画出来／版面错位」
// 这类真回归会让一片格子一起变。
const fs = require('fs');
const zlib = require('zlib');

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}

// file 可以是路径,也可以直接是 PNG 的 Buffer(CDP 截图拿到的就是 Buffer)。
function decodePng(file) {
  const png = Buffer.isBuffer(file) ? file : fs.readFileSync(file);
  if (png.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) throw new Error(`unsupported PNG ${bitDepth}/${colorType}/${interlace}`);
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  let source = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[source++];
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const value = raw[source++];
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x] || 0;
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      row[x] = filter === 0 ? value
        : filter === 1 ? value + left
          : filter === 2 ? value + up
            : filter === 3 ? value + Math.floor((left + up) / 2)
              : value + paeth(left, up, upperLeft);
    }
    for (let x = 0; x < width; x++) {
      const src = x * channels, dst = (y * width + x) * 4;
      pixels[dst] = row[src]; pixels[dst + 1] = row[src + 1]; pixels[dst + 2] = row[src + 2];
      pixels[dst + 3] = channels === 4 ? row[src + 3] : 255;
    }
    previous = row;
  }
  return { width, height, pixels };
}

function signature(file, cols = 12, rows = 8) {
  const image = decodePng(file);
  const grid = [];
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor(gx * image.width / cols), x1 = Math.floor((gx + 1) * image.width / cols);
      const y0 = Math.floor(gy * image.height / rows), y1 = Math.floor((gy + 1) * image.height / rows);
      let r = 0, g = 0, b = 0, count = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const i = (y * image.width + x) * 4;
        r += image.pixels[i]; g += image.pixels[i + 1]; b += image.pixels[i + 2]; count += 1;
      }
      grid.push(Math.round(r / count), Math.round(g / count), Math.round(b / count));
    }
  }
  return { width: image.width, height: image.height, cols, rows, grid };
}

// 阈值缺省即第 54 波定的那一组:每格三通道均差 > cellDelta 算「变了」;
// 通过 = 平均差 ≤ meanMax 且 变了的格子占比 ≤ changedMax。返回里带上变了的是哪几格(行,列),供失败时点名。
function compare(actual, expected, { cellDelta = 18, meanMax = 8, changedMax = 0.12 } = {}) {
  if (!actual || !expected || actual.width !== expected.width || actual.height !== expected.height
    || actual.grid.length !== expected.grid.length) {
    return { ok: false, mean: Infinity, changed: Infinity, cells: 0, changedCells: [], shapeMismatch: true };
  }
  let total = 0, changed = 0;
  const changedCells = [];
  const cols = actual.cols || 12;
  for (let i = 0; i < actual.grid.length; i += 3) {
    const delta = (Math.abs(actual.grid[i] - expected.grid[i])
      + Math.abs(actual.grid[i + 1] - expected.grid[i + 1])
      + Math.abs(actual.grid[i + 2] - expected.grid[i + 2])) / 3;
    total += delta;
    if (delta > cellDelta) {
      changed += 1;
      const cell = i / 3;
      changedCells.push([Math.floor(cell / cols), cell % cols, Math.round(delta)]);
    }
  }
  const cells = actual.grid.length / 3;
  return { ok: total / cells <= meanMax && changed / cells <= changedMax, mean: total / cells, changed, cells, changedCells };
}

module.exports = { decodePng, signature, compare };
