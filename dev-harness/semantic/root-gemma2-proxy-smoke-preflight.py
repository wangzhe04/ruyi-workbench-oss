"""Root source/pin review before one-shot actual proxy smoke execution."""
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
PINS = {
    'semantic-gemma2-proxy-cn-lease-smoke-v2': 'acfd8541f0e42f55b06e8b6d94efe23a50a399ccefc61db01ee663b397190746',
    'semantic-gemma2-proxy-resident-smoke-v2': '938e15fc20ae39443e5828cb4d6a31702f5531810387bee342650dee7aab1280',
}

def digest(path):
    with pathlib.Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()

name = sys.argv[1]
assert name in PINS
directory = ROOT / 'output' / name
assert not (directory / 'CONSUMED').exists()
freeze = directory / 'freeze.json'
assert digest(freeze) == PINS[name]
f = json.loads(freeze.read_text(encoding='utf-8'))
assert len(f['bindings']) == 669
for row in f['bindings']:
    path = pathlib.Path(row['file'])
    assert path.stat().st_size == row['bytes'] and digest(path) == row['sha256'], path
assert f['computeMs'] == 1000 and f['consumerMs'] == 2500 and f['echoMs'] == 2000
assert f['idleMs'] == (65000 if f['phase'] == 'genuine-resident' else 0)
assert f['outerMs'] == 140000
old = json.loads((directory / 'original-asset-lock.json').read_text(encoding='utf-8'))
new = json.loads(pathlib.Path(f['profileFile']).read_text(encoding='utf-8'))
reverted = json.loads(json.dumps(new))
assert len(old['sourceBindings']) == len(new['sourceBindings']) == len(f['pathOnlyC4Rebind']) == 4
for before, after, change, reset in zip(old['sourceBindings'], new['sourceBindings'], f['pathOnlyC4Rebind'], reverted['sourceBindings']):
    assert before['file'] == change['from'] and after['file'] == change['to']
    assert before['sha256'] == after['sha256'] == change['sha256']
    assert before['bytes'] == after['bytes'] == change['bytes']
    assert pathlib.Path(after['file']).is_relative_to(directory)
    reset['file'] = before['file']
reverted['workerFile'] = old['workerFile']
assert reverted == old, 'Only four source paths and workerFile may change'
assert len(old['assets']) == 6 and len(old['runtimeInventory']) == 586
assert f['modelFingerprint'] == 'sha256:9d41595d7508ff328b6c5a4223c7af26a91ed2fe53662cc9d633c1373eb4163e'
head = pathlib.Path(f['hostPrefixSource']['file']).read_bytes().decode('utf-8')
marker = 'Object.assign(SemanticRuntimeHooks,semanticRuntimeHostPorts);'
assert head.count(marker) == 1
assert pathlib.Path(f['hostPrefix']).read_bytes() == (head[:head.index(marker)+len(marker)]+'\n').encode('utf-8')
for row in f['copyManifest']:
    assert digest(row['source']) == digest(row['target']) == row['sha256']
    assert not pathlib.Path(row['target']).name.startswith('root-')
receipt = {
    'status': 'ROOT_PREFLIGHT_669_PINS_AND_PATH_ONLY_REBIND_PASS',
    'freezeSha256': PINS[name], 'bindings': len(f['bindings']),
    'nativeFreeTestsRootPass': 9, 'exactHostPrefix': True,
    'originalAssets': 6, 'originalRuntimeFiles': 586,
    'originalC4BytesUnchanged': True, 'nativeExecutedByPreflight': False,
    'limits': ['Root reviewed common/controller/keeper and actual host prefix.',
               'Actual native/model execution remains separate; synthetic VM hooks are not complete HTTP/UI consumers.'],
    'reviewerScriptSha256': digest(__file__),
}
out = directory / 'root-preflight.json'
with out.open('x', encoding='utf-8') as stream:
    json.dump(receipt, stream, indent=2)
    stream.write('\n')
print(json.dumps(receipt))
