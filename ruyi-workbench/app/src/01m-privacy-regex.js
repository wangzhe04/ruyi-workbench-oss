// P3: Custom RegExp executes only in a disposable, bounded worker. No user code enters eval source.
const PrivacyRegex = ((workerThreads, core) => {
  const LIMITS = Object.freeze({ rules: 20, source: 1024, bytes: 8 * 1024 * 1024, sample: 1024 * 1024, samples: 50000, matches: 10000, jobs: 2, startupMs: 3000, runMs: 250 });
  let activeJobs = 0;
  const fail = (code, ruleId) => Object.assign(new Error('privacy.' + code), { code: 'privacy.' + code, ...(ruleId ? { ruleId } : {}) });
  function validateSchema(rules) {
    core.createDetector({ rules });
    const selected = rules.filter(rule => rule.kind === 'regex');
    if (selected.length > LIMITS.rules) throw fail('regex_rules_limit');
    return selected.map(rule => ({ id: rule.id, category: rule.category, value: rule.value, flags: rule.flags || '' }));
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
          return { ...rule, regex };
        });
        const rows = []; let count = 0;
        for (const input of job.inputs) {
          const matches = [];
          for (const rule of rules) {
            ruleId = rule.id; rule.regex.lastIndex = 0; let found;
            while ((found = rule.regex.exec(input)) !== null) {
              if (!found[0].length) throw { safe: 'regex_empty_match' };
              if (++count > job.matches) throw { safe: 'regex_matches_limit' };
              matches.push({ start: found.index, end: found.index + found[0].length, category: rule.category, ruleIds: [rule.id] });
            }
          }
          rows.push(matches);
        }
        parentPort.postMessage({ ok: true, rows });
      } catch (error) {
        parentPort.postMessage({ ok: false, code: error.safe || 'regex_invalid', ruleId });
      }
    });
    parentPort.postMessage({ ready: true });
  })();
`;
  async function scan(rules, inputs, { signal } = {}) {
    const selected = validateSchema(rules);
    if (!Array.isArray(inputs) || inputs.length > LIMITS.samples) throw fail('regex_input_limit');
    let bytes = 0;
    for (const input of inputs) { if (typeof input !== 'string' || Buffer.byteLength(input) > LIMITS.sample || (bytes += Buffer.byteLength(input)) > LIMITS.bytes) throw fail('regex_input_limit'); }
    if (signal?.aborted) throw fail('regex_aborted');
    if (!selected.length) return new Map(inputs.map(input => [input, []]));
    if (activeJobs >= LIMITS.jobs) throw fail('regex_busy');
    activeJobs++;
    let worker, timer, abort, settled = false;
    try {
      return await new Promise((resolve, reject) => {
        const finish = async (error, result) => {
          if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          try { if (worker) await worker.terminate(); } catch { /* error still fails closed */ }
          error ? reject(error) : resolve(result);
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
        worker.on('message', result => {
          if (settled) return;
          if (result?.ready === true && !started) {
            started = true; clearTimeout(timer); timer = setTimeout(() => { void finish(fail('regex_timeout')); }, LIMITS.runMs);
            worker.postMessage({ rules: selected, inputs, matches: LIMITS.matches }); return;
          }
          if (!started || !result?.ok) { void finish(fail(['regex_invalid', 'regex_empty_match', 'regex_matches_limit'].includes(result?.code) ? result.code : 'regex_worker_failed', selected.some(rule => rule.id === result?.ruleId) ? result.ruleId : undefined)); return; }
          if (!Array.isArray(result.rows) || result.rows.length !== inputs.length) { void finish(fail('regex_result_invalid')); return; }
          let count = 0;
          for (let i = 0; i < result.rows.length; i++) {
            if (!Array.isArray(result.rows[i])) { void finish(fail('regex_result_invalid')); return; }
            for (const match of result.rows[i]) {
              const rule = selected.find(item => item.id === match.ruleIds?.[0]);
              if (++count > LIMITS.matches || !rule || rule.category !== match.category || !Number.isSafeInteger(match.start) || !Number.isSafeInteger(match.end) || match.start < 0 || match.end > inputs[i].length || match.start >= match.end) { void finish(fail('regex_result_invalid')); return; }
            }
          }
          void finish(null, new Map(inputs.map((input, i) => [input, result.rows[i]])));
        });
      });
    } finally { activeJobs--; }
  }
  const validate = rules => scan(rules, ['']).then(() => true);
  return Object.freeze({ LIMITS, scan, validate, validateSchema, activeJobs: () => activeJobs });
})(require('node:worker_threads'), PrivacyCore);
