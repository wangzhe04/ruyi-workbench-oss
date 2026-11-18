'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const basePath = path.join(__dirname, 'scalar-window-public-consumer-fixture.cjs'), hash = data => crypto.createHash('sha256').update(data).digest('hex');
let source = fs.readFileSync(basePath, 'utf8');
if (hash(source) !== 'e6982644932dbe145f860b2012b7918184519a29cb867fcf75c9361053311051') throw Error('Window-only fixture changed.');
const before = "'./scalar-window-live-layout.cjs'", after = "'./scalar-window-append-live-layout.cjs'";
if (source.split(before).length !== 2) throw Error('Append fixture layout selector changed.');
const compiled = new Module(__filename, module); compiled.filename = __filename; compiled.paths = Module._nodeModulePaths(__dirname); compiled._compile(source.replace(before, after), __filename); module.exports = compiled.exports;
