'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = fs.realpathSync(process.argv[2]);
assert.match(path.basename(root), /^m5-fixed-http-[a-z0-9-]+$/i);
assert.equal(path.dirname(root), fs.realpathSync(path.resolve(__dirname, '../../../output')));
const files = path.join(root, 'held-test');
fs.mkdirSync(files);
const keeper = fs.readFileSync(path.join(__dirname, 'keeper.candidate.ps1'), 'utf8');
const extracted = keeper.match(/^Add-Type -TypeDefinition @'\r?\n[\s\S]*?\r?\n'@/m);
const writer = keeper.match(/^function Publish-Cohort[\s\S]*?\r?\n}/m);
assert.ok(extracted && writer);
const fixture = path.join(files, 'delay.cjs');
fs.writeFileSync(fixture, "setTimeout(() => process.exit(27), 500);", { flag: 'wx' });
const testScript = extracted[0] + '\n' + writer[0] + '\n' + String.raw`
$ErrorActionPreference='Stop'
$job=[IntPtr]::Zero
$held=$null
$own=$null
try{
 $job=[ResearchJob]::Create()
 $cmd='"'+$env:M5_TEST_NODE+'" "'+$env:M5_TEST_JS+'"'
 $own=[ResearchJob]::Start($job,$env:M5_TEST_NODE,$cmd,$env:TEMP)
 $held=[ResearchJob+HeldMember]::new($job,$own.pid)
 $cohortLog=Join-Path $env:TEMP 'cohort.jsonl'
 $sample=1
 Publish-Cohort @()
 $sample=2
 Publish-Cohort @(@{schema=1;sample=2;pid=$held.Pid})
 $sample=3
 Publish-Cohort @(@{schema=1;sample=3;pid=$held.Pid},@{schema=1;sample=3;pid=999})
 if($held.Retired -or $held.Birth -ne [ResearchJob]::Creation($own.process) -or $held.Image -ine $env:M5_TEST_NODE -or $held.Parent -ne $PID){throw 'bad first observation'}
 if([ResearchJob]::WaitForSingleObject($own.process,3000) -ne 0){throw 'synthetic process did not exit'}
 [void][ResearchJob]::CloseHandle($own.process)
 $own.process=[IntPtr]::Zero
 if(!$held.PollRetirement() -or !$held.Retired -or $held.ExitCode -ne 27 -or $held.PollRetirement()){throw 'same-handle retirement failed'}
 if([ResearchJob]::Stats($job).active -ne 0){throw 'job not empty'}
 $failure=$null
 try {$unknown=[ResearchJob+HeldMember]::new($job,0)}catch{$failure=$_.Exception.InnerException}
 if($failure.Stage -ne 'open-process'){throw 'unowned first open did not fail closed'}
 '{"heldExitCode":27,"firstOpenRejected":true,"jobActive":0}'
}finally{
 if($held){$held.Dispose()}
 if($own){
  if($own.process -ne [IntPtr]::Zero){[void][ResearchJob]::CloseHandle($own.process)}
  [void][ResearchJob]::CloseHandle($own.thread)
 }
 if($job -ne [IntPtr]::Zero){[void][ResearchJob]::CloseHandle($job)}
}`;
const script = path.join(files, 'test.ps1');
fs.writeFileSync(script, testScript, { flag: 'wx' });
const windows = fs.realpathSync(process.env.SystemRoot);
const out = cp.spawnSync(path.join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
  { cwd: files, windowsHide: true, timeout: 20000, encoding: 'utf8',
    env: { SystemRoot: windows, WINDIR: windows, PATH: path.join(windows, 'System32'), HOME: files,
      USERPROFILE: files, TEMP: files, TMP: files, LOCALAPPDATA: files, APPDATA: files,
      M5_TEST_NODE: fs.realpathSync(process.execPath), M5_TEST_JS: fixture } });
assert.equal(out.status, 0, out.stderr || out.error?.message);
assert.deepEqual(JSON.parse(out.stdout), { heldExitCode: 27, firstOpenRejected: true, jobActive: 0 });
const { completeSamples } = require('./controller-policy.cjs');
assert.deepEqual(completeSamples(fs.readFileSync(path.join(files, 'cohort.jsonl'), 'utf8')).map(r => r.sample), [2, 3, 3]);
console.log(out.stdout.trim());
