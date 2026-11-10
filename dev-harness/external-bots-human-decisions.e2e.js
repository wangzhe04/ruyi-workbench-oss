'use strict';
// Permanent offline HTTP/protocol/current-model/original-consumer regression.
// Default executes all five types/nine actions. Direct runs must be serial;
// run-all retains its original 120s per-case budget, with no timeout override.
// Each action owns a fresh complete fixture and case evidence directory; its
// original business and known close finish before the next action starts.
require('./lib/self-isolate-home.js');
const { runJourneys } = require('./lib/external-bots-c2/run-journeys.cjs');
const flags = process.argv.slice(2);
const staleBrowserOffer = flags.includes('--stale-browser-offer');
if (flags.some(value => !['--permission-only', '--positive-only', '--stale-browser-offer'].includes(value))
  || new Set(flags).size !== flags.length || staleBrowserOffer && flags.length !== 1) {
  throw Error('Use --permission-only and/or --positive-only, or --stale-browser-offer alone');
}
runJourneys({ types: flags.includes('--permission-only') ? ['permission'] : undefined,
  positiveOnly: flags.includes('--positive-only'), browser: staleBrowserOffer, staleBrowserOffer, output: process.env.RUYI_C2_EVIDENCE_DIR })
  .catch(error => { console.error(error.stack || error); process.exitCode = 1; });
