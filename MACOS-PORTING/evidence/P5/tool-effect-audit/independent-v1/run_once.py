import sys,json,hashlib,subprocess,datetime,os,time
from pathlib import Path
root=Path('/tmp/ruyi-p5-effect-evidence/independent-v1');freeze=Path('/tmp/ruyi-p5-effect-evidence/candidate-freeze.json');expected='6ce1cea8dc28266ea0874b453d7dbe147ebfbe4a15d81c8a56fd0aa9e1e1175e';work=Path('/tmp/ruyi-p5-effect-worktree');python='/Users/jiming/Documents/ruyi-workbench-mac/mcp/ai-computer-control/.venv/bin/python';helper='/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/runtime/macos/ruyi-automation-helper'
label=sys.argv[1]
loader={'DYLD_FRAMEWORK_PATH':'/Users/jiming/.local/esp-runtimes','DYLD_LIBRARY_PATH':'/Users/jiming/.local/esp-runtimes/Python.framework/Versions/3.12/lib','PYTHONDONTWRITEBYTECODE':'1'}
commands={'unit':['node','--test','dev-harness/unit/compound-effect-audit.test.js'],'python':[python,'mcp/ai-computer-control/tests/smoke_batch_invocation.py'],'offline':['node','dev-harness/compound-effect-audit.e2e.js'],'native':['node','dev-harness/macos-native-entry.e2e.js']}
envs={'unit':{},'python':{},'offline':{'RUYI_EFFECT_EVIDENCE':str(root/'offline')},'native':{'RUYI_P5_ENTRY_REQUIRED':'1','RUYI_P5_ENTRY_HELPER':helper,'RUYI_ACC_PYTHON':python,'RUYI_P5_ENTRY_EVIDENCE':str(root/'native')}}
commands['python-env-v2']=commands['python']
envs['python-env-v2']=loader
envs['native'].update(loader)
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def checkpoint(phase):
 b=freeze.read_bytes();sha=hashlib.sha256(b).hexdigest()
 if sha!=expected:raise RuntimeError('Freeze document changed '+sha)
 data=json.loads(b);rows=[]
 for kind in ['sources','artifacts']:
  for item in data[kind]:
   path=work/item['path'] if kind=='sources' else Path(item['path']);b=path.read_bytes();actual={'path':item['path'],'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'kind':kind,'realpath':str(path.resolve())}
   if kind=='sources':actual['gitBlob']=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
   actual['matches']=actual['bytes']==item['bytes'] and actual['sha256']==item['sha256'] and (kind!='sources' or actual['gitBlob']==item['gitBlob'])
   rows.append(actual)
 report={'at':now(),'freezeSha256':sha,'sourceCount':len(data['sources']),'artifactCount':len(data['artifacts']),'allMatched':all(r['matches'] for r in rows),'rows':rows}
 (root/(label+'-'+phase+'-binding.json')).write_text(json.dumps(report,indent=2)+'\n')
 if not report['allMatched']:raise RuntimeError('Source/artifact mismatch: '+str([r['path'] for r in rows if not r['matches']]))
 return report['allMatched']
if (root/(label+'-invocation.json')).exists():raise RuntimeError('Refusing repeat '+label)
checkpoint('before')
(root/'candidate-freeze.json').write_bytes(freeze.read_bytes())
inv={'label':label,'argv':commands[label],'cwd':str(work),'envOverrides':envs[label],'startedAt':now(),'freezeSha256':expected,'nodeVersion':subprocess.check_output(['node','--version'],text=True).strip(),'retry':label=='python-env-v2','priorAttempt':('python loader failure before test startup; parent verified loader correction' if label=='python-env-v2' else None)}
(root/(label+'-invocation.json')).write_text(json.dumps(inv,indent=2)+'\n');print('START '+label+' '+inv['startedAt'],flush=True)
start=time.monotonic()
with (root/(label+'.log')).open('wb') as output:
 result=subprocess.run(commands[label],cwd=work,env={**os.environ,**envs[label]},stdout=output,stderr=subprocess.STDOUT)
inv.update({'finishedAt':now(),'exitCode':result.returncode,'elapsedSeconds':time.monotonic()-start,'logSha256':hashlib.sha256((root/(label+'.log')).read_bytes()).hexdigest()})
(root/(label+'-invocation.json')).write_text(json.dumps(inv,indent=2)+'\n')
checkpoint('after');print('END '+label+' exit='+str(result.returncode)+' seconds='+str(round(inv['elapsedSeconds'],2)),flush=True)
lines=(root/(label+'.log')).read_text(errors='replace').splitlines();print('\n'.join(lines[-14:]),flush=True)
sys.exit(result.returncode)
