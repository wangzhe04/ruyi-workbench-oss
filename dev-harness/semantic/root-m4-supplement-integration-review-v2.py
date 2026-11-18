"""Review and exercise source preparation only; never build a product ZIP."""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
CANDIDATE = ROOT / 'output/m4-source-preparation-integration-candidate-20261118-r2'
OUT = ROOT / 'output/m4-source-preparation-root-20261118-r2'

def sha(path):
    with pathlib.Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

freeze = CANDIDATE / 'freeze.json'
assert sha(freeze) == '7426131c00c7fa11a9d06b3cbd49fb6fb52375077fbaa79bb63842ec14a6884f'
f = json.loads(freeze.read_text(encoding='utf-8'))

def verify():
    for row in f['bindings']:
        path = pathlib.Path(row['path'])
        assert path.stat().st_size == row['bytes'] and sha(path) == row['sha256'], path

verify()
OUT.mkdir()
(OUT / 'OWNER.json').write_text('{"owner":"root-m4-source-preparation","synthetic":true}\n', encoding='utf-8')
tools = OUT / 'overlay/ruyi-workbench/tools'
tools.mkdir(parents=True)
for old, new in [('prepare-full-local-media-sources.candidate.ps1', 'prepare-full-local-media-sources.ps1'),
                 ('package-offline.candidate.ps1', 'package-offline.ps1'),
                 ('validate-openh264-supplement.py', 'validate-openh264-supplement.py'),
                 ('invoke-supplement-validator.ps1', 'invoke-supplement-validator.ps1'),
                 ('openh264-supplement.lock.json', 'openh264-supplement.lock.json')]:
    shutil.copyfile(CANDIDATE / old, tools / new)
shutil.copyfile(ROOT / 'ruyi-workbench/tools/media-runtime-sources-local-full.json', tools / 'media-runtime-sources-local-full.json')
home = OUT / 'home'
home.mkdir()
system = pathlib.Path(os.environ['SystemRoot']) / 'System32'
powershell = system / 'WindowsPowerShell/v1.0/powershell.exe'
env = {'SystemRoot': str(system.parent), 'WINDIR': str(system.parent), 'PATH': str(system),
       'HOME': str(home), 'USERPROFILE': str(home), 'TEMP': str(home), 'TMP': str(home),
       'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1'}
unit = subprocess.run([sys.executable, '-B', str(CANDIDATE / 'test.py')], cwd=ROOT, env=env, capture_output=True)
(OUT / 'root-unit.log').write_bytes(unit.stdout + unit.stderr)
assert unit.returncode == 0
source = pathlib.Path('C:/r31-1109/m4-source-v2-local-45a725a7')
supplement = ROOT / 'output/m4-openh264-header-supplement-20261118-r1'
destination = OUT / 'prepared-sources'
command = [str(powershell), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
           '-File', str(tools / 'prepare-full-local-media-sources.ps1'),
           '-SourceRoot', str(source), '-Destination', str(destination),
           '-SupplementRoot', str(supplement), '-BuildPython', sys.executable]
prepare = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, timeout=60)
(OUT / 'root-prepare.log').write_bytes(prepare.stdout + prepare.stderr)
assert prepare.returncode == 0, (prepare.stdout + prepare.stderr).decode('utf-8', errors='replace')
expected = ['opencv-windows-ffmpeg-sources-v2-local.zip', 'opencv_python_headless-5.0.0.93.tar.gz',
            'openh264-headers-v2.5.0-supplement.tar.xz', 'openh264-supplement.lock.json']
assert sorted(p.name for p in destination.iterdir()) == sorted(expected)
lock = json.loads((tools / 'media-runtime-sources-local-full.json').read_text(encoding='utf-8'))
for row in lock['artifacts']:
    p = destination / row['path']
    assert p.stat().st_size == row['bytes'] and sha(p) == row['sha256']
assert sha(destination / expected[2]) == '4b2544085f7b545997c77c411948fbed921107b6eedb6c7c83bec66be7cab7c3'
assert sha(destination / expected[3]) == sha(tools / expected[3])
verify()
result = {'status': 'ROOT_FULL_LOCAL_SOURCE_PREPARATION_SCOPED_PASS',
          'freezeSha256': sha(freeze), 'bindings': len(f['bindings']), 'pythonUnitPass': 8,
          'powershellPreparationExitCode': prepare.returncode,
          'deliveredFiles': [{'name': name, 'bytes': (destination / name).stat().st_size,
                              'sha256': sha(destination / name)} for name in expected],
          'limitations': ['Owned preparation overlay only; production tools not modified by this test.',
                          'Package script inspected; full package execution, final ZIP coverage and source/relink qualification remain pending.',
                          'Known empty legacy inner header archive is explicitly retained and separately supplemented; not relabeled complete.',
                          'No native/media execution, actual binary source-build attestation or public release approval.']}
(OUT / 'root-review.json').write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
print(json.dumps(result))
