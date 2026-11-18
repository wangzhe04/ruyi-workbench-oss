"""Root replay of frozen VM/mock/source checks. Never execute the compiled host."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'output/semantic-resident-home-service-candidate-v2'
OUT = ROOT / 'output/semantic-resident-home-service-root-v2'
PIN = '1c56c2072752e06be34fb9253675b72d4ed38e866b8a1a9c2cc72df8629627ad'
sha = lambda raw: hashlib.sha256(raw).hexdigest()
raw = (SOURCE / 'freeze.json').read_bytes()
assert sha(raw) == PIN
f = json.loads(raw)
assert len(f['bindings']) == 61 and len(f['testFiles']) == 10


def verify():
    for row in f['bindings']:
        file = Path(row['file'])
        assert 'acceptance' not in str(file).lower() and '%SystemDrive%' not in file.parts
        data = file.read_bytes()
        assert len(data) == row['bytes'] and sha(data) == row['sha256']


verify()
OUT.mkdir()
home = OUT / 'home'
for part in ('tmp', 'local', 'roaming'):
    (home / part).mkdir(parents=True, exist_ok=True)
plan = json.loads((SOURCE / 'compile-plan.json').read_text(encoding='utf-8'))
win = Path(plan['compiler']['file']).resolve().parents[3]
assert win.name.lower() == 'windows'
env = {'SystemRoot': str(win), 'WINDIR': str(win), 'SystemDrive': win.anchor[:-1],
       'PATH': str(win / 'System32'), 'HOME': str(home), 'USERPROFILE': str(home),
       'APPDATA': str(home / 'roaming'), 'LOCALAPPDATA': str(home / 'local'),
       'TEMP': str(home / 'tmp'), 'TMP': str(home / 'tmp')}
node = Path('C:/Program Files/nodejs/node.exe')
with node.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == '63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088'
result = subprocess.run([str(node), '--test', '--test-reporter=tap', *f['testFiles']],
                        cwd=SOURCE, env=env, capture_output=True, timeout=45,
                        creationflags=subprocess.CREATE_NO_WINDOW)
log = result.stdout + result.stderr
(OUT / 'root-tests.log').write_bytes(log)
attempt = {'exitCode': result.returncode, 'logSha256': sha(log)}
(OUT / 'attempt.json').write_text(json.dumps(attempt, indent=2) + '\n', encoding='utf-8')
assert result.returncode == 0 and b'# pass 65' in result.stdout and b'# fail 0' in result.stdout and b'# skipped 0' in result.stdout
verify()
receipt = {'status': 'ROOT_RESIDENT_HOME_V2_65_NATIVE_FREE_SCOPED_PASS',
           'freezeSha256': PIN, 'bindingsVerifiedBeforeAndAfter': 61,
           'testFiles': 10, 'unitPass': 65, 'skip': 0, 'logSha256': sha(log),
           'compiledProductExecuted': False, 'nativeOrModelExecuted': False,
           'limits': ['VM/mock logical lifecycle and static C# constraints only; source-pattern tests are not actual Win32 proof.',
                      'Real ACL/read-only installation, alias rejection, authenticated home RPC and normal-close/handoff need independent execution.',
                      'Full product actual source/privacy/quality/performance, direct Node/fallback and final package qualification remain pending.']}
(OUT / 'root-review.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
print(json.dumps(receipt))
