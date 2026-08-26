'use strict';

// Real, credential-free Kimi ACP probe.
//
// The model is deliberately local and deterministic; Kimi ACP, Ruyi, and the
// native tools are not faked. Every mutable path is below a per-run mkdtemp
// root and is removed only after child-process cleanup and containment checks.

const fs = require('fs');
const fsp = fs.promises;
const cp = require('child_process');
const { promisify } = require('util');
const http = require('http');
const os = require('os');
const path = require('path');

const execFile = promisify(cp.execFile);
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const KIMI_COMPAT_REGISTER = path.join(WB, 'resources', 'kimi-acp-compat-register.mjs');
const PROBE_TIMEOUT_MS = 90000;

const CASES = {
  handshake: {
    marker: 'KIMI_LIVE_PROBE_HANDSHAKE',
    permissionMode: 'default',
    prompt: 'KIMI_LIVE_PROBE_HANDSHAKE: reply with the fixed acknowledgement only.',
    expectedTools: [],
    final: 'KIMI_LIVE_PROBE_HANDSHAKE_OK',
  },
  read: {
    marker: 'KIMI_LIVE_PROBE_READ',
    permissionMode: 'default',
    prompt: 'KIMI_LIVE_PROBE_READ: use Glob, Grep, and Read on the prepared files, then finish.',
    expectedTools: ['Glob', 'Grep', 'Read'],
    final: 'KIMI_LIVE_PROBE_READ_OK',
  },
  write: {
    marker: 'KIMI_LIVE_PROBE_WRITE',
    permissionMode: 'default',
    prompt: 'KIMI_LIVE_PROBE_WRITE: use Write to create the requested probe file, then finish.',
    expectedTools: ['Write'],
    final: 'KIMI_LIVE_PROBE_WRITE_OK',
  },
  planEnter: {
    marker: 'KIMI_LIVE_PROBE_PLAN_ENTER',
    permissionMode: 'default',
    prompt: 'KIMI_LIVE_PROBE_PLAN_ENTER: enter plan mode, write the plan, exit for approval, then perform the approved business Write to plan-executed.txt and finish.',
    expectedTools: ['EnterPlanMode', 'Write', 'ExitPlanMode'],
    final: 'KIMI_LIVE_PROBE_PLAN_ENTER_OK',
    planMode: false,
    planApproval: true,
  },
  plan: {
    marker: 'KIMI_LIVE_PROBE_PLAN_MODE',
    permissionMode: 'plan',
    prompt: 'KIMI_LIVE_PROBE_PLAN_MODE: you are already in native plan mode; write the plan, exit for approval, then perform the approved business Write to plan-executed.txt and finish.',
    expectedTools: ['Write', 'ExitPlanMode'],
    final: 'KIMI_LIVE_PROBE_PLAN_MODE_OK',
    planMode: true,
    planApproval: true,
  },
  planSearch: {
    marker: 'KIMI_LIVE_PROBE_PLAN_SEARCH',
    permissionMode: 'plan',
    prompt: 'KIMI_LIVE_PROBE_PLAN_SEARCH: before plan approval, use Glob and Grep to inspect the prepared files and verify their hits; then write the plan and exit plan mode.',
    expectedTools: ['Glob', 'Grep', 'Write', 'ExitPlanMode'],
    final: 'KIMI_LIVE_PROBE_PLAN_SEARCH_OK',
    planMode: true,
    planApproval: true,
  },
  acceptEdits: {
    marker: 'KIMI_LIVE_PROBE_ACCEPT_EDITS',
    permissionMode: 'acceptEdits',
    prompt: 'KIMI_LIVE_PROBE_ACCEPT_EDITS: use Write, ask one structured question, then run Bash, then finish.',
    expectedTools: ['Write', 'AskUserQuestion', 'Bash'],
    final: 'KIMI_LIVE_PROBE_ACCEPT_EDITS_OK',
    optional: true,
  },
};

const report = { failures: 0, skips: 0, passes: 0 };
const activeChildren = new Set();
const PLAN_EXECUTED_FILE = 'plan-executed.txt';
const PLAN_APPROVAL_LABEL = 'Execute with verified workspace write';

function exitPlanArguments() {
  return {
    options: [
      { label: 'Execute with current plan', description: 'Run the plan as currently written.' },
      { label: PLAN_APPROVAL_LABEL, description: 'Run the plan and verify the resulting workspace file.' },
    ],
  };
}

function logPass(label, detail) {
  report.passes += 1;
  console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
}

