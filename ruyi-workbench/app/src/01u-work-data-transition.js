// M3-3 admission primitive. Integration is deliberately explicit: an owner must enter run()
// before starting work and assertCurrent() immediately before publishing a disk mutation.
// No monkey-patching fs, no secret material, and no key lease spanning a model turn.
const WorkDataTransition = ((AsyncLocalStorage) => {
  const failure = suffix => Object.assign(new Error('work_data.transition_' + suffix), {
    code: 'work_data.transition_' + suffix, statusCode: 409,
  });
  const validGeneration = value => Number.isSafeInteger(value) && value >= 0;
  function create({ generation = 0 } = {}) {
    if (!validGeneration(generation)) throw failure('generation');
    const context = new AsyncLocalStorage();
    let current = generation, phase = 'open', active = 0, pending = null;
    // Tokens are capabilities, not caller-supplied generation numbers. Retain no completed token.
    const live = new Set();
    function assertCurrent() {
      const token = context.getStore();
      if (!token || !live.has(token) || token.generation !== current || phase === 'retired') {
        throw failure('stale_writer');
      }
      return current;
    }
    function wake() {
      if (pending && active === 0) pending.ready();
    }
    async function run(work) {
      if (typeof work !== 'function') throw new TypeError('work must be a function');
      const inherited = context.getStore();
      if (inherited) {
        // An admitted task may finish nested writes while admission is closing. A detached
        // continuation from an already finished task cannot resurrect that old admission.
        assertCurrent();
        active++;
        try { return await work(assertCurrent); }
        finally { active--; wake(); }
      }
      if (phase !== 'open') throw failure(phase === 'retired' ? 'restart_required' : 'busy');
      const token = { generation: current };
      live.add(token); active++;
      try { return await context.run(token, () => work(assertCurrent)); }
      finally { live.delete(token); active--; wake(); }
    }
    async function exclusive(work, { signal } = {}) {
      if (typeof work !== 'function') throw new TypeError('work must be a function');
      // Waiting for oneself would deadlock. An expired inherited context is also not an owner.
      if (context.getStore()) throw failure('nested_exclusive');
      if (phase !== 'open') throw failure(phase === 'retired' ? 'restart_required' : 'busy');
      if (signal?.aborted) throw failure('cancelled');
      phase = 'waiting';
      let abort, valid = true, committed = false;
      try {
        await new Promise((resolve, reject) => {
          pending = { ready: resolve };
          abort = () => reject(failure('cancelled'));
          signal?.addEventListener('abort', abort, { once: true });
          // Covers an AbortSignal implementation that aborts between the initial read and add.
          if (signal?.aborted) abort();
          else wake();
        });
        pending = null;
        phase = 'exclusive';
        const check = () => {
          if (!valid || phase !== 'exclusive') throw failure('owner_expired');
          if (signal?.aborted) throw failure('cancelled');
        };
        const owner = Object.freeze({
          generation: current,
          check,
          // Cancellation ends before publish starts. Even a rejected disk write can have an
          // ambiguous outcome (e.g. rename succeeded, directory flush failed). Only a fresh
          // process reading the durable manifest may resolve it; never reopen the old writer.
          async commit(next, publish) {
            check();
            if (!validGeneration(next) || next !== current + 1) throw failure('generation');
            if (typeof publish !== 'function') throw new TypeError('publish must be a function');
            committed = true; phase = 'committing';
            try {
              const result = await publish(); current = next; return result;
            } finally { phase = 'retired'; }
          },
        });
        return await work(owner);
      } finally {
        valid = false; pending = null;
        if (abort) signal?.removeEventListener('abort', abort);
        if (!committed) phase = 'open';
      }
    }
    function status() { return Object.freeze({ generation: current, phase, active }); }
    return Object.freeze({ run, exclusive, assertCurrent, status });
  }
  return Object.freeze({ create });
})(require('node:async_hooks').AsyncLocalStorage);
