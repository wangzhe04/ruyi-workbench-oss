'use strict';

// Manual-browser fixture for Escapade 2.4 structured questions. It starts an isolated fake provider and
// workbench so option descriptions, multi-select, custom answers, keyboard submission, and responsive layout
// can be inspected without a real model or network access.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const fakePort = String(process.argv[2] || '8878');
const workbenchPort = String(process.argv[3] || '8879');
const home = path.join(os.tmpdir(), `ruyi-question-ui-${process.pid}`);
const sequence = JSON.stringify([{
  name: 'request_user_input',
  args: {
    questions: [
      {
        id: 'release_channel',
        header: '发布方式',
        question: 'Escapade 2.4 应该先开放给哪些用户？',
        answerMode: 'single',
        allowOther: true,
        otherLabel: '其他发布方式',
        otherPlaceholder: '写下你的发布安排…',
        options: [
          { id: 'preview', label: '预览通道', description: '先让内部与受邀用户验证新交互' },
          { id: 'stable', label: '稳定通道', description: '完成回归后直接向全部用户开放' },
        ],
      },
      {
        id: 'quality_gates',
        header: '验收重点',
        question: '这次发布需要重点覆盖哪些验收项？',
        answerMode: 'multiple',
        options: [
          { id: 'keyboard', label: '键盘操作', description: '验证焦点、快捷键与无鼠标提交流程' },
          { id: 'mobile', label: '窄屏布局', description: '验证卡片在较小窗口中仍能完整使用' },
          { id: 'delivery', label: '送达确认', description: '确认网络失败不会丢失已填写的回答' },
        ],
      },
    ],
  },
}]);

fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  configSchema: 7,
  activeProvider: 'fake',
  engineMode: 'interactive',
  permissionMode: 'bypass',
  defaultWorkspace: home,
  providers: [{
    id: 'fake',
    label: 'Escapade 2.4 UI Fixture',
    type: 'openai-compat',
    baseUrl: `http://127.0.0.1:${fakePort}`,
    apiKey: 'fixture-key',
    model: 'fake-model',
    models: [{ id: 'fake-model', label: 'Fake model' }],
  }],
}, null, 2), 'utf8');

const children = [];
children.push(cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], {
  env: { ...process.env, FAKE_OPENAI_PORT: fakePort, FAKE_TOOL_SEQUENCE: sequence },
  stdio: 'inherit',
  windowsHide: true,
}));
children.push(cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', workbenchPort], {
  cwd: WB,
  env: { ...process.env, RUYI_HOME: home, HOME: home, USERPROFILE: home },
  stdio: 'inherit',
  windowsHide: true,
}));

console.log(`[question-ui] open http://127.0.0.1:${workbenchPort}/`);
const stop = () => {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); process.exit(0); });
process.on('exit', stop);
