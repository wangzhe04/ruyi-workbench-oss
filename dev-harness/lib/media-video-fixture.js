'use strict';

const size = 32;
const fps = 4;
const audioRate = 8000;
const samplesPerFrame = audioRate / fps;
const frameBytes = size * size * 3;
const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]];
const audioCanary = 'SYNTHETIC_AUDIO_DO_NOT_SEND';
const metadataCanary = 'SYNTHETIC_CONTAINER_TITLE_DO_NOT_SEND';

function chunk(tag, data) {
  const header = Buffer.alloc(8);
  header.write(tag);
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}

function list(type, ...items) {
  return chunk('LIST', Buffer.concat([Buffer.from(type), ...items]));
}

function streamHeader(type, format, rate, length, bytes, sampleSize) {
  const value = Buffer.alloc(56);
  value.write(type, 0);
  value.write(format, 4);
  value.writeUInt32LE(1, 20); // scale
  value.writeUInt32LE(rate, 24);
  value.writeUInt32LE(length, 32);
  value.writeUInt32LE(bytes, 36); // suggested buffer size
  value.writeUInt32LE(sampleSize, 44);
  return chunk('strh', value);
}

// Independent, deterministic RIFF fixture. Each timestamp maps to a distinct
// solid video frame, interleaved with an unrelated audio track and a title tag.
function makeVideoFixture() {
  const header = Buffer.alloc(56);
  header.writeUInt32LE(1_000_000 / fps, 0);
  header.writeUInt32LE((frameBytes + samplesPerFrame) * fps, 4);
  header.writeUInt32LE(0x100, 12); // interleaved
  header.writeUInt32LE(colors.length, 16);
  header.writeUInt32LE(2, 24);
  header.writeUInt32LE(frameBytes, 28);
  header.writeUInt32LE(size, 32);
  header.writeUInt32LE(size, 36);

  const bitmap = Buffer.alloc(40);
  bitmap.writeUInt32LE(bitmap.length, 0);
  bitmap.writeInt32LE(size, 4);
  bitmap.writeInt32LE(size, 8);
  bitmap.writeUInt16LE(1, 12);
  bitmap.writeUInt16LE(24, 14);
  bitmap.writeUInt32LE(frameBytes, 20);

  const pcm = Buffer.alloc(16);
  pcm.writeUInt16LE(1, 0); // PCM, mono
  pcm.writeUInt16LE(1, 2);
  pcm.writeUInt32LE(audioRate, 4);
  pcm.writeUInt32LE(audioRate, 8);
  pcm.writeUInt16LE(1, 12);
  pcm.writeUInt16LE(8, 14);

  const tracks = list('hdrl', chunk('avih', header),
    list('strl', streamHeader('vids', 'DIB ', fps, colors.length, frameBytes, 0), chunk('strf', bitmap)),
    list('strl', streamHeader('auds', '', audioRate, colors.length * samplesPerFrame, samplesPerFrame, 1), chunk('strf', pcm)));
  const audio = Buffer.alloc(samplesPerFrame, audioCanary);
  const frames = colors.flatMap(([red, green, blue]) => [chunk('00db', Buffer.alloc(frameBytes, Buffer.from([blue, green, red]))), chunk('01wb', audio)]);
  const tags = list('INFO', chunk('INAM', Buffer.from(metadataCanary + '\0')));
  return chunk('RIFF', Buffer.concat([Buffer.from('AVI '), tracks, tags, list('movi', ...frames)]));
}

module.exports = { makeVideoFixture, colors, audioCanary, metadataCanary };