function logFail(label, detail) {
  report.failures += 1;
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

function logSkip(label, detail) {
  report.skips += 1;
  console.log(`SKIP ${label}${detail ? ` — ${detail}` : ''}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isInside(root, target) {
  const base = path.resolve(root);
  const candidate = path.resolve(target);
  if (process.platform === 'win32') {
    const a = base.toLowerCase();
    const b = candidate.toLowerCase();
    return b === a || b.startsWith(a.endsWith(path.sep) ? a : `${a}${path.sep}`);
  }
  return candidate === base || candidate.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`);
}

function safeRemoveMkdtemp(root, generatedPaths = []) {
  const tempRoot = path.resolve(os.tmpdir());
  const target = path.resolve(root);
  if (target === tempRoot || !isInside(tempRoot, target)) {
    throw new Error(`refusing cleanup outside mkdtemp root: ${target}`);
  }
  for (const generated of generatedPaths) {
    if (!isInside(target, generated)) throw new Error(`refusing cleanup of path outside probe root: ${generated}`);
  }
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function redact(text, tempRoot = '') {
  let value = String(text || '');
  if (tempRoot) value = value.split(tempRoot).join('<probe-root>');
  return value
    .replace(/Bearer\s+[^\s\r\n]+/gi, 'Bearer <redacted>')
    .replace(/(api[_-]?key|token|secret|password)["'=:\s]+[^,\s}\r\n]+/gi, '$1=<redacted>')
    .slice(-4000);
}

function scrubbedEnv(overrides) {
  const blocked = /^(?:ANTHROPIC_.+|OPENAI_.+|AZURE_OPENAI_.+|GOOGLE_API_KEY|GEMINI_.+|KIMI_API_KEY|KIMI_BASE_URL|KIMI_CODE_OAUTH.*|KIMI_MODEL_.+|KIMI_REGISTRY_API_KEY|CLAUDE_CONFIG_DIR|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)$/i;
  const credentialName = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|AUTH(?:ORIZATION)?|CREDENTIAL|OAUTH)/i;
  const processControl = /^(?:NPM_CONFIG_.+|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|(?:HTTP|HTTPS|ALL|NO)_PROXY)$/i;
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!blocked.test(key) && !credentialName.test(key) && !processControl.test(key)) env[key] = value;
  }
  delete env.KIMI_CODE_OAUTH_TOKEN;
  delete env.KIMI_CODE_OAUTH_ACCESS_TOKEN;
  delete env.KIMI_CODE_OAUTH_REFRESH_TOKEN;
  return { ...env, ...overrides };
}

function isRegularFile(candidate) {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

function pathKey(candidate) {
  const value = path.resolve(candidate);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function findOnPath(names, pathValue = process.env.PATH) {
  const requested = Array.isArray(names) ? names : [names];
  const pathEntries = String(pathValue || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const directory = entry.replace(/^"|"$/g, '');
    for (const name of requested) {
      const candidates = [name];
      if (process.platform === 'win32' && !path.extname(name)) candidates.push(`${name}.cmd`, `${name}.exe`, `${name}.ps1`);
      for (const candidate of candidates) {
        const resolved = path.resolve(directory, candidate);
        if (isRegularFile(resolved)) return resolved;
      }
    }
  }
  return '';
}

function resolveKimiNpmEntry(launcher) {
  if (!launcher) return '';
  const directory = path.dirname(path.resolve(launcher));
  const packageTail = path.join('node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');
  const candidates = [
    path.join(directory, packageTail),
    path.join(directory, '..', packageTail),
    path.join(directory, '..', 'lib', packageTail),
  ];
  return candidates.find(isRegularFile) || '';
}

function npmGlobalPrefix() {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const output = cp.execFileSync(command, ['prefix', '-g'], {
      cwd: WB,
      env: scrubbedEnv({
        npm_config_loglevel: 'silent',
        npm_config_userconfig: path.join(os.tmpdir(), `ruyi-kimi-live-probe-${process.pid}.npmrc`),
        npm_config_globalconfig: path.join(os.tmpdir(), `ruyi-kimi-live-probe-${process.pid}.global.npmrc`),
      }),
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 4000,
      encoding: 'utf8',
    });
    return String(output || '').trim().split(/\r?\n/).map(value => value.trim()).find(Boolean) || '';
  } catch {
    return '';
  }
}

function discoverKimiCli() {
  const launcherCandidates = [];
  const entryCandidates = [];
  const seenLaunchers = new Set();
  const seenEntries = new Set();
  const searched = [];
  const addLauncher = (value, source) => {
    if (!value) return;
    const resolved = path.isAbsolute(value) || /[\\/]/.test(value) ? path.resolve(value) : findOnPath(value);
    searched.push(`${source}:${value}`);
    if (!resolved || !isRegularFile(resolved)) return;
    const key = pathKey(resolved);
    if (seenLaunchers.has(key)) return;
    seenLaunchers.add(key);
    launcherCandidates.push({ path: resolved, source });
  };
  const addEntry = (value, source) => {
    if (!value) return;
    const resolved = path.isAbsolute(value) || /[\\/]/.test(value) ? path.resolve(value) : '';
    searched.push(`${source}:${value}`);
    if (!resolved || !isRegularFile(resolved)) return;
    const key = pathKey(resolved);
    if (seenEntries.has(key)) return;
    seenEntries.add(key);
    entryCandidates.push({ path: resolved, source });
  };
  const addExplicit = (name, value) => {
    if (!value) return;
    const looksLikeEntry = /\.(?:mjs|cjs|js)$/i.test(String(value)) || /[\\/]main\.mjs$/i.test(String(value));
    if (looksLikeEntry) addEntry(value, `${name} env override`);
    else addLauncher(value, `${name} env override`);
  };

  for (const [name, value] of [
    ['RUYI_KIMI_CLI_PATH', process.env.RUYI_KIMI_CLI_PATH],
    ['KIMI_CLI_PATH', process.env.KIMI_CLI_PATH],
    ['KIMI_PATH', process.env.KIMI_PATH],
    ['KIMI_ENTRY', process.env.KIMI_ENTRY],
  ]) addExplicit(name, value);

  if (process.env.APPDATA) {
    for (const name of ['kimi.cmd', 'kimi.ps1', 'kimi.exe']) addLauncher(path.join(process.env.APPDATA, 'npm', name), 'APPDATA/npm');
  }
  const prefix = npmGlobalPrefix();
  if (prefix) {
    for (const name of process.platform === 'win32' ? ['kimi.cmd', 'kimi.ps1', 'kimi.exe'] : ['kimi']) {
      addLauncher(path.join(prefix, name), 'npm prefix -g');
      addLauncher(path.join(prefix, 'bin', name), 'npm prefix -g/bin');
    }
    addEntry(path.join(prefix, 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs'), 'npm prefix -g package');
    addEntry(path.join(prefix, 'lib', 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs'), 'npm prefix -g package');
  }
  for (const name of process.platform === 'win32' ? ['kimi.cmd', 'kimi.ps1', 'kimi.exe', 'kimi'] : ['kimi']) {
    const found = findOnPath(name);
    if (found) addLauncher(found, 'PATH');
  }

  for (const candidate of launcherCandidates) {
    const entry = resolveKimiNpmEntry(candidate.path);
    if (entry) return { launcher: candidate.path, entry, source: candidate.source, searched };
  }
  const entry = entryCandidates[0];
  if (entry) {
    return {
      launcher: '',
      entry: entry.path,
      source: entry.source,
      searched,
      skipReason: `Kimi entry found at ${entry.path}, but no Ruyi-compatible npm launcher shim resolved to it`,
    };
  }
  return { launcher: '', entry: '', searched, skipReason: `Kimi CLI not found; searched ${searched.join(', ') || 'explicit overrides, APPDATA/npm, npm prefix -g, PATH'}` };
}

function listenLoopback(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('loopback listener did not expose a TCP port'));
      resolve({ server, port: address.port });
    });
  });
}

function closeHttpServer(server) {
  return new Promise(resolve => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

function collectRequestBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(new Error('request body exceeded probe limit'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function contentText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (value.content !== undefined) return contentText(value.content);
    if (value.output !== undefined) return contentText(value.output);
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function allMessageText(messages) {
  return (Array.isArray(messages) ? messages : []).map(message => contentText(message && message.content)).join('\n');
}

function caseFromMessages(messages) {
  const text = allMessageText(messages);
  for (const [name, spec] of Object.entries(CASES)) if (text.includes(spec.marker)) return name;
  return 'unknown';
}

function extractToolDefinitions(body) {
  const definitions = new Map();
  for (const item of Array.isArray(body && body.tools) ? body.tools : []) {
    const fn = item && item.function && typeof item.function === 'object' ? item.function : item;
    const name = String(fn && (fn.name || item && item.name) || '').trim();
    if (!name) continue;
    const parameters = fn.parameters || fn.input_schema || fn.inputSchema || item.inputSchema || {};
    definitions.set(name, { name, parameters });
  }
  return definitions;
}

function priorToolCalls(messages) {
  const calls = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const call of Array.isArray(message && message.tool_calls) ? message.tool_calls : []) {
      const fn = call && call.function || {};
      let args = fn.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      calls.push({ id: String(call && call.id || ''), name: String(fn.name || ''), args: args && typeof args === 'object' ? args : {} });
    }
    if (message && message.tool_call && message.tool_call.function && message.tool_call.function.name) {
      const call = message.tool_call;
      let args = call.function.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      calls.push({ id: String(call.id || ''), name: String(call.function.name), args: args && typeof args === 'object' ? args : {} });
    }
  }
  return calls;
}

function priorToolCallNames(messages) {
  return new Set(priorToolCalls(messages).map(call => call.name).filter(Boolean));
}

function previousToolResultTexts(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message && (message.role === 'tool' || message.tool_call_id || message.role === 'tool_result'))
    .map(message => contentText(message.content || message.output || message.result));
}

function planPathFromMessages(messages) {
  const texts = [allMessageText(messages), ...previousToolResultTexts(messages)].reverse();
  for (const text of texts) {
    const matches = [...String(text).matchAll(/plan file\s*:\s*(?:`([^`]+)`|([^\r\n]+))/ig)];
    for (let i = matches.length - 1; i >= 0; i--) {
      const value = String(matches[i][1] || matches[i][2] || '').trim();
      if (value && !/^none|null$/i.test(value)) return value;
    }
  }
  return '';
}

const TOOL_SCHEMA_REQUIREMENTS = {
  Read: ['path'],
  Write: ['path', 'content'],
  Grep: ['pattern'],
  Glob: ['pattern'],
  EnterPlanMode: [],
  ExitPlanMode: [],
  AskUserQuestion: ['questions'],
  Bash: ['command'],
};

function validateToolSchemas(definitions, names) {
  const errors = [];
  for (const name of names) {
    const definition = definitions.get(name);
    if (!definition) {
      errors.push(`${name} not advertised`);
      continue;
    }
    const schema = definition.parameters && typeof definition.parameters === 'object' ? definition.parameters : {};
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
    for (const field of TOOL_SCHEMA_REQUIREMENTS[name] || []) {
      if (!Object.prototype.hasOwnProperty.call(properties, field)) errors.push(`${name}.${field} missing from properties`);
      if (!required.has(field)) errors.push(`${name}.${field} missing from required`);
    }
  }
  return errors;
}

function call(name, args, sequence) {
  return {
    id: `kimi-live-${sequence}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function nextFixtureResponse(caseName, state, body, definitions) {
  const spec = CASES[caseName];
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const priorCalls = priorToolCalls(messages);
  const called = new Set(priorCalls.map(callItem => callItem.name).filter(Boolean));
  const writes = priorCalls.filter(callItem => callItem.name === 'Write');
  const ensure = name => {
    if (definitions.has(name)) return true;
    state.missingTools.push(`${name} not advertised by Kimi request`);
    return false;
  };
  const tool = (name, args) => ensure(name)
    ? { toolCalls: [call(name, args, ++state.sequence)] }
    : { text: `KIMI_LIVE_PROBE_SCHEMA_MISSING:${name}` };

  if (caseName === 'handshake') return { text: spec.final };
  if (caseName === 'read') {
    if (!called.has('Glob')) return tool('Glob', { pattern: '*.txt', path: '.' });
    if (!called.has('Grep')) return tool('Grep', { pattern: 'KIMI_PROBE_MARKER', path: '.', output_mode: 'content', '-n': true });
    if (!called.has('Read')) return tool('Read', { path: 'read-source.txt' });
    return { text: spec.final };
  }
  if (caseName === 'write') {
    if (!called.has('Write')) return tool('Write', { path: 'write-output.txt', content: 'KIMI_PROBE_WRITE_OK\n', mode: 'overwrite' });
    return { text: spec.final };
  }
  if (caseName === 'planEnter') {
    if (!called.has('EnterPlanMode')) return tool('EnterPlanMode', {});
    if (writes.length === 0) {
      const planPath = planPathFromMessages(messages) || 'plan/kimi-live-plan.md';
      return tool('Write', { path: planPath, content: '# Kimi live probe plan\n- Verify real ACP tools\n', mode: 'overwrite' });
    }
    if (!called.has('ExitPlanMode')) return tool('ExitPlanMode', exitPlanArguments());
    if (writes.length === 1) return tool('Write', { path: PLAN_EXECUTED_FILE, content: 'KIMI_PROBE_PLAN_EXECUTED_OK\n', mode: 'overwrite' });
    return { text: spec.final };
  }
  if (caseName === 'plan') {
    if (writes.length === 0) {
      const planPath = planPathFromMessages(messages) || 'plan/kimi-live-plan.md';
      return tool('Write', { path: planPath, content: '# Kimi live probe plan\n- Verify real ACP tools\n', mode: 'overwrite' });
    }
    if (!called.has('ExitPlanMode')) return tool('ExitPlanMode', exitPlanArguments());
    if (writes.length === 1) return tool('Write', { path: PLAN_EXECUTED_FILE, content: 'KIMI_PROBE_PLAN_EXECUTED_OK\n', mode: 'overwrite' });
    return { text: spec.final };
  }
  if (caseName === 'planSearch') {
    if (!called.has('Glob')) return tool('Glob', { pattern: '*.txt', path: '.' });
    if (!called.has('Grep')) return tool('Grep', { pattern: 'KIMI_PROBE_MARKER', path: '.', output_mode: 'content', '-n': true });
    if (!called.has('Write')) {
      const planPath = planPathFromMessages(messages) || 'plan/kimi-live-plan-search.md';
      return tool('Write', { path: planPath, content: '# Kimi live probe search plan\n- Search hits verified before approval\n', mode: 'overwrite' });
    }
    if (!called.has('ExitPlanMode')) return tool('ExitPlanMode', exitPlanArguments());
    return { text: spec.final };
  }
  if (caseName === 'acceptEdits') {
    if (!called.has('Write')) return tool('Write', { path: 'accept-edits-output.txt', content: 'KIMI_PROBE_ACCEPT_EDITS_OK\n', mode: 'overwrite' });
    if (!called.has('AskUserQuestion')) return tool('AskUserQuestion', {
      questions: [{
        question: 'Which deterministic probe option should be used?',
        header: 'Probe',
        options: [
          { label: 'Alpha', description: 'Use the first fixture option.' },
          { label: 'Beta', description: 'Use the second fixture option.' },
        ],
        multi_select: false,
      }],
    });
    if (!called.has('Bash')) return tool('Bash', { command: 'printf KIMI_PROBE_BASH_OK' });
    return { text: spec.final };
  }
  return { text: 'KIMI_LIVE_PROBE_UNCLASSIFIED_REQUEST' };
}

function completionPayload(body, response, sequence) {
  const id = `kimi-live-completion-${sequence}`;
  const created = Math.floor(Date.now() / 1000);
  const toolCalls = response.toolCalls;
  const message = toolCalls
    ? { role: 'assistant', content: null, tool_calls: toolCalls }
    : { role: 'assistant', content: String(response.text || '') };
  return {
    id,
    object: 'chat.completion',
    created,
    model: String(body && body.model || 'fixture-model'),
    choices: [{ index: 0, message, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 101, completion_tokens: toolCalls ? 13 : 7, total_tokens: toolCalls ? 114 : 108 },
  };
}

function sendCompletion(res, body, response, sequence) {
  const payload = completionPayload(body, response, sequence);
  if (!body || body.stream !== true) {
    const raw = JSON.stringify(payload);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) });
    res.end(raw);
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const choice = payload.choices[0];
  const firstDelta = choice.message.tool_calls
    ? { role: 'assistant', tool_calls: choice.message.tool_calls.map((item, index) => ({
      index, id: item.id, type: 'function', function: item.function,
    })) }
    : { role: 'assistant', content: choice.message.content };
  const first = { id: payload.id, object: 'chat.completion.chunk', created: payload.created, model: payload.model, choices: [{ index: 0, delta: firstDelta, finish_reason: null }] };
  const finish = { id: payload.id, object: 'chat.completion.chunk', created: payload.created, model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: payload.usage };
  res.write(`data: ${JSON.stringify(first)}\n\n`);
  res.write(`data: ${JSON.stringify(finish)}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function startFixtureModel() {
  const state = { requestSequence: 0, cases: new Map(), requests: [], errors: [] };
  const listener = await listenLoopback(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
        const raw = JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model', owned_by: 'ruyi-live-probe' }] });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) });
        res.end(raw);
        return;
      }
      if (req.method !== 'POST' || !['/v1/chat/completions', '/chat/completions'].includes(req.url)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'fixture endpoint not found' } }));
        return;
      }
      const rawBody = await collectRequestBody(req);
      const body = JSON.parse(rawBody);
      const caseName = caseFromMessages(body.messages);
      let caseState = state.cases.get(caseName);
      if (!caseState) {
        caseState = { sequence: 0, missingTools: [], schemaErrors: [], toolNames: new Set(), toolCalls: [] };
        state.cases.set(caseName, caseState);
      }
      const definitions = extractToolDefinitions(body);
      for (const name of definitions.keys()) caseState.toolNames.add(name);
      if (caseState.schemaErrors.length === 0 && CASES[caseName]) {
        caseState.schemaErrors = validateToolSchemas(definitions, CASES[caseName].expectedTools);
      }
      const requestInfo = {
        caseName,
        model: String(body.model || ''),
        stream: body.stream === true,
        toolNames: [...definitions.keys()].sort(),
        roles: Array.isArray(body.messages) ? body.messages.map(message => String(message && message.role || '')) : [],
      };
      state.requests.push(requestInfo);
      const response = nextFixtureResponse(caseName, caseState, body, definitions);
      for (const callItem of Array.isArray(response && response.toolCalls) ? response.toolCalls : []) {
        const fn = callItem && callItem.function || {};
        let args = fn.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        caseState.toolCalls.push({
          id: String(callItem && callItem.id || ''),
          name: String(fn.name || ''),
          args: args && typeof args === 'object' ? args : {},
        });
      }
      sendCompletion(res, body, response, ++state.requestSequence);
    } catch (error) {
      state.errors.push(String(error && error.message || error));
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture request rejected' } }));
    }
  });
  return { ...listener, state };
}

function requestRaw(port, method, pathname, body, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      timeout: timeoutMs,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) }),
        ...headers,
      },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`HTTP ${method} ${pathname} timed out`)));
    if (body !== undefined) req.write(raw);
    req.end();
  });
}

async function requestJson(port, method, pathname, body, token, timeoutMs = 10000) {
  const response = await requestRaw(port, method, pathname, body, token ? { 'x-wcw-token': token } : {}, timeoutMs);
  let payload = null;
  try { payload = response.text ? JSON.parse(response.text) : null; } catch { /* caller gets status/text */ }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status} ${method} ${pathname}: ${redact(response.text)}`);
  }
  return payload;
}

async function waitForRuyiHealth(port, child, timeoutMs, tempRoot) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    try {
      const health = await requestJson(port, 'GET', '/health', undefined, '', 1500);
      if (health && health.ok === true) return health;
    } catch (error) { lastError = String(error && error.message || error); }
    await sleep(150);
  }
  throw new Error(`Ruyi health did not become ready${lastError ? `: ${lastError}` : ''}${child.exitCode != null ? `; child exit=${child.exitCode}` : ''}`);
}

function appendBounded(current, chunk, limit = 12000) {
  const next = current + chunk.toString('utf8');
  return next.length > limit ? next.slice(-limit) : next;
}

async function stopChildTree(child) {
  if (!child || child.exitCode != null) return;
  if (process.platform === 'win32' && child.pid) {
    try { await execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000, maxBuffer: 20000 }); } catch { /* process may already have exited */ }
  } else {
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
    await Promise.race([waitForChild(child), sleep(3000)]);
    if (child.exitCode == null) { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
  }
  await Promise.race([waitForChild(child), sleep(3000)]);
}

