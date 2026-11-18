"""Root compile-only gate for the no-GUI early lease process probe."""
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'output/semantic-resident-home-service-candidate-v2'
OUT = ROOT / 'output/semantic-resident-home-service-build-v2'
PIN = '1c56c2072752e06be34fb9253675b72d4ed38e866b8a1a9c2cc72df8629627ad'

def sha(path):
    with pathlib.Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

assert sha(SOURCE / 'freeze.json') == PIN
contract = json.loads((SOURCE / 'freeze.json').read_text(encoding='utf-8'))
assert len(contract['bindings']) == 61
def verify():
    for row in contract['bindings']:
        file = pathlib.Path(row['file'])
        assert 'acceptance' not in str(file).lower()
        assert file.stat().st_size == row['bytes'] and sha(file) == row['sha256'], file
verify()
plan = json.loads((SOURCE / 'compile-plan.json').read_text(encoding='utf-8'))
assert plan['arguments'] == ['/nologo', '/noconfig', '/nostdlib+', '/target:exe', '/platform:x64',
                             '/optimize+', '/codepage:65001', '/main:RuyiDesktop.DesktopLifecycleProbe']
assert len(plan['sources']) == 4
assert sha(SOURCE / 'compile-plan.json') == 'd232cfdba4ae90a03cf514c17cf0dac23c8fbb9deb758b275af0e9dc65836c04'
assert len(plan['references']) == 6
for row in [*plan['sources'], *plan['references'], plan['compiler']]:
    assert pathlib.Path(row['file']).stat().st_size == row['bytes'] and sha(row['file']) == row['sha256']
compiler = pathlib.Path(plan['compiler']['file']).resolve()
assert sha(compiler) == '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00'
windows = compiler.parents[3]
assert windows.name.lower() == 'windows' and windows.anchor.endswith('\\')
OUT.mkdir()
(OUT / 'OWNER.json').write_text('{"owner":"root-desktop-early-lease-compile","compileOnly":true}\n', encoding='utf-8')
home = OUT / 'home'
for child in ['tmp', 'local', 'roaming']:
    (home / child).mkdir(parents=True, exist_ok=True)
env = {'SystemRoot': str(windows), 'WINDIR': str(windows), 'SystemDrive': windows.anchor[:-1],
       'PATH': str(windows / 'System32'), 'HOME': str(home), 'USERPROFILE': str(home),
       'APPDATA': str(home / 'roaming'), 'LOCALAPPDATA': str(home / 'local'),
       'TEMP': str(home / 'tmp'), 'TMP': str(home / 'tmp')}
output = OUT / 'DesktopLifecycleProbe.exe'
command = [str(compiler), *plan['arguments'], '/out:'+str(output)]
command += ['/reference:'+row['file'] for row in plan['references']]
command += [row['file'] for row in plan['sources']]
result = subprocess.run(command, cwd=OUT, env=env, capture_output=True, timeout=60)
(OUT / 'compiler.log').write_bytes(result.stdout+result.stderr)
attempt = {'exitCode': result.returncode, 'compilerLogSha256': sha(OUT / 'compiler.log')}
(OUT / 'compile-attempt.json').write_text(json.dumps(attempt, indent=2)+'\n', encoding='utf-8')
assert result.returncode == 0, (result.stdout+result.stderr).decode('utf-8', errors='replace')
verify()
receipt = {'status': 'ROOT_RESIDENT_HOME_NO_GUI_PROBE_COMPILE_ONLY_PASS',
           'sourceFreezeSha256': PIN, 'bindingsVerifiedBeforeAndAfter': 61, 'implementerNativeFree65NotYetRootReviewed': True,
           'compiler': plan['compiler'], 'arguments': plan['arguments'],
           'output': {'file': str(output), 'bytes': output.stat().st_size, 'sha256': sha(output)},
           'compilerExitCode': 0, 'compiledOutputExecuted': False, 'guiStarted': False,
           'environment': 'SystemRoot/WINDIR/SystemDrive derived from pinned OS compiler root; all writable homes owned.',
           'limits': ['Compile-only; source contract is not a native run contract.',
                      'Actual kill, independent identity observation, causality and natural outer drain require separately frozen controller and compiled byte bindings.']}
(OUT / 'root-review.json').write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
print(json.dumps(receipt))
