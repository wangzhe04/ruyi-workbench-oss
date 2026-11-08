'use strict';
// Real settings Enable POST through production maintenance to the same browser
// page on the encrypted successor. Only the native folder dialog is substituted.
require('./lib/self-isolate-home');
const { runActual } = require('./work-data-production-maintenance.e2e');
const { safeFailure } = require('./lib/work-data-production-browser-attach');

runActual(process.argv.slice(2), { browserEntry: __filename }).catch(error => {
  console.error('BROWSER-ENABLE-DIAG ' + JSON.stringify(safeFailure(error)));
  process.exitCode = 1;
});