function waitForChild(child) {
  if (!child || child.exitCode != null) return Promise.resolve();
  return new Promise(resolve => child.once('close', resolve));
}

function spawnRuyi(caseRoot, env, port) {
  const child = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(port)], {
    cwd: WB,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChildren.add(child);
  child.__probeStdout = '';
  child.__probeStderr = '';
  child.stdout.on('data', chunk => { child.__probeStdout = appendBounded(child.__probeStdout, chunk); });
  child.stderr.on('data', chunk => { child.__probeStderr = appendBounded(child.__probeStderr, chunk); });
  child.once('close', () => activeChildren.delete(child));
  return child;
}

function writeKimiConfig(kimiHome, modelPort) {
  const config = [
    '# Isolated Kimi Code 0.37.2 live-probe config.',
    'default_provider = "fixture"',
    'default_model = "fixture"',
    '',
    '[providers.fixture]',
    'type = "openai"',
    `base_url = "http://127.0.0.1:${modelPort}/v1"`,
    'api_key = "fixture-key"',
    '',
    '[models.fixture]',
    'provider = "fixture"',
    'model = "fixture-model"',
    'max_context_size = 65536',
    'capabilities = ["thinking"]',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(kimiHome, 'config.toml'), config, 'utf8');
}

function writeRuyiConfig(ruyiHome, workspace, spec, installation) {
  const config = {
    configSchema: 11,
    agentCliType: 'kimi',
    // Ruyi's launcher resolver accepts the discovered npm shim and resolves its
    // package entry before ACP spawn. A bare .mjs path is not a supported launcher
    // value in the current server gate.
    kimiPath: installation.launcher,
    defaultWorkspace: workspace,
    permissionMode: spec.permissionMode,
    model: 'fixture',
    includeWorkbenchMcp: false,
    autoResumeClaudeSessions: false,
    killPortOnStart: false,
    permissionTimeoutMs: 15000,
    turnIdleTimeoutMs: 45000,
    allowCommandTools: true,
    allowDesktopTools: false,
    enableMcpDropIn: false,
    autoImportClaudeCodeMcp: false,
    externalMcpServers: [],
    providers: [],
    knownModels: [],
    extraModels: [],
  };
  fs.writeFileSync(path.join(ruyiHome, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

function streamTurn(port, token, body, onEvent) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const events = [];
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: PROBE_TIMEOUT_MS,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...(token ? { 'x-wcw-token': token } : {}) },
    }, res => {
      let buffer = '';
      let callbackChain = Promise.resolve();
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            events.push(event);
            if (onEvent) callbackChain = callbackChain.then(() => onEvent(event));
          } catch { /* Ruyi emits only JSON lines for the stream; keep diagnostics out of the probe output. */ }
        }
      });
      res.on('end', () => callbackChain.then(() => resolve(events), reject));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Ruyi chat stream timed out')));
    req.end(raw);
  });
}

