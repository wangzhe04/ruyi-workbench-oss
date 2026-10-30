'use strict';
require('./lib/self-isolate-home');
// Natural settings entrance, bilingual/theme form, preview errors, edits and a
// real scheduled Playbook model turn using the existing file_write tool.
const fs = require('node:fs'), path = require('node:path');
const { startBrowserFixture, READY } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');
const t = createRunner('SCHEDULED PLAYBOOKS BROWSER');
let fx, finalPrompt = '';
const open = `(() => { document.getElementById('openSettingsBtn').click(); document.querySelector('#settingsTabs button[data-stab="steward"]').click(); return true; })()`;
(async () => {
  try {
    fx = await startBrowserFixture({ ok: t.ok, prefix: 'ruyi-scheduled-playbooks-browser-',
      config: { schedulerEnabledV1: true, stewardEnabledV1: false, permissionMode: 'acceptEdits' },
      serverEnv: { WCW_TEST_NO_NET_ANCHORS: '1' },
      provider: ctx => {
        const message = String(ctx.messages.findLast(row => row.role === 'user')?.content || '');
        if (message.includes('SCHEDULE_BROWSER') && !ctx.answered) {
          finalPrompt = message;
          ctx.toolCall('file_write', { path: /Write report: ([^\r\n]+)/.exec(message)?.[1], content: '# Scheduled browser report\nActual tool output\n' });
        } else ctx.text('Done.');
        ctx.stop();
      },
      prepare: async ({ request }) => {
        const response = await request('POST', '/api/playbooks', { id: 'pb_schedule_browser', title: '保存的定时做法',
          inputs: [{ key: 'output', label: '报告文件 / Report file', type: 'file', required: true }, { key: 'subject', label: '主题 / Subject', type: 'text', required: true }],
          promptTemplate: 'SCHEDULE_BROWSER\nWrite report: {output}\nSubject: {subject}', requires: [] });
        if (response?.status !== 200) throw Error('cannot prepare Playbook');
      } });
    for (const [index, locale, theme] of [[0, 'zh-CN', 'dark'], [1, 'en-US', 'light']]) {
      if (index) {
        await fx.request('POST', '/api/config', { locale, theme }); await fx.cdp.send('Page.reload', { ignoreCache: true });
        await fx.waitForEval(READY);
        await fx.waitForEval(`window.state?.config?.locale === '${locale}' ? true : null`);
      }
      await fx.evaluate(open);
      await fx.waitForEval(`document.getElementById('cfgStewardScheduleNewBtn')?.onclick ? true : null`);
      await fx.evaluate(`document.getElementById('cfgStewardScheduleNewBtn').click()`);
      await fx.waitForEval(`document.querySelector('#cfgStewardSchedulePlaybook option') ? true : null`);
      await fx.evaluate(`(() => {
        const put = (name,value) => { const node = document.getElementById('cfgStewardSchedule' + name); node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); };
        put('Title', 'Browser schedule ${index}'); put('Kind', 'daily'); put('PayloadKind', 'playbook');
        const select = document.getElementById('cfgStewardSchedulePlaybook');
        select.value = [...select.options].find(row => row.textContent === '保存的定时做法').value; select.dispatchEvent(new Event('change'));
        document.querySelector('[data-input-key="output"]').value = ${JSON.stringify(path.join(fx.work, 'report-'))} + '${index}.md';
        document.querySelector('[data-input-key="subject"]').value = 'Current source ${index}';
        put('Checks', 'Write this run’s report and give evidence'); put('Timezone', 'Invalid/Zone');
        document.getElementById('cfgStewardSchedulePreviewBtn').click(); return true;
      })()`);
      const error = await fx.waitForEval(`(() => { const message = document.getElementById('cfgStewardScheduleFormError').textContent; return message.includes('Asia/Shanghai') ? message : null; })()`);
      t.ok(!!error && !error.includes('scheduler.invalid_timezone'), locale + ': invalid zone gives actionable translated recovery');
      await fx.evaluate(`(() => { document.getElementById('cfgStewardScheduleTimezone').value = 'UTC'; document.getElementById('cfgStewardSchedulePreviewBtn').click(); return true; })()`);
      t.ok(!!await fx.waitForEval(`document.querySelectorAll('#cfgStewardSchedulePreview li').length === 5 ? true : null`), locale + ': selected zone previews five future triggers before saving');
      await fx.evaluate(`document.getElementById('cfgStewardScheduleForm').requestSubmit()`);
      t.ok(!!await fx.waitForEval(`document.getElementById('cfgStewardScheduleForm').hidden && document.querySelectorAll('#cfgStewardSchedule .steward-schedule-row').length === ${index + 1} ? true : null`), locale + ': real form saves selected Playbook with required typed inputs and checks');
      const tasks = (await fx.request('GET', '/api/scheduler/tasks')).json.tasks;
      const task = tasks.find(row => row.title === 'Browser schedule ' + index);
      t.ok(task?.payload?.kind === 'playbook' && task.payload.values.subject === 'Current source ' + index && task.schedule.tz === 'UTC', locale + ': server definition matches visible form');
      const run = await fx.request('POST', '/api/scheduler/tasks/' + task.id + '/run-now', {}, 60000);
      t.ok(run.status === 200 && run.json.outcome === 'succeeded' && fs.readFileSync(path.join(fx.work, 'report-' + index + '.md'), 'utf8').includes('Actual tool output'), locale + ': saved Playbook runs through real model/tool dispatch');
      t.ok(finalPrompt.includes('Current source ' + index) && finalPrompt.includes('Write this run’s report and give evidence'), locale + ': final provider prompt contains entered variables and acceptance conditions');
      await fx.evaluate(`(() => { const row = [...document.querySelectorAll('.steward-schedule-row')].find(node => node.dataset.taskId === '${task.id}'); [...row.querySelectorAll('button')].find(node => /^(编辑|Edit)$/.test(node.textContent)).click(); return true; })()`);
      await fx.escape();
      t.ok(await fx.evaluate(`document.getElementById('cfgStewardScheduleForm').hidden`), locale + ': R3 closing settings retires the editor lifecycle');
      await fx.evaluate(open);
      await fx.evaluate(`(() => { const row = [...document.querySelectorAll('.steward-schedule-row')].find(node => node.dataset.taskId === '${task.id}'); [...row.querySelectorAll('button')].find(node => /^(编辑|Edit)$/.test(node.textContent)).click(); return true; })()`);
      t.ok(!!await fx.waitForEval(`document.querySelector('[data-input-key="subject"]')?.value === 'Current source ${index}' ? true : null`), locale + ': edit reopens the pinned copy and its inputs');
      await fx.evaluate(`(() => { window.__scheduledRefreshInput = document.querySelector('[data-input-key="subject"]'); document.getElementById('cfgStewardSchedulePlaybookRefresh').click(); return true; })()`);
      if (!await fx.waitForEval(`window.__scheduledRefreshInput && !window.__scheduledRefreshInput.isConnected ? true : null`)) throw Error('library refresh did not settle');
      t.ok(await fx.evaluate(`document.querySelector('[data-input-key="subject"]')?.value === 'Current source ${index}' && document.getElementById('cfgStewardScheduleChecks').value === 'Write this run’s report and give evidence'`), locale + ': R5 actual refresh keeps current variables and acceptance draft');
      for (const permission of ['plan', '']) {
        await fx.evaluate(`(() => { document.getElementById('cfgStewardSchedulePermission').value = '${permission}'; document.getElementById('cfgStewardSchedulePreviewBtn').click(); return true; })()`);
        if (!await fx.waitForEval(`document.querySelectorAll('#cfgStewardSchedulePreview li').length === 5 ? true : null`)) throw Error('edit preview unavailable');
        await fx.evaluate(`document.getElementById('cfgStewardScheduleForm').requestSubmit()`);
        if (!await fx.waitForEval(`document.getElementById('cfgStewardScheduleForm').hidden ? true : null`)) throw Error('edit save did not close form');
        const saved = (await fx.request('GET', '/api/scheduler/tasks')).json.tasks.find(row => row.id === task.id);
        t.ok(saved.autonomy.permissionMode === permission, locale + ': R2 actual editor persists ' + (permission || 'follow global'));
        if (permission) {
          await fx.cdp.send('Page.reload', { ignoreCache: true }); await fx.waitForEval(READY); await fx.evaluate(open);
          if (!await fx.waitForEval(`document.querySelector('.steward-schedule-row[data-task-id="${task.id}"]') ? true : null`)) throw Error('saved schedule row unavailable');
          await fx.evaluate(`(() => { const row = [...document.querySelectorAll('.steward-schedule-row')].find(node => node.dataset.taskId === '${task.id}'); [...row.querySelectorAll('button')].find(node => /^(编辑|Edit)$/.test(node.textContent)).click(); return true; })()`);
          if (!await fx.waitForEval(`document.getElementById('cfgStewardSchedulePermission').value === 'plan' && document.querySelector('[data-input-key="subject"]')?.value === 'Current source ${index}' ? true : null`)) throw Error('saved permission not restored for editing');
        }
      }
      await fx.resize(390, 844);
      const fits = await fx.evaluate(`document.getElementById('cfgStewardGroupSchedule').scrollWidth <= document.getElementById('cfgStewardGroupSchedule').clientWidth + 2`);
      t.ok(fits, locale + ': schedule controls fit a narrow viewport');
      await fx.resize(1280, 900);
      await fx.escape();
    }
    t.ok(fx.exceptions.length === 0, 'zero uncaught browser errors');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { if (fx) await fx.close({ keepRoot: t.failures > 0 }); t.done({ exit: true }); }
})();
