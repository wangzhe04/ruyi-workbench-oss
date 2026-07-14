'use strict';

// Static regression contract for three UI-thread stalls reported in long/multi-agent turns.
const { readFrontendSrc } = require('./read-frontend-src.js');
const src = readFrontendSrc();
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail++; console.log('FAIL ' + label); }
};
function fnBody(name, cap = 8000) {
  const i = src.indexOf(`function ${name}(`); if (i < 0) return '';
  const next = src.indexOf('\nfunction ', i + 1);
  return src.slice(i, next > i ? Math.min(next, i + cap) : i + cap);
}

const schedule = fnBody('scheduleRender');
ok(schedule.includes('textNode.appendData(pending)'), 'live answer rendering appends only the new delta');
ok(!schedule.includes('renderMarkdown(') && !schedule.includes('.innerHTML'), 'animation-frame hot path does not reparse full Markdown');

const thinkingCase = src.slice(src.indexOf("case 'thinking_delta':"), src.indexOf("case 'subagent':"));
ok(thinkingCase.includes('thinkingNode.appendData'), 'thinking stream also appends deltas instead of replacing all text');

const mount = fnBody('mountActiveTurn');
ok(mount.includes("evt.type === 'assistant_delta'") && mount.includes('text += evt.text'), 'background turn replay coalesces adjacent text deltas');
ok(!mount.includes('finalizeLive('), 'mounting an active background turn does not prematurely finalize/detach it');

const deliver = fnBody('deliverAgentRuns');
ok(deliver.includes('if (activeTurns.has(sid)) return;'), 'workflow polling never replaces a live chat message tree');

const finalize = fnBody('finalizeLive');
ok(finalize.includes('LIVE_MARKDOWN_MAX_CHARS') && finalize.includes("classList.add('plain')"), 'very large settled answers keep a non-blocking plain-text fallback');

if (fail) { console.log(`\nSTREAMING RESPONSIVENESS STATIC E2E: FAIL (${fail})`); process.exitCode = 1; }
else console.log('\nSTREAMING RESPONSIVENESS STATIC E2E: ALL PASS');