function chooseQuestionAnswers(event, preferPlan) {
  const questions = Array.isArray(event && event.questions) ? event.questions : [];
  return questions.map(question => {
    const options = Array.isArray(question && question.options) ? question.options : [];
    const preferred = preferPlan
      ? options.find(option => String(option && (option.id || option.optionId) || '') === 'plan_opt_1')
        || options.find(option => /plan_approve|approve/i.test(String(option && (option.id || option.optionId) || '')))
        || options[1] || options[0]
      : options[1] || options[0];
    const id = preferred && (preferred.id || preferred.optionId);
    return { questionId: question.id, selectedOptionIds: id ? [String(id)] : [] };
  });
}

async function answerInteractive(port, token, event, spec) {
  if (event.type === 'permission_request') {
    return requestJson(port, 'POST', '/api/permission/decision', {
      requestId: event.requestId,
      behavior: 'allow',
      scope: event.toolName === 'Bash' ? 'once' : 'once',
    }, token, 10000);
  }
  if (event.type === 'ask_user') {
    return requestJson(port, 'POST', '/api/chat/answer', {
      sessionId: event.sessionId,
      questionId: event.questionId,
      answers: chooseQuestionAnswers(event, spec.planApproval === true),
    }, token, 10000);
  }
  return null;
}

function modelToolCalls(caseState, name) {
  return caseState && Array.isArray(caseState.toolCalls)
    ? caseState.toolCalls.filter(callItem => String(callItem && callItem.name || '') === name)
    : [];
}

function eventIdHasModelCallSuffix(eventId, modelCallId) {
  const actual = String(eventId || '');
  const expected = String(modelCallId || '');
  if (!actual || !expected) return false;
  return actual === expected
    || actual.endsWith(`:${expected}`)
    || actual.endsWith(`/${expected}`)
    || actual.endsWith(`_${expected}`)
    || actual.endsWith(`-${expected}`);
}

function modelToolLifecycle(events, modelCall) {
  if (!modelCall || !modelCall.id) return { use: null, latest: null, result: null };
  const updates = (Array.isArray(events) ? events : []).filter(event =>
    event && (event.type === 'tool_use' || event.type === 'tool_use_update')
      && eventIdHasModelCallSuffix(event.id, modelCall.id));
  const use = updates.find(event => event.type === 'tool_use') || null;
  const latest = updates.length ? updates[updates.length - 1] : null;
  const result = latest
    ? events.find(event => event && event.type === 'tool_result' && String(event.id || '') === String(latest.id || '')) || null
    : null;
  return { use, latest, result };
}

function planDecisionForModelCall(events, modelCall) {
  if (!modelCall) return null;
  return (Array.isArray(events) ? events : []).find(event =>
    event && event.type === 'kimi_plan_decision' && eventIdHasModelCallSuffix(event.planId, modelCall.id)) || null;
}

function eventIndex(events, predicate) {
  return (Array.isArray(events) ? events : []).findIndex(predicate);
}

function debugSanitize(value, tempRoot = '', key = '', depth = 0) {
  const lowerKey = String(key || '').toLowerCase();
  if (/(?:api[_-]?key|token|secret|password|authorization|credential|private[_-]?key|access[_-]?key|oauth)/i.test(lowerKey)) return '<redacted>';
  if (depth > 5) return '[depth-limited]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = redact(value, tempRoot);
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  }
  if (Array.isArray(value)) return value.slice(0, 80).map(item => debugSanitize(item, tempRoot, key, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [name, item] of Object.entries(value).slice(0, 100)) out[name] = debugSanitize(item, tempRoot, name, depth + 1);
    return out;
  }
  return String(value);
}

function debugJson(value, tempRoot = '') {
  try { return JSON.stringify(debugSanitize(value, tempRoot)); } catch { return '<unserializable>'; }
}

function rawProtocolMessages(events) {
  const rows = [];
  for (let index = 0; index < (Array.isArray(events) ? events.length : 0); index++) {
    const event = events[index];
    if (!event || event.type !== 'raw_line') continue;
    const raw = event.line !== undefined ? event.line : event.data !== undefined ? event.data : event.text;
    let message;
    try { message = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
    if (message && typeof message === 'object') rows.push({ index, message });
  }
  return rows;
}

function readKimiConfigSummary(kimiHome) {
  let text = '';
  try { text = fs.readFileSync(path.join(kimiHome, 'config.toml'), 'utf8'); } catch { return {}; }
  const value = name => {
    const match = text.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm'));
    return match ? match[1] : '';
  };
  const providerType = text.match(/^type\s*=\s*"([^"]*)"/m);
  const baseUrl = text.match(/^base_url\s*=\s*"([^"]*)"/m);
  return {
    default_provider: value('default_provider'),
    default_model: value('default_model'),
    provider_type: providerType ? providerType[1] : '',
    base_url: baseUrl ? baseUrl[1] : '',
    api_key: '<redacted>',
  };
}

