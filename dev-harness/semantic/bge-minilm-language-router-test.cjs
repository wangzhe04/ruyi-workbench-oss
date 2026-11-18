'use strict';
const assert=require('node:assert/strict'),{route}=require('./bge-minilm-language-router.cjs');
for(const [text,expected] of [
  ['查找 ABC123 文件','zh'],['查找 foo/bar.js 和 `hello world`','zh'],
  ['查找 ```js\nhello world\n``` 内容','zh'],['查询 https://example.com/a foo@example.com','zh'],
  ['缓存 cache','mixed'],['缓存 café','mixed'],['café','en'],['123 !!!','unknown'],
  ['かな 한글','unknown'],['查找 cache 配置','mixed'],['hello world','en'],
  ['查找 ```unfinished code','zh'],['查找 C:\\Users\\test','zh'],['查找 abc-123','zh']
]) assert.equal(route(text),expected,JSON.stringify(text));
console.log('router edge cases: PASS');
