'use strict';
// isContextOverflowError(10;模式在 context-governance-rules.json 的 overflow 段)的判据面。它决定 400/413/422 之后
// 要不要走「强压重试」(快照 → L1 蒸发 → L2 摘要重播种),所以两边都要钉:
//   [O1] 各家真实的「上下文超窗」措辞都认得出来 —— 审计 t11 漏掉的三种:「exceed(s) the configured limit」(input
//        tokens 超配置上限)、「input is too long」、裸 HTTP 413(网关/反代只回状态、不带正文或只带 Request Entity Too Large)。
//   [O2] 不是超窗的 4xx 不许被吸进破坏性压缩(45f P1-1 的纪律):工具 schema 非法、功能不支持、max_tokens 参数越界、
//        鉴权失败、正文里碰巧出现 413 的 400、非 4xx 状态带同样措辞。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-overflow-detect-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const { isContextOverflowError } = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));

const OVERFLOW = [
  // 审计 t11 新增覆盖
  'HTTP 400: {"error":{"message":"Input tokens exceed the configured limit of 131072 tokens. Your messages resulted in 140000 tokens."}}',
  'HTTP 400: {"error":{"message":"input is too long for requested model"}}',
  'HTTP 413: Request Entity Too Large',
  'HTTP 413',
  'HTTP 413: <html><body>nginx</body></html>',
  'HTTP 400: {"error":{"message":"prompt exceeds the configured limit"}}',
  // 修前就认得的(回归不许掉)
  'HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 188240 + 64000 > 200000, decrease input length or `max_tokens` and try again"}}',
  'HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
  'HTTP 400: {"error":{"message":"Range of input length should be [1, 129024]","type":"invalid_request_error"}}',
  'HTTP 400: {"error":{"message":"This model\'s maximum context length is 65536 tokens. However, you requested 70000 tokens","code":"context_length_exceeded"}}',
  'HTTP 400: {"error":{"message":"The input token count (1200000) exceeds the maximum number of tokens allowed (1048576)."}}',
  'HTTP 400: {"error":{"message":"input too long"}}',
];
const NOT_OVERFLOW = [
  'HTTP 400: {"error":{"message":"Invalid schema for function \'file_read\': In context=(\'properties\', \'path\'), \'type\' is required","type":"invalid_request_error"}}',
  'HTTP 400: {"error":{"message":"function calling is not supported in this context"}}',
  'HTTP 400: {"error":{"message":"max_tokens exceeds the configured limit of 8192"}}',
  'HTTP 400: {"error":{"message":"Invalid value for \'temperature\': must be between 0 and 2"}}',
  'HTTP 422: {"detail":[{"loc":["body","messages",0,"role"],"msg":"value is not a valid enumeration member"}]}',
  'HTTP 401: {"error":{"message":"Incorrect API key provided"}}',
  'HTTP 400: {"error":{"message":"tool_call_id call_413 has no matching tool_calls"}}',
  'HTTP 500: Request Entity Too Large',
  'HTTP 502: input is too long',
  'fetch failed: ECONNREFUSED 127.0.0.1:413',
  '',
];

test('[O1] 各家「上下文超窗」措辞都判成超窗', () => {
  for (const e of OVERFLOW) assert.equal(isContextOverflowError(e), true, '漏判:' + e);
});

test('[O2] 非超窗的错误不判成超窗', () => {
  for (const e of NOT_OVERFLOW) assert.equal(isContextOverflowError(e), false, '误判:' + e);
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