function reportAcceptEditsEvidence(events, meta, spec, ruyiHome, kimiHome, caseRoot) {
  const rawRows = rawProtocolMessages(events);
  const updates = rawRows.filter(row => row.message.method === 'session/update' && row.message.params && row.message.params.update)
    .map(row => ({ index: row.index, update: row.message.params.update }))
    .filter(row => /^(tool_call|tool_call_update)$/.test(String(row.update.sessionUpdate || '')));
  const reverseRows = rawRows.filter(row => row.message.method === 'session/request_permission');
  const fsWriteRows = rawRows.filter(row => row.message.method === 'fs/write_text_file');
  const modeRows = rawRows.filter(row => row.message.method === 'session/update' && row.message.params && row.message.params.update)
    .map(row => ({ index: row.index, update: row.message.params.update }))
    .filter(row => /mode|config/i.test(String(row.update.sessionUpdate || '')));
  const ruyiPermissions = events
    .map((event, index) => ({ index, event }))
    .filter(row => row.event && row.event.type === 'permission_request');
  const writePermissions = ruyiPermissions.filter(row => /write/i.test(String(row.event.toolName || '')));
  const config = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ruyiHome, 'config.json'), 'utf8')); } catch { return {}; }
  })();
  console.log(`ACCEPT_EDITS_DIAG mode/config=${debugJson({
    ruyi: {
      permissionMode: config.permissionMode,
      agentCliType: config.agentCliType,
      model: config.model,
      allowCommandTools: config.allowCommandTools,
      agentDriver: meta && meta.agentDriver,
    },
    kimi: readKimiConfigSummary(kimiHome),
    nativeModeUpdates: modeRows.map(row => ({ index: row.index, update: row.update })),
  }, caseRoot)}`);
  for (const row of updates) console.log(`ACCEPT_EDITS_DIAG native ${debugJson({ index: row.index, update: row.update }, caseRoot)}`);
  for (const row of reverseRows) console.log(`ACCEPT_EDITS_DIAG reverse ${debugJson({ index: row.index, method: row.message.method, params: row.message.params }, caseRoot)}`);
  for (const row of fsWriteRows) console.log(`ACCEPT_EDITS_DIAG fs-write ${debugJson({ index: row.index, method: row.message.method, params: row.message.params }, caseRoot)}`);
  for (const row of writePermissions) console.log(`ACCEPT_EDITS_DIAG ruyi-permission ${debugJson({ index: row.index, event: row.event }, caseRoot)}`);
  const nativeKinds = updates.map(row => String(row.update.kind || '')).filter(Boolean);
  const nearestRawMethod = permissionIndex => [...rawRows].reverse().find(row => row.index < permissionIndex)?.message.method || '<none>';
  const sources = [];
  if (reverseRows.length) sources.push('native session/request_permission');
  if (fsWriteRows.length) sources.push('ACP fs/write_text_file');
  if (writePermissions.some(row => nearestRawMethod(row.index) === 'session/request_permission')) sources.push('Ruyi permission_request after native permission');
  if (writePermissions.some(row => nearestRawMethod(row.index) === 'fs/write_text_file')) sources.push('Ruyi permission_request after fs/write_text_file');
  console.log(`ACCEPT_EDITS_DIAG gates=${debugJson({
    nativePermissionCount: reverseRows.length,
    fsWriteCount: fsWriteRows.length,
    ruyiWritePermissionCount: writePermissions.length,
    observedNativeKinds: nativeKinds,
    writePermissionPredecessors: writePermissions.map(row => ({ index: row.index, previousRawMethod: nearestRawMethod(row.index) })),
    conclusion: sources.length ? sources : ['no matching gate evidence'],
  }, caseRoot)}`);
}

function rawInputField(input, key) {
  if (!input || typeof input !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(input, key)) return input[key];
  if (key === 'path') return input.file_path !== undefined ? input.file_path : input.filePath;
  return undefined;
}

function rawInputErrors(modelCall, input, caseRoot) {
  const expected = modelCall && modelCall.args && typeof modelCall.args === 'object' ? modelCall.args : {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['rawInput is not an object'];
  const errors = [];
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = rawInputField(input, key);
    if (actualValue === undefined || actualValue === null || actualValue === '') {
      errors.push(`${key} missing`);
      continue;
    }
    if (key === 'path') {
      const actualPath = String(actualValue);
      const expectedPath = String(expectedValue);
      if (path.isAbsolute(actualPath) && !isInside(caseRoot, actualPath)) errors.push(`${key} escaped probe root`);
      else if (!path.isAbsolute(actualPath) && path.normalize(actualPath) !== path.normalize(expectedPath)) errors.push(`${key}=${actualPath} expected ${expectedPath}`);
    } else if (String(actualValue) !== String(expectedValue)) {
      errors.push(`${key}=${actualValue} expected ${expectedValue}`);
    }
  }
  return errors;
}

function toolInput(event) {
  const raw = event && (event.input !== undefined ? event.input : event.arguments);
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }
  return {};
}

function permissionInputErrors(modelCall, event, workspace, caseRoot) {
  const input = toolInput(event);
  const errors = rawInputErrors(modelCall, input, caseRoot);
  const expected = modelCall && modelCall.args && typeof modelCall.args === 'object' ? modelCall.args : {};
  const expectedPath = expected.path !== undefined
    ? expected.path
    : expected.file_path !== undefined
      ? expected.file_path
      : expected.filePath;
  if (expectedPath !== undefined) {
    const actualPath = rawInputField(input, 'path');
    if (actualPath !== undefined && actualPath !== null && actualPath !== '') {
      const expectedResolved = path.resolve(workspace, String(expectedPath));
      const actualResolved = path.isAbsolute(String(actualPath))
        ? path.resolve(String(actualPath))
        : path.resolve(workspace, String(actualPath));
      if (!isInside(caseRoot, actualResolved)) errors.push('permission input path escaped probe root');
      else if (pathKey(actualResolved) !== pathKey(expectedResolved)) {
        errors.push(`permission input path=${actualPath} expected ${expectedPath}`);
      }
    }
  }
  return [...new Set(errors)];
}

function permissionRequestsForToolCall(events, modelCall, toolName, workspace, caseRoot) {
  if (!modelCall) return [];
  const lifecycle = modelToolLifecycle(events, modelCall);
  const start = lifecycle.use ? events.indexOf(lifecycle.use) : -1;
  if (start < 0) return [];
  const resultIndex = lifecycle.result ? events.indexOf(lifecycle.result) : events.length;
  const wanted = String(toolName || '').trim().toLowerCase();
  return events
    .map((event, index) => ({ event, index }))
    .filter(row => row.index > start && row.index < resultIndex
      && row.event && row.event.type === 'permission_request'
      && String(row.event.toolName || '').trim().toLowerCase() === wanted)
    .map(row => ({ ...row, inputErrors: permissionInputErrors(modelCall, row.event, workspace, caseRoot) }));
}

function assertExactlyOnePermission(label, rows, caseRoot) {
  const detail = (Array.isArray(rows) ? rows : []).map(row => ({
    index: row.index,
    toolName: row.event && row.event.toolName,
    input: toolInput(row.event),
    inputErrors: row.inputErrors || [],
  }));
  if (!Array.isArray(rows) || rows.length !== 1) {
    logFail(label, `expected exactly one permission_request for this tool/input; observed ${Array.isArray(rows) ? rows.length : 0}: ${redact(JSON.stringify(detail), caseRoot)}`);
    return false;
  }
  if (rows[0].inputErrors && rows[0].inputErrors.length) {
    logFail(label, `exactly one permission_request observed, but its input did not match the model tool call: ${rows[0].inputErrors.join('; ')}`);
    return false;
  }
  logPass(label, `exactly one permission_request; tool/input associated at event index ${rows[0].index}`);
  return true;
}

