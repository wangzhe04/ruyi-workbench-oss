'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{stripIds}=require('../semantic/calibration-strip-ids.cjs');
test('ID experiment removes only shared-parser spans, preserving names/negation/numbers',()=>{
 const value='Marigold 不得在 -12.5°C 用 AB-91 替代 AB-910；速度48 kHz。';
 const result=stripIds(value);assert.equal(result.text,'Marigold 不得在 -12.5°C 用   替代  ；速度48 kHz。');assert.deepEqual(result.removedIdentifiers,['ab-91','ab-910']);
 assert.equal(stripIds('Marigold and seismology: do not remove 98 bolts.').text,'Marigold and seismology: do not remove 98 bolts.');
});
test('Unicode normalized ID span mapping leaves other original glyphs unchanged',()=>{
 const result=stripIds('ﬃ ㍻ 中文ＺＺ－９１ 与 e\u0301 仍在。');assert.equal(result.text,'ﬃ ㍻ 中文  与 e\u0301 仍在。');assert.deepEqual(result.removedIdentifiers,['zz-91']);
 assert.equal(stripIds('AB-ZZ-91 + ZZ-91').text,'  +  ','Multi-segment identifiers are removed as complete shared-parser matches.');
 assert.equal(stripIds('ZZ-910').text,' ');
});
test('rejected complete ID tokens do not leak internal suffix matches',()=>{
 for(const token of ['AB--ZZ-91','X'.repeat(17)+'-ZZ-91','AB-'+ '1'.repeat(254),'AB1-XY','2026-11-16'])assert.equal(stripIds(token).text,token);
 assert.equal(stripIds('AB-'+ '1'.repeat(253)).text,' ');
 assert.equal(stripIds('OP-12 AB_ZZ_91 ＡＢ：ＺＺ：９１').removedIdentifiers.join(','),'op-12,ab_zz_91,ab:zz:91');
 assert.equal(stripIds('OP-12: (OP-12) :AB-ZZ-91:').text,' : ( ) : :');
});
