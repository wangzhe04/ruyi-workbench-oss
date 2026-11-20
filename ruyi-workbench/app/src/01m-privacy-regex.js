// P3: Custom RegExp executes only in a disposable, bounded worker. No user code enters eval source.
// 150 P9 (3.1 phase 4): a busy pool queues instead of refusing, the run budget grows with the input
// size, results already scanned under the same rules are reused, saving probes every rule for
// zero-width matches position by position, and a timeout names the rule that was running.
const PrivacyRegex = ((workerThreads, core, cryptoApi) => {
  const LIMITS = Object.freeze({ rules: 20, source: 1024, bytes: 8 * 1024 * 1024, sample: 1024 * 1024, samples: 50000, matches: 10000, jobs: 2, startupMs: 3000, runMs: 250,
    runMsPerKiB: 8, runMsMax: 5000, queue: 32, queueMs: 10000, cacheEntries: 8192, cacheRows: 200000, probeBytes: 4096 });
  let activeJobs = 0;
  const waiting = [];
  const fail = (code, ruleId) => Object.assign(new Error('privacy.' + code), { code: 'privacy.' + code, ...(ruleId ? { ruleId } : {}) });
  function validateSchema(rules) {
    core.createDetector({ rules });
    const selected = rules.filter(rule => rule.kind === 'regex');
    if (selected.length > LIMITS.rules) throw fail('regex_rules_limit');
    return selected.map(rule => ({ id: rule.id, category: rule.category, value: rule.value, flags: rule.flags || '' }));
  }
  // The run budget scales with the bytes actually sent to the worker: a fixed 250 ms for a whole
  // request made ordinary backtracking rules time out on a 30 KB history (150 P9).
  const runBudget = bytes => Math.min(LIMITS.runMsMax, LIMITS.runMs + Math.ceil(bytes / 1024) * LIMITS.runMsPerKiB);
  // Two workers at most. Further jobs wait in a bounded FIFO (abortable, bounded in time) instead of
  // failing the turn with regex_busy the moment two other requests are scanning.
  function acquire(signal) {
    if (activeJobs < LIMITS.jobs) { activeJobs++; return Promise.resolve(); }
    if (waiting.length >= LIMITS.queue) return Promise.reject(fail('regex_busy'));
    return new Promise((resolve, reject) => {
      const entry = {};
      const detach = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); const at = waiting.indexOf(entry); if (at >= 0) waiting.splice(at, 1); };
      const abort = () => { detach(); reject(fail('regex_aborted')); };
      const timer = setTimeout(() => { detach(); reject(fail('regex_busy')); }, LIMITS.queueMs);
      entry.grant = () => { detach(); resolve(); };   // the releasing job hands its slot over unchanged
      signal?.addEventListener('abort', abort, { once: true });
      waiting.push(entry);
    });
  }
  function release() { const next = waiting.shift(); if (next) next.grant(); else activeJobs--; }
  // Results depend only on (rule set, input). Entries hold a digest of the input and the match
  // coordinates, never the text itself; the bounded LRU drops the oldest entries.
  const cache = new Map(); let cachedRows = 0;
  const digest = value => cryptoApi.createHash('sha256').update(value).digest('base64');
  const cacheGet = key => { const rows = cache.get(key); if (rows) { cache.delete(key); cache.set(key, rows); } return rows; };
  const cacheDrop = key => { const rows = cache.get(key); if (rows) { cachedRows -= rows.length; cache.delete(key); } };
  const cachePut = (key, rows) => {
    cacheDrop(key); cache.set(key, rows); cachedRows += rows.length;
    while (cache.size > LIMITS.cacheEntries || cachedRows > LIMITS.cacheRows) cacheDrop(cache.keys().next().value);
  };
  const freeze = rows => Object.freeze(rows.map(row => Object.freeze({ ...row, ruleIds: Object.freeze([...row.ruleIds]) })));
  // 150 P9: a lookahead such as (?=secret) never matches the empty input but matches empty before every
  // "secret", so a saved rule failed every later turn. Saving probes each rule at every position of
  // synthetic samples built from fixed text and from the literal runs of the rule's own source.
  function probeSamples(selected) {
    const base = 'abc ABC xyz 0123456789 中文样例 x@y.z -_/:;,.!?#=&+%()[]{}<>"\' \t\nend';
    const samples = new Set(['', base]);
    for (const rule of selected) {
      // Literal runs are everything between regex syntax (escapes, metacharacters, whitespace), so CJK and
      // full-width punctuation such as "密码：" or "（编号）" stay part of the probe (4B review v2); the group
      // prefixes ?: ?= ?! ?<= ?<! are syntax, not text.
      const literals = rule.value.replace(/\\[pPu]\{[^}]*\}|\\[^]/g, ' ').split(/[\\^$.|?*+()[\]{}\s]+/)
        .map(run => run.replace(/^(?:<?[=!]|:|<[A-Za-z_$][\w$]*>)/, '')).filter(Boolean).map(run => run.slice(0, 64));
      for (const literal of literals.slice(0, 32)) { samples.add(literal); samples.add(' ' + literal + ' '); samples.add(base + literal + base); }
      if (literals.length) { samples.add(literals.join('')); samples.add(literals.join(' ')); }
    }
    const result = []; let bytes = 0;
    for (const sample of samples) { if ((bytes += Buffer.byteLength(sample)) > LIMITS.probeBytes) break; result.push(sample); }
    return result;
  }
  // pkg bytecode strips function source: Function#toString returns [native code].
  // Keep this trusted program as literal data; user patterns enter only postMessage.
  const WORKER_SOURCE = `
  (() => {
    const { parentPort } = require('node:worker_threads');
    parentPort.on('message', job => {
      let ruleId;
      try {
        const rules = job.rules.map(rule => {
          ruleId = rule.id;
          const regex = new RegExp(rule.value, rule.flags.replace(/g/g, '') + 'g');
          if (regex.test('')) throw { safe: 'regex_empty_match' };
          return { ...rule, regex, sticky: job.probes ? new RegExp(rule.value, rule.flags.replace(/g/g, '') + 'y') : null };
        });
        const rows = job.inputs.map(() => []); let count = 0;
        for (const rule of rules) {
          ruleId = rule.id;
          parentPort.postMessage({ progress: rule.id });
          if (rule.sticky) for (const input of job.probes) for (let at = 0; at <= input.length; at++) {
            rule.sticky.lastIndex = at; const found = rule.sticky.exec(input);
            if (found && !found[0].length) throw { safe: 'regex_empty_match' };
          }
          for (let i = 0; i < job.inputs.length; i++) {
            const input = job.inputs[i];
            rule.regex.lastIndex = 0; let found;
            while ((found = rule.regex.exec(input)) !== null) {
              if (!found[0].length) throw { safe: 'regex_empty_match' };
              if (++count > job.matches) throw { safe: 'regex_matches_limit' };
              rows[i].push({ start: found.index, end: found.index + found[0].length, category: rule.category, ruleIds: [rule.id] });
            }
          }
        }
        parentPort.postMessage({ ok: true, rows });
      } catch (error) {
        parentPort.postMessage({ ok: false, code: error.safe || 'regex_invalid', ruleId });
      }
    });
    parentPort.postMessage({ ready: true });
  })();
`;
  async function scan(rules, inputs, { signal, probe = false } = {}) {
    const selected = validateSchema(rules);
    if (!Array.isArray(inputs) || inputs.length > LIMITS.samples) throw fail('regex_input_limit');
    let bytes = 0;
    for (const input of inputs) { if (typeof input !== 'string' || Buffer.byteLength(input) > LIMITS.sample || (bytes += Buffer.byteLength(input)) > LIMITS.bytes) throw fail('regex_input_limit'); }
    if (signal?.aborted) throw fail('regex_aborted');
    if (!selected.length) return new Map(inputs.map(input => [input, []]));
    const rulesKey = digest(JSON.stringify(selected)) + ':';
    const keys = new Map(), result = new Map(), pending = [];
    for (const input of inputs) {
      if (keys.has(input)) continue;
      const key = rulesKey + digest(input); keys.set(input, key);
      const rows = probe ? undefined : cacheGet(key);
      if (rows) result.set(input, rows); else pending.push(input);
    }
    if (!pending.length) return new Map(inputs.map(input => [input, result.get(input)]));
    const scanned = await runWorker(selected, pending, signal, probe ? probeSamples(selected) : null);
    let count = 0;
    for (const rows of result.values()) count += rows.length;
    for (const [input, rows] of scanned) {
      if ((count += rows.length) > LIMITS.matches) throw fail('regex_matches_limit');
      const stored = freeze(rows); result.set(input, stored); if (!probe) cachePut(keys.get(input), stored);
    }
    return new Map(inputs.map(input => [input, result.get(input)]));
  }
  async function runWorker(selected, inputs, signal, probes) {
    await acquire(signal);
    let worker, timer, abort, settled = false, running;
    const jobInputs = inputs;
    // A save-time probe walks every position of its samples; it gets the largest budget once.
    const budget = probes ? LIMITS.runMsMax : runBudget(inputs.reduce((sum, input) => sum + Buffer.byteLength(input), 0));
    try {
      if (signal?.aborted) throw fail('regex_aborted');
      return await new Promise((resolve, reject) => {
        const finish = async (error, value) => {
          if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          try { if (worker) await worker.terminate(); } catch { /* error still fails closed */ }
          error ? reject(error) : resolve(value);
        };
        abort = () => { void finish(fail('regex_aborted')); };
        signal?.addEventListener('abort', abort, { once: true });
        try { worker = new workerThreads.Worker(WORKER_SOURCE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 }, stdout: true, stderr: true }); }
        catch { void finish(fail('regex_worker_failed')); return; }
        worker.stdout.resume(); worker.stderr.resume();
        timer = setTimeout(() => { void finish(fail('regex_startup_timeout')); }, LIMITS.startupMs);
        worker.on('error', () => { void finish(fail('regex_worker_failed')); });
        worker.on('exit', () => { if (!settled) void finish(fail('regex_worker_failed')); });
        let started = false;
        const known = id => selected.some(rule => rule.id === id) ? id : undefined;
        worker.on('message', message => {
          if (settled) return;
          if (message?.ready === true && !started) {
            started = true; clearTimeout(timer); timer = setTimeout(() => { void finish(fail('regex_timeout', running)); }, budget);
            worker.postMessage({ rules: selected, inputs: jobInputs, probes: probes || null, matches: LIMITS.matches }); return;
          }
          if (started && typeof message?.progress === 'string' && !Object.hasOwn(message, 'ok')) { running = known(message.progress); return; }
          if (!started || !message?.ok) { void finish(fail(['regex_invalid', 'regex_empty_match', 'regex_matches_limit'].includes(message?.code) ? message.code : 'regex_worker_failed', known(message?.ruleId))); return; }
          if (!Array.isArray(message.rows) || message.rows.length !== jobInputs.length) { void finish(fail('regex_result_invalid')); return; }
          let count = 0;
          for (let i = 0; i < message.rows.length; i++) {
            if (!Array.isArray(message.rows[i])) { void finish(fail('regex_result_invalid')); return; }
            for (const match of message.rows[i]) {
              const rule = selected.find(item => item.id === match.ruleIds?.[0]);
              if (++count > LIMITS.matches || !rule || rule.category !== match.category || !Number.isSafeInteger(match.start) || !Number.isSafeInteger(match.end) || match.start < 0 || match.end > jobInputs[i].length || match.start >= match.end) { void finish(fail('regex_result_invalid')); return; }
            }
          }
          void finish(null, new Map(inputs.map((input, i) => [input, message.rows[i]])));
        });
      });
    } finally { release(); }
  }
  const validate = rules => scan(rules, [''], { probe: true }).then(() => true);
  return Object.freeze({ LIMITS, scan, validate, validateSchema, activeJobs: () => activeJobs, queued: () => waiting.length, cacheSize: () => cache.size, runBudget });
})(require('node:worker_threads'), PrivacyCore, require('node:crypto'));