function explicitCliCapabilityUnavailable(text, toolName = '') {
  const value = String(text || '');
  if (toolName && !new RegExp(toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(value)) return false;
  return /(?:not advertised|unknown tool|unknown function|unsupported|not supported|not available|unavailable|not implemented)/i.test(value);
}

function extractTerminalCreates(events) {
  const rows = [];
  const seen = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.type !== 'raw_line') continue;
    const raw = event.line !== undefined ? event.line : event.data !== undefined ? event.data : event.text;
    let message;
    try { message = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
    if (!message || message.method !== 'terminal/create') continue;
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const args = Array.isArray(params.args)
      ? params.args.map(value => String(value))
      : params.argv !== undefined
        ? (Array.isArray(params.argv) ? params.argv.map(value => String(value)) : [String(params.argv)])
        : [];
    const row = {
      command: String(params.command || params.executable || ''),
      args,
      cwd: String(params.cwd || params.workingDirectory || ''),
    };
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

function reportTerminalCreates(caseName, events, caseRoot) {
  const rows = extractTerminalCreates(events);
  if (!rows.length) {
    console.log(`TERMINAL [${caseName}] none observed`);
    return;
  }
  for (const row of rows) {
    console.log(`TERMINAL [${caseName}] command=${JSON.stringify(redact(row.command, caseRoot))} argv=${JSON.stringify(row.args.map(value => redact(value, caseRoot)))} cwd=${JSON.stringify(redact(row.cwd, caseRoot))}`);
  }
}

function resultText(event) {
  return contentText(event && (event.content !== undefined ? event.content : event.result));
}

function eventText(event) {
  if (event && event.type === 'assistant_delta') return String(event.text || '');
  return resultText(event);
}

async function runCase(parentRoot, model, caseName, installation) {
  const spec = CASES[caseName];
  const caseRoot = fs.mkdtempSync(path.join(parentRoot, `case-${caseName}-`));
  const ruyiHome = path.join(caseRoot, 'ruyi-home');
  const kimiHome = path.join(caseRoot, 'kimi-home');
  const workspace = path.join(caseRoot, 'workspace');
  const tempDir = path.join(caseRoot, 'tmp');
  let child = null;
  let token = '';
  let events = [];
  try {
    for (const dir of [ruyiHome, kimiHome, workspace, tempDir]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'read-source.txt'), 'KIMI_PROBE_MARKER\nread-source-line\n', 'utf8');
    fs.writeFileSync(path.join(workspace, 'second.txt'), 'second probe file\n', 'utf8');
    if (caseName === 'plan' || caseName === 'planEnter' || caseName === 'planSearch') fs.mkdirSync(path.join(workspace, 'plan'), { recursive: true });
    writeKimiConfig(kimiHome, model.port);
    writeRuyiConfig(ruyiHome, workspace, spec, installation);
    const port = await getFreePort();
    const env = scrubbedEnv({
      RUYI_HOME: ruyiHome,
      WIN_CLAUDE_WORKBENCH_HOME: ruyiHome,
      KIMI_CODE_HOME: kimiHome,
      HOME: caseRoot,
      USERPROFILE: caseRoot,
      APPDATA: path.join(caseRoot, 'appdata'),
      LOCALAPPDATA: path.join(caseRoot, 'localappdata'),
      TEMP: tempDir,
      TMP: tempDir,
      XDG_CONFIG_HOME: path.join(caseRoot, 'xdg-config'),
      XDG_DATA_HOME: path.join(caseRoot, 'xdg-data'),
    });
    for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME]) fs.mkdirSync(dir, { recursive: true });
    child = spawnRuyi(caseRoot, env, port);
    console.log(`COMMAND [${caseName}] node "${SERVER}" serve --port ${port}`);
    await waitForRuyiHealth(port, child, 20000, caseRoot);
    logPass(`[${caseName}] Ruyi isolated health`, `127.0.0.1:${port}`);
    const bootstrap = await requestJson(port, 'POST', '/api/bootstrap', {}, '', 10000);
    token = String(bootstrap && bootstrap.token || '');
    if (!token) throw new Error('Ruyi bootstrap did not return a token');
    logPass(`[${caseName}] isolated bootstrap token`);
    const interactiveSeen = new Set();
    const interactiveErrors = [];
    const planApprovalCandidates = [];
    let currentSessionId = '';
    events = await streamTurn(port, token, { message: spec.prompt, cwd: workspace, attachments: [] }, async event => {
      // streamTurn is still collecting its local events while this callback runs;
      // capture the outer Ruyi session from each live event instead of consulting
      // the eventual `events` array (which is empty until the stream completes).
      if (event && event.type === 'session') {
        const id = event.session && event.session.id;
        if (id) currentSessionId = String(id);
      }
      if (event && event.type === 'ask_user' && spec.planApproval) {
        for (const question of Array.isArray(event.questions) ? event.questions : []) {
          for (const option of Array.isArray(question && question.options) ? question.options : []) {
            const optionId = String(option && (option.id || option.optionId) || '');
            if (optionId) planApprovalCandidates.push({ optionId, label: String(option && (option.label || option.name) || '') });
          }
        }
      }
      if (!['permission_request', 'ask_user'].includes(event && event.type)) return;
      const id = `${event.type}:${event.requestId || event.questionId || ''}`;
      if (interactiveSeen.has(id)) return;
      interactiveSeen.add(id);
      try {
        await answerInteractive(port, token, { ...event, sessionId: currentSessionId }, spec);
      } catch (error) {
        interactiveErrors.push(`${event.type}:${event.requestId || event.questionId || 'unknown'} ${redact(error && error.message || error, caseRoot)}`);
      }
    });
    reportTerminalCreates(caseName, events, caseRoot);
    const result = events.find(event => event && event.type === 'result');
    const meta = events.find(event => event && event.type === 'meta');
    const caseModelRequests = model.state.requests.filter(request => request.caseName === caseName);
    const caseState = model.state.cases.get(caseName);
    if (caseName === 'acceptEdits') reportAcceptEditsEvidence(events, meta, spec, ruyiHome, kimiHome, caseRoot);
    if (caseModelRequests.length > 0) {
      logPass(`[${caseName}] local fixed-response model received request`, `${caseModelRequests.length} request(s); tools=${caseModelRequests[0].toolNames.length}`);
    } else {
      logFail(`[${caseName}] local fixed-response model received request`, 'no /v1/chat/completions request observed');
    }
    if (meta && meta.agentCliType === 'kimi' && meta.agentDriver === 'kimi-acp') {
      logPass(`[${caseName}] real Kimi ACP metadata`);
    } else {
      logFail(`[${caseName}] real Kimi ACP metadata`, `observed ${JSON.stringify({ agentCliType: meta && meta.agentCliType, agentDriver: meta && meta.agentDriver })}`);
    }
    if (caseName === 'handshake') {
      if (result && result.ok === true && events.some(event => event.type === 'assistant_delta' && eventText(event).includes(spec.final))) {
        logPass('[handshake] ACP handshake/model turn completed', 'no tool result counted in this handshake assertion');
      } else {
        logFail('[handshake] ACP handshake/model turn completed', result ? redact(JSON.stringify(result), caseRoot) : 'no result event');
      }
      return { ok: Boolean(result && result.ok === true), caseRoot, paths: [ruyiHome, kimiHome, workspace, tempDir] };
    }
    if (!caseState) {
      logFail(`[${caseName}] fixture state`, 'model endpoint did not classify the case');
    } else {
      const unavailable = spec.optional
        ? spec.expectedTools.filter(name => caseState.schemaErrors.some(error => explicitCliCapabilityUnavailable(error, name)))
        : [];
      if (unavailable.length) {
        logSkip(`[${caseName}] optional CLI capability`, `${unavailable.join(', ')} not advertised by the real Kimi CLI request schema`);
        return { ok: false, caseRoot, paths: [ruyiHome, kimiHome, workspace, tempDir] };
      }
      if (caseState.schemaErrors.length) logFail(`[${caseName}] actual Kimi tool schema`, caseState.schemaErrors.join('; '));
      else logPass(`[${caseName}] actual Kimi tool schema`, spec.expectedTools.join(', '));
    }
    if (interactiveErrors.length) logFail(`[${caseName}] interactive reverse RPC`, interactiveErrors.join('; '));
    if (spec.planApproval) {
      const exitCall = modelToolCalls(caseState, 'ExitPlanMode')[0];
      const selected = planApprovalCandidates.find(candidate => candidate.optionId === 'plan_opt_1');
      const decision = planDecisionForModelCall(events, exitCall);
      if (!selected) {
        logFail(`[${caseName}] native ExitPlanMode selectedLabel`, 'ExitPlanMode did not expose selectable optionId plan_opt_1');
      } else if (selected.label !== PLAN_APPROVAL_LABEL) {
        logFail(`[${caseName}] native ExitPlanMode selectedLabel`, `plan_opt_1 label=${selected.label || '<empty>'} expected ${PLAN_APPROVAL_LABEL}`);
      } else if (!decision || String(decision.optionId || '') !== 'plan_opt_1') {
        logFail(`[${caseName}] native ExitPlanMode selectedLabel`, decision ? `native optionId=${decision.optionId || '<empty>'}, expected plan_opt_1` : 'no native kimi_plan_decision for ExitPlanMode');
      } else {
        logPass(`[${caseName}] native ExitPlanMode selectedLabel`, `${selected.label} via optionId=plan_opt_1`);
      }
    }
    if (result && result.ok === true && events.some(event => event.type === 'assistant_delta' && eventText(event).includes(spec.final))) {
      logPass(`[${caseName}] ACP turn completed with fixed model response`);
    } else {
      const error = result && (result.error || result.message) || events.filter(event => event.type === 'stderr').map(event => event.text).join('\n') || 'no successful result event';
      logFail(`[${caseName}] ACP turn completed with fixed model response`, redact(error, caseRoot));
    }
    for (const name of spec.expectedTools) {
      const modelCall = modelToolCalls(caseState, name)[0];
      if (!modelCall) {
        logFail(`[${caseName}] real tool ${name}`, 'local fixture did not issue the expected model tool_call');
        continue;
      }
      const lifecycle = modelToolLifecycle(events, modelCall);
      if (!lifecycle.use) {
        logFail(`[${caseName}] real tool ${name}`, `no ACP tool_use with id suffix ${modelCall.id}; observed tool ids=${events.filter(event => event && event.type === 'tool_use').map(event => String(event.id || '')).join(', ') || '<none>'}`);
        continue;
      }
      const inputErrors = rawInputErrors(modelCall, toolInput(lifecycle.latest || lifecycle.use), caseRoot);
      if (inputErrors.length) {
        logFail(`[${caseName}] real tool ${name}`, `ACP id=${lifecycle.use.id} rawInput invalid: ${inputErrors.join('; ')}`);
        continue;
      }
      const resultEvent = lifecycle.result;
      if (!resultEvent || resultEvent.isError === true) {
        const label = name === 'EnterPlanMode' ? 'real EnterPlanMode transition' : `real tool ${name}`;
        logFail(`[${caseName}] ${label}`, resultEvent ? `tool_result isError: ${redact(resultText(resultEvent), caseRoot)}` : 'no completed tool_result event');
      } else {
        const label = name === 'EnterPlanMode' ? 'real EnterPlanMode transition' : `real tool ${name}`;
        logPass(`[${caseName}] ${label}`, `model tool_call_id=${modelCall.id} -> ACP id=${lifecycle.use.id}; rawInput verified; non-error tool_result`);
      }
    }
    if (caseName === 'read') {
      const read = modelToolLifecycle(events, modelToolCalls(caseState, 'Read')[0]).result;
      const grep = modelToolLifecycle(events, modelToolCalls(caseState, 'Grep')[0]).result;
      const glob = modelToolLifecycle(events, modelToolCalls(caseState, 'Glob')[0]).result;
      if (read && /KIMI_PROBE_MARKER/.test(resultText(read))) logPass('[read] Read returned fixture file content');
      else logFail('[read] Read returned fixture file content', 'marker absent from real Read result');
      if (grep && /KIMI_PROBE_MARKER/.test(resultText(grep))) logPass('[read] Grep searched the fixture');
      else logFail('[read] Grep searched the fixture', 'marker absent from real Grep result');
      if (glob && /read-source\.txt/.test(resultText(glob))) logPass('[read] Glob matched the fixture');
      else logFail('[read] Glob matched the fixture', 'read-source.txt absent from real Glob result');
    }
    if (caseName === 'write' || caseName === 'acceptEdits') {
      const target = caseName === 'write' ? path.join(workspace, 'write-output.txt') : path.join(workspace, 'accept-edits-output.txt');
      const expected = caseName === 'write' ? 'KIMI_PROBE_WRITE_OK' : 'KIMI_PROBE_ACCEPT_EDITS_OK';
      if (fs.existsSync(target) && fs.readFileSync(target, 'utf8').includes(expected)) logPass(`[${caseName}] Write changed the isolated workspace`);
      else logFail(`[${caseName}] Write changed the isolated workspace`, 'expected real file content was not found');
    }
    if (caseName === 'planEnter' || caseName === 'plan' || caseName === 'planSearch') {
      if ((caseName === 'plan' || caseName === 'planSearch') && modelToolCalls(caseState, 'EnterPlanMode').length) {
        logFail(`[${caseName}] native plan startup`, 'fixture unexpectedly called EnterPlanMode while permissionMode=plan');
      }
      const planLifecycle = modelToolLifecycle(events, modelToolCalls(caseState, 'Write')[0]);
      const planInput = toolInput(planLifecycle.latest || planLifecycle.use);
      const rawPlanPath = planInput.path || planInput.file_path || planInput.filename;
      const planPath = rawPlanPath
        ? (path.isAbsolute(String(rawPlanPath)) ? path.resolve(String(rawPlanPath)) : path.resolve(workspace, String(rawPlanPath)))
        : '';
      const expectedPlanHeader = caseName === 'planSearch' ? '# Kimi live probe search plan' : '# Kimi live probe plan';
      if (planPath && isInside(caseRoot, planPath) && fs.existsSync(planPath) && fs.readFileSync(planPath, 'utf8').includes(expectedPlanHeader)) {
        logPass(`[${caseName}] plan Write persisted real file`, redact(planPath, caseRoot));
      } else {
        logFail(`[${caseName}] plan Write persisted real file`, `missing or out-of-root plan path ${redact(planPath || '<none>', caseRoot)}; Write input=${redact(JSON.stringify(planInput), caseRoot)}`);
      }
    }
    if (caseName === 'planSearch') {
      const globResult = modelToolLifecycle(events, modelToolCalls(caseState, 'Glob')[0]).result;
      const grepResult = modelToolLifecycle(events, modelToolCalls(caseState, 'Grep')[0]).result;
      if (globResult && /read-source\.txt/.test(resultText(globResult))) logPass('[planSearch] Glob returned a real fixture hit');
      else logFail('[planSearch] Glob returned a real fixture hit', 'read-source.txt absent from real Glob result');
      if (grepResult && /KIMI_PROBE_MARKER/.test(resultText(grepResult))) logPass('[planSearch] Grep returned a real fixture hit');
      else logFail('[planSearch] Grep returned a real fixture hit', 'KIMI_PROBE_MARKER absent from real Grep result');
      const globResultIndex = eventIndex(events, event => event && event.type === 'tool_result'
        && modelToolLifecycle(events, modelToolCalls(caseState, 'Glob')[0]).result === event);
      const grepResultIndex = eventIndex(events, event => event && event.type === 'tool_result'
        && modelToolLifecycle(events, modelToolCalls(caseState, 'Grep')[0]).result === event);
      const writeUseIndex = eventIndex(events, event => event && event.type === 'tool_use'
        && modelToolLifecycle(events, modelToolCalls(caseState, 'Write')[0]).use === event);
      const exitUseIndex = eventIndex(events, event => event && event.type === 'tool_use'
        && modelToolLifecycle(events, modelToolCalls(caseState, 'ExitPlanMode')[0]).use === event);
      if (globResultIndex >= 0 && grepResultIndex >= 0 && writeUseIndex >= 0 && exitUseIndex >= 0
        && globResultIndex < writeUseIndex && grepResultIndex < writeUseIndex
        && globResultIndex < exitUseIndex && grepResultIndex < exitUseIndex) {
        logPass('[planSearch] read-only search hits occurred before plan approval', 'Glob/Grep results preceded plan Write and ExitPlanMode');
      } else {
        logFail('[planSearch] read-only search hits occurred before plan approval', `event order Glob=${globResultIndex} Grep=${grepResultIndex} Write=${writeUseIndex} ExitPlanMode=${exitUseIndex}`);
      }
    }
    if (caseName === 'planEnter' || caseName === 'plan') {
      const writeCalls = modelToolCalls(caseState, 'Write');
      const businessCall = writeCalls[1];
      const businessLifecycle = modelToolLifecycle(events, businessCall);
      if (!businessCall) {
        logFail(`[${caseName}] approved business Write`, `expected second Write with path ${PLAN_EXECUTED_FILE}`);
      } else if (!businessLifecycle.use) {
        logFail(`[${caseName}] approved business Write`, `no ACP tool_use for second Write id suffix ${businessCall.id}`);
      } else {
        const businessInput = toolInput(businessLifecycle.latest || businessLifecycle.use);
        const inputErrors = rawInputErrors(businessCall, businessInput, caseRoot);
        if (inputErrors.length) logFail(`[${caseName}] approved business Write`, `rawInput invalid: ${inputErrors.join('; ')}`);
        const rawBusinessPath = rawInputField(businessInput, 'path');
        const businessPath = rawBusinessPath
          ? (path.isAbsolute(String(rawBusinessPath)) ? path.resolve(String(rawBusinessPath)) : path.resolve(workspace, String(rawBusinessPath)))
          : '';
        const expectedBusinessPath = path.resolve(workspace, PLAN_EXECUTED_FILE);
        if (businessPath && isInside(workspace, businessPath) && path.resolve(businessPath).toLowerCase() === expectedBusinessPath.toLowerCase()
          && fs.existsSync(businessPath) && fs.readFileSync(businessPath, 'utf8').includes('KIMI_PROBE_PLAN_EXECUTED_OK')) {
          logPass(`[${caseName}] approved business Write persisted real workspace file`, redact(businessPath, caseRoot));
        } else {
          logFail(`[${caseName}] approved business Write persisted real workspace file`, `expected ${redact(expectedBusinessPath, caseRoot)}, observed ${redact(businessPath || '<none>', caseRoot)}`);
        }
        if (!businessLifecycle.result || businessLifecycle.result.isError === true) {
          logFail(`[${caseName}] approved business Write result`, businessLifecycle.result ? `tool_result isError: ${redact(resultText(businessLifecycle.result), caseRoot)}` : 'no completed tool_result');
        } else {
          logPass(`[${caseName}] approved business Write result`, `model tool_call_id=${businessCall.id} -> ACP id=${businessLifecycle.use.id}; non-error tool_result`);
        }
        const exitUseIndex = eventIndex(events, event => event && event.type === 'tool_use'
          && modelToolLifecycle(events, modelToolCalls(caseState, 'ExitPlanMode')[0]).use === event);
        const businessUseIndex = events.indexOf(businessLifecycle.use);
        if (exitUseIndex >= 0 && businessUseIndex > exitUseIndex) {
          const businessPermissions = permissionRequestsForToolCall(events, businessCall, 'Write', workspace, caseRoot)
            .filter(row => row.index > exitUseIndex);
          assertExactlyOnePermission(`[${caseName}] approved business Write manual permission`, businessPermissions, caseRoot);
        } else {
          logFail(`[${caseName}] approved business Write manual permission`, `business Write did not execute after ExitPlanMode (Exit=${exitUseIndex}, Write=${businessUseIndex})`);
        }
      }
    }
    if (caseName === 'write') {
      const writeCall = modelToolCalls(caseState, 'Write')[0];
      const writePermissions = permissionRequestsForToolCall(events, writeCall, 'Write', workspace, caseRoot);
      assertExactlyOnePermission('[write] Write approval round-trip', writePermissions, caseRoot);
    }
    if (caseName === 'acceptEdits') {
      const writePermission = events.find(event => event.type === 'permission_request' && /write/i.test(String(event.toolName || '')));
      if (!writePermission) logPass('[acceptEdits] Write auto-approval', 'no Write permission_request in acceptEdits');
      else logFail('[acceptEdits] Write auto-approval', 'Kimi ACP emitted a real Write permission_request in acceptEdits; host edit-only mode should auto-approve Write');
      if (events.some(event => event.type === 'ask_user')) logPass('[acceptEdits] AskUserQuestion round-trip');
      else logFail('[acceptEdits] AskUserQuestion round-trip', 'no structured ask_user event');
      const bashResult = modelToolLifecycle(events, modelToolCalls(caseState, 'Bash')[0]).result;
      if (bashResult && /KIMI_PROBE_BASH_OK/.test(resultText(bashResult))) logPass('[acceptEdits] Bash executed');
      else logFail('[acceptEdits] Bash executed', 'Bash output not present in real tool result');
      const bashCall = modelToolCalls(caseState, 'Bash')[0];
      const bashPermissions = permissionRequestsForToolCall(events, bashCall, 'Bash', workspace, caseRoot);
      assertExactlyOnePermission('[acceptEdits] Bash approval round-trip', bashPermissions, caseRoot);
    }
    return { ok: Boolean(result && result.ok === true), caseRoot, paths: [ruyiHome, kimiHome, workspace, tempDir] };
  } catch (error) {
    const childState = child ? `; childPid=${child.pid || '<none>'}; childExit=${child.exitCode == null ? '<running>' : child.exitCode}` : '';
    const stdout = child && child.__probeStdout ? `; stdout=${redact(child.__probeStdout, caseRoot)}` : '';
    const stderr = child && child.__probeStderr ? `; stderr=${redact(child.__probeStderr, caseRoot)}` : '';
    const detail = `${redact(error && (error.stack || error.message) || error, caseRoot)}${childState}${stdout}${stderr}`;
    if (spec.optional && spec.expectedTools.some(name => explicitCliCapabilityUnavailable(detail, name))) logSkip(`[${caseName}] optional CLI capability`, detail);
    else logFail(`[${caseName}] execution`, detail);
    return { ok: false, caseRoot, paths: [ruyiHome, kimiHome, workspace, tempDir] };
  } finally {
    await stopChildTree(child);
    safeRemoveMkdtemp(caseRoot, [ruyiHome, kimiHome, workspace, tempDir]);
  }
}

