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
ok(thinkingCase.includes('live.thinkingBuffer') && thinkingCase.includes('scheduleLiveThinkingFollow(live)'),
  'thinking stream coalesces deltas into a per-frame buffer instead of per-event DOM writes');
const thinkingFlush = fnBody('flushThinkingBuffer');
ok(thinkingFlush.includes('thinkingNode.appendData'), 'batched thinking deltas are appended (not replaced) when flushed');

const mount = fnBody('mountActiveTurn');
ok(mount.includes("evt.type === 'assistant_delta'") && mount.includes("textParts.push(evt.text || '')")
  && mount.includes("textParts.join('')"), 'background turn replay coalesces deltas with batched join instead of quadratic concatenation');
ok(!mount.includes('finalizeLive('), 'mounting an active background turn does not prematurely finalize/detach it');
ok(mount.includes("box.querySelector('.empty-state')?.remove()") && mount.includes('turn.optimisticUserRow'),
  'mounting the first live turn removes the empty state and restores its optimistic user row');

const deliver = fnBody('deliverAgentRuns');
ok(deliver.includes('if (activeTurns.has(sid)) return;'), 'workflow polling never replaces a live chat message tree');

const finalize = fnBody('finalizeLive');
// 第54波叙事化重构后,finalizeLive 委托 sealLiveTextSegment 收尾文本段;大答案的 plain 兜底随委托
// 链落在 sealLiveTextSegment(LIVE_MARKDOWN_MAX_CHARS 阈值 + classList.add('plain') 非阻塞纯文本)。
// 锁委托链 + 兜底原位两点,行为契约不变(旧锚点只钉 finalizeLive 本体,重构后假红)。
ok(finalize.includes('sealLiveTextSegment'), 'finalizeLive settles via sealLiveTextSegment');
ok(finalize.includes('clearInterval(card.durationTimer)') && finalize.includes("t('status.stopped')")
  && finalize.includes("t('chat.toolResultMissing')") && finalize.includes('settleNarrativeTool(live, id, true)'),
  'turn settlement clears live clocks and terminalizes any tool card whose result event was lost');
const toolUseCase = src.slice(src.indexOf("case 'tool_use':"), src.indexOf("case 'todo':"));
ok(toolUseCase.includes('setInterval(updateDuration, 1000)') && toolUseCase.includes('clearInterval(card.durationTimer)'),
  'live tool cards show elapsed time and stop their timer when the result arrives');
const seal = fnBody('sealLiveTextSegment');
ok(seal.includes('MARKDOWN_SYNC_MAX_CHARS') && seal.includes("classList.add('plain')"), 'large settled answers keep a bounded non-blocking plain-text fallback');

const remember = fnBody('rememberTurnLine');
ok(remember.includes('turn.eventHead++') && !remember.includes('eventLines.shift('), 'post-cap stream replay eviction uses an O(1) logical head, never Array.shift');
ok(src.includes('MESSAGE_WINDOW_RENDER_BUDGET') && src.includes('weightedMessageTailStart(msgs'), 'history window is bounded by content weight as well as row count');
const highlight = fnBody('highlightIn');
ok(highlight.includes('requestIdleCallback') && highlight.includes('block.textContent.length > 16_000'), 'large code highlighting is skipped/batched through idle slices');

if (fail) { console.log(`\nSTREAMING RESPONSIVENESS STATIC E2E: FAIL (${fail})`); process.exitCode = 1; }
else console.log('\nSTREAMING RESPONSIVENESS STATIC E2E: ALL PASS');
