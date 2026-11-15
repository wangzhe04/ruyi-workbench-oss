from pathlib import Path
import datetime, hashlib, json, os, re, shlex, shutil, subprocess, tempfile, time

ROOT = Path(__file__).resolve().parents[6]
OUT = Path(__file__).resolve().parent
BINDING = ROOT / 'MACOS-PORTING/evidence/P5/ax/apps/source-fingerprint-bounded.json'
FROZEN = json.loads(BINDING.read_text())['files']
NODE = '/Users/jiming/.local/share/nodejs/node-v24.15.0-darwin-arm64/bin/node'
PYTHON = str(ROOT / 'mcp/ai-computer-control/.venv/bin/python')
PROCESS_HELPER = ROOT / 'ruyi-workbench/runtime/macos/ruyi-process-helper'
BROWSER = '/Users/jiming/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def hashes():
    return {name: {'expected': expected, 'actual': digest(ROOT / name), 'match': digest(ROOT / name) == expected} for name, expected in FROZEN.items()}

def snapshot():
    output = subprocess.check_output([str(PROCESS_HELPER), '--snapshot'], text=True)
    if not output.startswith('RUYI-PROCESS-V1\n'):
        raise RuntimeError('Native birth-identity process snapshot unavailable')
    rows = []
    for line in output.splitlines()[1:]:
        parts = line.split(',', 3)
        if len(parts) == 4:
            rows.append({'pid': int(parts[0]), 'ppid': int(parts[1]), 'created': parts[2], 'name': parts[3]})
    return rows

def descendants(rows, root_pid):
    selected = {row['pid']: row for row in rows if row['pid'] == root_pid}
    changed = True
    while changed:
        changed = False
        for row in rows:
            parent = selected.get(row['ppid'])
            if row['pid'] not in selected and parent and int(row['created']) >= int(parent['created']):
                selected[row['pid']] = row
                changed = True
    return list(selected.values())

