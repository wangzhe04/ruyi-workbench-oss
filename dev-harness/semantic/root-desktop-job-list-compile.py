"""Compile reviewed desktop variants into owned libraries; never load them."""
import hashlib
import json
import os
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/semantic-desktop-job-list-build-v1'
CANDIDATES = [
    ('semantic-desktop-bootstrap-owner-candidate-v1', '2e04e5a7a8160b227be9c39feb44a70370c2341e7db87f4f1ce61ea9230904f0'),
    ('semantic-desktop-job-list-candidate-v1', '6c4a241a559c39da385a1f76cf2422ca2c8ebaacb383cda1e07508e20f367d64'),
]

def sha(path):
    with pathlib.Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

contracts = []
def verify():
    for name, pin in CANDIDATES:
        directory = ROOT / 'output' / name
        assert sha(directory / 'freeze.json') == pin
        contract = json.loads((directory / 'freeze.json').read_text(encoding='utf-8'))
        for row in contract['bindings']:
            file = pathlib.Path(row['file'])
            assert file.stat().st_size == row['bytes'] and sha(file) == row['sha256'], file
        if not contracts:
            pass
verify()
OUT.mkdir()
home = OUT / 'home'
home.mkdir()
system_root = pathlib.Path(os.environ['SystemRoot'])
framework = system_root / 'Microsoft.NET/Framework64/v4.0.30319'
compiler = framework / 'csc.exe'
references = [framework / name for name in ['mscorlib.dll', 'System.dll', 'System.Core.dll',
              'System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll']]
toolchain = [compiler, compiler.with_name('csc.exe.config'), *references]
toolchain_pins = [{'file': str(p), 'bytes': p.stat().st_size, 'sha256': sha(p)} for p in toolchain]
(OUT / 'toolchain-pins.json').write_text(json.dumps(toolchain_pins, indent=2)+'\n', encoding='utf-8')
env = {'SystemRoot': str(system_root), 'WINDIR': str(system_root), 'PATH': str(system_root / 'System32'),
       'HOME': str(home), 'USERPROFILE': str(home), 'TEMP': str(home), 'TMP': str(home)}
node = pathlib.Path('C:/Program Files/nodejs/node.exe')
job = ROOT / 'output/semantic-desktop-job-list-candidate-v1'
test = subprocess.run([str(node), '--test', '--test-concurrency=1', '--test-reporter=tap',
                       str(job / 'owner-races.test.cjs'), str(job / 'job-list.test.cjs')],
                      cwd=ROOT, env=env, capture_output=True, timeout=30)
(OUT / 'root-native-free-tests.log').write_bytes(test.stdout+test.stderr)
assert test.returncode == 0 and b'# pass 17' in test.stdout and b'# fail 0' in test.stdout
variants = [('baseline', ROOT / 'output/semantic-desktop-bootstrap-owner-candidate-v1/baseline'),
            ('owner-waiter', ROOT / 'output/semantic-desktop-bootstrap-owner-candidate-v1/candidate'),
            ('job-list', job / 'candidate')]
results = []
for name, source in variants:
    destination = OUT / (name + '.dll')
    command = [str(compiler), '/nologo', '/noconfig', '/nostdlib+', '/target:library', '/platform:x64',
               '/optimize+', '/codepage:65001', '/out:'+str(destination)]
    command += ['/reference:'+str(file) for file in references]
    command += [str(source / 'RuyiDesktop.cs'), str(source / 'DesktopLifetimeHost.cs')]
    process = subprocess.run(command, cwd=OUT, env=env, capture_output=True, timeout=60)
    (OUT / (name+'.compiler.log')).write_bytes(process.stdout+process.stderr)
    results.append({'variant': name, 'exitCode': process.returncode,
                    'compilerLogSha256': sha(OUT / (name+'.compiler.log')),
                    'outputBytes': destination.stat().st_size if destination.exists() else None,
                    'outputSha256': sha(destination) if destination.exists() else None})
    (OUT / 'compile-results.json').write_text(json.dumps(results, indent=2)+'\n', encoding='utf-8')
    assert process.returncode == 0, (process.stdout+process.stderr).decode('utf-8', errors='replace')
verify()
for row in toolchain_pins:
    assert sha(row['file']) == row['sha256']
receipt = {'status': 'ROOT_DESKTOP_BASELINE_WAITER_JOBLIST_COMPILE_ONLY_PASS',
           'sourceFreezes': [{'name': name, 'sha256': pin} for name, pin in CANDIDATES],
           'nativeFreeModelAndStaticPass': 17, 'compilerSha256': sha(compiler),
           'toolchainPinsSha256': sha(OUT / 'toolchain-pins.json'), 'results': results,
           'targetLibrariesLoadedOrExecuted': False, 'liveDesktopModified': False,
           'limitations': ['Compile-only; no Win32 process or Job-list/handoff/crash guarantee established.',
                           'No visible desktop or Computer Use test executed.',
                           'Direct Node/fallback launch, actual native matrix and clean supported Windows remain open.']}
(OUT / 'root-review.json').write_text(json.dumps(receipt, indent=2)+'\n', encoding='utf-8')
print(json.dumps(receipt))