async function getFreePort() {
  const listener = await listenLoopback(() => {});
  const port = listener.port;
  await closeHttpServer(listener.server);
  return port;
}

function selectedCaseNames() {
  const inline = process.argv.find(argument => argument.startsWith('--case='));
  const position = process.argv.indexOf('--case');
  const requested = inline
    ? inline.slice('--case='.length)
    : position >= 0
      ? process.argv[position + 1]
      : process.env.KIMI_PROBE_CASE;
  const all = ['read', 'write', 'planEnter', 'plan', 'planSearch', 'acceptEdits'];
  if (!requested) return all;
  const names = String(requested).split(',').map(name => name.trim()).filter(Boolean);
  const unknown = names.filter(name => !all.includes(name));
  if (unknown.length) {
    logFail('probe case selection', `unknown case(s): ${unknown.join(', ')}; expected ${all.join(', ')}`);
    return [];
  }
  return [...new Set(names)];
}

async function run() {
  console.log(`COMMAND node "${__filename}"`);
  const installation = discoverKimiCli();
  if (!installation.launcher || !installation.entry) {
    logSkip('real Kimi CLI', installation.skipReason);
    return;
  }
  console.log(`KIMI_DISCOVERY source=${JSON.stringify(installation.source)} launcher=${JSON.stringify(installation.launcher)} entry=${JSON.stringify(installation.entry)}`);
  console.log(`COMMAND node "${installation.entry}" --version`);
  if (!fs.existsSync(KIMI_COMPAT_REGISTER)) {
    logFail('Kimi ACP compatibility loader', `missing ${KIMI_COMPAT_REGISTER}`);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kimi-live-probe-'));
  let model = null;
  try {
    const versionEnv = scrubbedEnv({
      KIMI_CODE_HOME: path.join(root, 'version-kimi-home'),
      HOME: root,
      USERPROFILE: root,
    });
    fs.mkdirSync(versionEnv.KIMI_CODE_HOME, { recursive: true });
    let versionOutput;
    try {
      const result = await execFile(process.execPath, [installation.entry, '--version'], {
        cwd: WB,
        env: versionEnv,
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 20000,
      });
      versionOutput = String(result.stdout || '').trim().split(/\r?\n/)[0] || 'unknown';
      console.log(`CLI_VERSION ${versionOutput}`);
      logPass('real Kimi CLI executable', `discovered npm launcher=${installation.launcher}; package entry launched without user configuration`);
    } catch (error) {
      logFail('real Kimi CLI executable', redact(error && (error.stderr || error.message) || error, root));
      return;
    }
    model = await startFixtureModel();
    console.log(`COMMAND local fixed-response model http://127.0.0.1:${model.port}/v1/chat/completions`);
    console.log(`KIMI_CONFIG_SCHEMA config.toml; provider.type=openai; provider.base_url=http://127.0.0.1:${model.port}/v1`);
    const caseNames = selectedCaseNames();
    if (!caseNames.length) return;
    const handshake = await runCase(root, model, 'handshake', installation);
    if (!handshake.ok) {
      for (const name of caseNames) logSkip(`[${name}] tool cases`, 'blocked because the real ACP handshake/local model turn did not complete');
      return;
    }
    for (const name of caseNames) {
      const spec = CASES[name];
      if (spec.optional) {
        // Optional means the case is attempted and only an actual protocol/tool
        // unavailability is reported as SKIP; ordinary assertion failures remain FAIL.
      }
      await runCase(root, model, name, installation);
    }
    if (model.state.errors.length) logFail('local model fixture', model.state.errors.join('; '));
    else logPass('local model fixture', `${model.state.requests.length} request(s), deterministic responses only`);
  } finally {
    for (const child of [...activeChildren]) await stopChildTree(child);
    if (model) await closeHttpServer(model.server);
    safeRemoveMkdtemp(root, [path.join(root, 'version-kimi-home')]);
  }
}

run().then(() => {
  if (report.failures) process.exitCode = 1;
  console.log(`SUMMARY pass=${report.passes} fail=${report.failures} skip=${report.skips}`);
}).catch(error => {
  console.error(`FAIL probe fatal — ${redact(error && (error.stack || error.message) || error)}`);
  process.exitCode = 1;
});
