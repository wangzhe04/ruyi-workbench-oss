'use strict';
// Rerun the same synthetic long field/tokenizer witness against window-v2,
// preserving both earlier full-field observations and their corrected verdict.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const basePath = path.join(__dirname, 'scalar-long-field-repro.cjs'), hash = value => crypto.createHash('sha256').update(value).digest('hex');
let source = fs.readFileSync(basePath, 'utf8');
if (hash(source) !== '13c676ff4e50e40cd226cbbda38c4a4e110b72d3a94fbf281e1715b64b2f3951') throw Error('Long field original repro changed.');
for (const [before, after] of [["'./scalar-producer-research-source.cjs'", "'./scalar-window-producer-research-source.cjs'"], ["'./scalar-composite-policy-research.cjs'", "'./scalar-window-policy-research.cjs'"]]) {
  if (!source.includes(before)) throw Error('Window repro redirect missing.'); source = source.split(before).join(after);
}
const from = source.indexOf('    report.priorReproVerdictCorrection ='), to = source.indexOf('  } catch (error)', from);
if (from < 0 || to < from) throw Error('Long field outcome assertion boundary changed.');
source = source.slice(0, from) + `    report.contract='window-v2 same original source and actual tokenizer counts; no whole-field verification write';
    report.status=report.runs.every(run=>run.sourceCoverage.complete&&run.privateDiagnostic.globalCoarseComplete&&run.semantic.coverage==='complete'&&!run.lexical.partial&&run.resultCount===1&&run.privateDiagnostic.scalarPairs===1&&run.privateDiagnostic.requiredWork.every(work=>work.identity.end-work.identity.start===96))&&report.scalarInputs.length===1&&report.scalarInputs[0].characters===96?'PASS_LONG_FIELD_FIXED_WINDOW_COMPLETE':'FAIL_WINDOW_COMPLETION';
` + source.slice(to);
// This CLI wrapper is the main module; retain the original main-only entry.
source = source.replace('if (require.main === module) main(', 'main(');
const compiled = new Module(__filename, module); compiled.filename = __filename; compiled.paths = Module._nodeModulePaths(__dirname); compiled._compile(source, __filename);