def command_result(args):
    result = subprocess.run(args, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return {'command': args, 'exitCode': result.returncode, 'output': result.stdout}

def binaries():
    names = ['ruyi-workbench/runtime/macos/ruyi-automation-helper', 'ruyi-workbench/runtime/macos/ruyi-process-helper',
             'ruyi-workbench/dist/Ruyi.app/Contents/MacOS/RuyiDesktop', 'ruyi-workbench/dist/Ruyi.app/Contents/Resources/build.json',
             'ruyi-workbench/dist/Ruyi.app/Contents/Info.plist']
    data = {name: {'sha256': digest(ROOT / name), 'bytes': (ROOT / name).stat().st_size} for name in names}
    metadata = json.loads((ROOT / names[3]).read_text())
    data['appBuildSourceVerification'] = {name: {'expected': value, 'actual': digest(ROOT / 'ruyi-workbench' / name), 'match': digest(ROOT / 'ruyi-workbench' / name) == value} for name, value in metadata['sourceFingerprint'].items()}
    data['signatures'] = [command_result(['/usr/bin/codesign', '--verify', '--strict', str(ROOT / names[0])]),
                          command_result(['/usr/bin/codesign', '--display', '--verbose=4', str(ROOT / names[0])]),
                          command_result(['/usr/bin/codesign', '--verify', '--strict', str(ROOT / 'ruyi-workbench/dist/Ruyi.app')])]
    return data

common = {'DYLD_FRAMEWORK_PATH': '/Users/jiming/.local/esp-runtimes',
          'DYLD_LIBRARY_PATH': '/Users/jiming/.local/esp-runtimes/Python.framework/Versions/3.12/lib',
          'RUYI_REAL_HOME': '/Users/jiming', 'PYTHONPATH': str(ROOT / 'mcp/ai-computer-control/src'),
          'RUYI_E2E_BROWSER': BROWSER, 'RUYI_P5_INPUT_REQUIRED': '1', 'RUYI_P5_CAPTURE_REQUIRED': '1', 'RUYI_ACC_REQUIRED': '1'}
cases = [
 ('ax-ttl', NODE, ['dev-harness/macos-ax.e2e.js'], {'RUYI_P5_AX_REQUIRED': '1', 'RUYI_P5_AX_EXPIRY_TEST': '1'}, 0),
 ('app-ax', NODE, ['dev-harness/macos-input-host.e2e.js'], {'RUYI_P5_APP_AX': '1'}, 0),
 ('app-unicode', NODE, ['dev-harness/macos-input-host.e2e.js'], {}, 0),
 ('app-paste', NODE, ['dev-harness/macos-input-host.e2e.js'], {'RUYI_P5_APP_PASTE': '1'}, 0),
 ('events', NODE, ['dev-harness/macos-input-events.e2e.js'], {}, 0),
 ('window-clipboard', NODE, ['dev-harness/macos-window-clipboard.e2e.js'], {}, 0),
 ('selected-apps', NODE, ['dev-harness/macos-input-apps.e2e.js'], {'RUYI_INDEPENDENT_BROWSER_MODE': 'wrapper'}, 0),
 ('apps-ax-default', NODE, ['dev-harness/macos-input-apps.e2e.js'], {'RUYI_P5_APPS_AX': '1'}, 0),
 ('apps-ax-renderer', NODE, ['dev-harness/macos-input-apps.e2e.js'], {'RUYI_P5_APPS_AX': '1', 'RUYI_P5_APPS_AX_RENDERER': '1', 'RUYI_INDEPENDENT_BROWSER_MODE': 'symlink'}, 0),
 ('finder', NODE, ['dev-harness/macos-ax-finder.e2e.js'], {'RUYI_P5_FINDER_REQUIRED': '1'}, 0),
 ('finder-forced-failure', NODE, ['dev-harness/macos-ax-finder.e2e.js'], {'RUYI_P5_FINDER_REQUIRED': '1', 'RUYI_P5_FINDER_FAIL_AFTER_OBSERVE': '1'}, 1),
 ('browser-deadline-unit', NODE, ['--test', 'dev-harness/unit/browser-fixture-deadline.test.js'], {}, 0),
 ('theme-browser', NODE, ['dev-harness/theme-default.browser.e2e.js'], {}, 0),
 ('apps-blocked-cdp', NODE, ['dev-harness/macos-input-apps.e2e.js'], {'RUYI_P5_APPS_BLOCK_CDP': '1'}, 1),
 ('capture', NODE, ['dev-harness/macos-capture.e2e.js'], {}, 0),
 ('capture-contract', NODE, ['dev-harness/macos-capture-contract.e2e.js'], {}, 0),
 ('shared', NODE, ['dev-harness/macos-acc-shared.e2e.js'], {}, 0),
] + [('python-' + name, PYTHON, ['mcp/ai-computer-control/tests/smoke_macos_' + name + '.py'], {}, 0) for name in ['ax', 'input', 'shared', 'events', 'capture']] + [
 ('app-ax-forced-exit', NODE, ['dev-harness/macos-input-host.e2e.js'], {'RUYI_P5_APP_AX': '1', 'RUYI_P5_APP_EXIT_FAILURE': '1'}, 1)
]
record = {'reviewer': '/root/p5_review_resumed', 'candidateBinding': str(BINDING.relative_to(ROOT)), 'sourceFingerprintSha256': digest(BINDING),
          'sourceFiles': len(FROZEN), 'startedAt': now(), 'commonEnvironment': common, 'serialExecution': True,
          'host': {key: command_result(value) for key, value in {'swVers': ['/usr/bin/sw_vers'], 'arch': ['/usr/bin/uname', '-m'], 'sdk': ['/usr/bin/xcrun', '--show-sdk-version'], 'node': [NODE, '--version'], 'python': [PYTHON, '--version']}.items()},
          'binaryBefore': binaries(), 'runs': []}
def save():
    (OUT / 'runs.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
save()
for name, executable, args, extra, expected_exit in cases:
    case_dir = OUT / name
    case_dir.mkdir(exist_ok=True)
    before = hashes()
    if not all(row['match'] for row in before.values()):
        record['blocked'] = {'name': name, 'reason': 'Frozen source mismatch before execution', 'hashes': before}
        save()
        break
    isolation = Path(tempfile.mkdtemp(prefix='p5-ax-independent-' + name + '-'))
    for subdir in ['home', 'local', 'roaming', 'data']:
        (isolation / subdir).mkdir()
    env = {key: value for key, value in os.environ.items() if not key.startswith('RUYI_P5_') and key not in {'RUYI_MACOS_AUTOMATION_HELPER', 'RUYI_HOME', 'RUYI_DESKTOP_TEST_APP', 'WIN_CLAUDE_WORKBENCH_HOME'}}
    env.update(common)
    env.update({'HOME': str(isolation / 'home'), 'USERPROFILE': str(isolation / 'home'), 'LOCALAPPDATA': str(isolation / 'local'), 'APPDATA': str(isolation / 'roaming'), 'WCW_DATA_DIR': str(isolation / 'data'), 'RUYI_P5_EVIDENCE': str(case_dir)})
    env.update(extra)
    browser_fixture = None
    browser_mode = env.pop('RUYI_INDEPENDENT_BROWSER_MODE', None)
    if browser_mode == 'wrapper':
        wrapper = isolation / 'CFT wrapper'
        wrapper_text = '#!/bin/sh\nexec ' + shlex.quote(BROWSER) + ' "$@"\n'
        wrapper.write_text(wrapper_text)
        wrapper.chmod(0o755)
        env['RUYI_E2E_BROWSER'] = str(wrapper)
        browser_fixture = {'kind': 'exec shell wrapper', 'path': str(wrapper), 'content': wrapper_text, 'sha256': digest(wrapper)}
    elif browser_mode == 'symlink':
        link = isolation / 'CFT binary link'
        link.symlink_to(BROWSER)
        env['RUYI_E2E_BROWSER'] = str(link)
        browser_fixture = {'kind': 'binary symlink', 'path': str(link), 'resolved': str(link.resolve()), 'targetSha256': digest(link)}
    started = time.monotonic()
    baseline = snapshot()
    baseline_ids = {(row['pid'], row['created']) for row in baseline}
    run = {'name': name, 'command': executable, 'args': args, 'extraEnvironment': extra, 'expectedExit': expected_exit,
           'startTime': now(), 'before': before, 'isolation': {key: env[key] for key in ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'WCW_DATA_DIR']}}
    run['browserPathCompatibilityFixture'] = browser_fixture
    observed = {}
    external_app = set()
    print('START ' + name, flush=True)
    with (case_dir / 'run.txt').open('w') as log:
        child = subprocess.Popen([executable] + args, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        while child.poll() is None:
            rows = snapshot()
            for row in descendants(rows, child.pid):
                observed[(row['pid'], row['created'])] = row
            # LaunchServices creates the App outside the runner tree. Its exact executable and post-baseline birth bind it.
            app_pids = subprocess.check_output(['/usr/bin/pgrep', '-f', str(ROOT / 'ruyi-workbench/dist/Ruyi.app/Contents/MacOS/RuyiDesktop')], text=True).split() if name.startswith('app-') and subprocess.run(['/usr/bin/pgrep', '-f', str(ROOT / 'ruyi-workbench/dist/Ruyi.app/Contents/MacOS/RuyiDesktop')], stdout=subprocess.DEVNULL).returncode == 0 else []
            for row in rows:
                identity = (row['pid'], row['created'])
                if str(row['pid']) in app_pids and identity not in baseline_ids:
                    external_app.add(row['pid'])
            for app_pid in external_app:
                for row in descendants(rows, app_pid):
                    if (row['pid'], row['created']) not in baseline_ids:
                        observed[(row['pid'], row['created'])] = row
            if time.monotonic() - started > 600 and not run.get('runnerDeadlineExceeded'):
                run['runnerDeadlineExceeded'] = True
                run['emergencyPolicy'] = 'No whole-tree termination. Preserve live clipboard snapshot and report for targeted recovery.'
                record['activeDeadlineAttention'] = {'name': name, 'pid': child.pid, 'at': now(), 'policy': run['emergencyPolicy']}
                save()
                print('DEADLINE ATTENTION ' + name + ' pid=' + str(child.pid) + ' snapshot preserved; no process killed', flush=True)
            time.sleep(0.20)
        exit_code = child.wait()
    # Let system exit bookkeeping settle without changing the process outcome.
    deadline = time.monotonic() + 6
    while True:
        current_rows = snapshot()
        current = {(row['pid'], row['created']) for row in current_rows}
        leftovers = [row for identity, row in observed.items() if identity in current]
        if not leftovers or time.monotonic() >= deadline:
            break
        time.sleep(0.2)
    text = (case_dir / 'run.txt').read_text()
    python_count = re.search(r'Ran (\d+) tests?', text)
    run.update(exitCode=exit_code if exit_code >= 0 else None, signal=-exit_code if exit_code < 0 else None,
               naturalExit=exit_code >= 0, durationSeconds=round(time.monotonic()-started, 3),
               expectedOutcomeMatched=exit_code == expected_exit and not run.get('runnerDeadlineExceeded', False), passLines=len(re.findall(r'^PASS ', text, re.M)), failLines=len(re.findall(r'^FAIL ', text, re.M)),
               skipLines=len(re.findall(r'^SKIP ', text, re.M)), pythonTests=int(python_count.group(1)) if python_count else None,
               pythonOK=bool(re.search(r'^OK$', text, re.M)) if python_count else None,
               after=hashes(), logSha256=digest(case_dir / 'run.txt'), finishedAt=now(),
               ownedProcessObservation={'method': 'Native process birth identities sampled at 200ms. Runner descendants plus exact post-baseline LaunchServices App and its observed descendants.',
                                        'observed': list(observed.values()), 'remaining': leftovers, 'confirmedAbsent': not leftovers})
    if name.startswith('finder'):
        finder_baseline_path = case_dir / 'baseline.json'
        finder_cleanup_path = case_dir / 'cleanup.json'
        finder_baseline = json.loads(finder_baseline_path.read_text()) if finder_baseline_path.exists() else {}
        prior_finder = next((row for row in baseline if row['pid'] == finder_baseline.get('pid')), None)
        finder_cleanup = json.loads(finder_cleanup_path.read_text()) if finder_cleanup_path.exists() else None
        run['sharedFinderProcess'] = {'baselineBirth': prior_finder, 'sameBirthSurvives': bool(prior_finder and (prior_finder['pid'], prior_finder['created']) in current), 'fixtureCleanup': finder_cleanup}
    if expected_exit == 1 and name != 'apps-blocked-cdp':
        injected = 'Injected Finder fixture failure after ownership observation' if name.startswith('finder') else 'Injected App-exit cleanup fixture failure'
        run['expectedInjectedFailure'] = injected
        run['expectedOutcomeMatched'] = exit_code == 1 and run['failLines'] == 1 and ('FAIL Error: ' + injected) in text
    unit_count = re.search(r'(?:ℹ|#) tests (\d+)', text)
    if unit_count:
        run['nodeUnitTests'] = int(unit_count.group(1))
    if name == 'apps-blocked-cdp':
        startup = json.loads((case_dir / 'browser-startup.json').read_text()) if (case_dir / 'browser-startup.json').exists() else {}
        run['blockedDiscoveryEvidence'] = startup
        run['expectedOutcomeMatched'] = exit_code == 1 and run['failLines'] == 1 and startup.get('injectedNonrespondingEndpoint') is True and startup.get('targetObserved') is False and 14000 <= startup.get('elapsedMs', 0) < 20000 and 'PASS selected-app fixture restores the pre-test clipboard' in text and 'PASS controlled browser profile is removed after its processes exit' in text
    if name.startswith('finder'):
        run['expectedOutcomeMatched'] = run['expectedOutcomeMatched'] and run['sharedFinderProcess']['sameBirthSurvives'] and bool(run['sharedFinderProcess']['fixtureCleanup'] and run['sharedFinderProcess']['fixtureCleanup'].get('cleaned'))
    (case_dir / 'result.json').write_text(json.dumps(run, indent=2) + '\n')
    record['runs'].append(run)
    save()
    print('END ' + name + ' ' + json.dumps({key: run[key] for key in ['exitCode', 'naturalExit', 'passLines', 'failLines', 'skipLines', 'pythonTests']}) + ' remaining=' + str(len(leftovers)), flush=True)
    if not run['expectedOutcomeMatched'] or leftovers or not all(row['match'] for row in run['after'].values()):
        record['blocked'] = {'name': name, 'reason': 'Unexpected run outcome, owned residue or source drift requires review'}
        save()
        break
    shutil.rmtree(isolation)
record['binaryAfter'] = binaries()
record['finishedAt'] = now()
record['sourceHashesFinal'] = hashes()
save()
print('COMPLETE ' + str(len(record['runs'])) + ' runs', flush=True)
