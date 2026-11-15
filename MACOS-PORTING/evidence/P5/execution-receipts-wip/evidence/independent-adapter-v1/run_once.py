import sys,json,hashlib,subprocess,datetime,os,time
from pathlib import Path
root=Path('/tmp/ruyi-p5-receipts-evidence/independent-adapter-v1');freeze=Path('/tmp/ruyi-p5-receipts-evidence/adapter-freeze-v1.json');expected='91100237ca368b69e2cbd8508316cff6af4bf27e1cebb9054e47cf130deac899';work=Path('/tmp/ruyi-p5-execution-receipts-worktree');label=sys.argv[1]
commands={'journal':['/Users/jiming/Documents/ruyi-workbench-mac/mcp/ai-computer-control/.venv/bin/python','mcp/ai-computer-control/tests/smoke_execution_journal.py'],'adapter':['/Users/jiming/Documents/ruyi-workbench-mac/mcp/ai-computer-control/.venv/bin/python','mcp/ai-computer-control/tests/smoke_macos_receipt_session.py']}
env={'DYLD_FRAMEWORK_PATH':'/Users/jiming/.local/esp-runtimes','DYLD_LIBRARY_PATH':'/Users/jiming/.local/esp-runtimes/Python.framework/Versions/3.12/lib','PYTHONDONTWRITEBYTECODE':'1'}
if label=='adapter':env.update({'RUYI_RECEIPT_SESSION_REQUIRED':'1','RUYI_RECEIPT_SESSION_HELPER':'/tmp/ruyi-p5-receipts-helper','RUYI_RECEIPT_SESSION_LEGACY_HELPER':'/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/runtime/macos/ruyi-automation-helper'})
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def checkpoint(phase):
 raw=freeze.read_bytes();sha=hashlib.sha256(raw).hexdigest()
 if sha!=expected:raise RuntimeError('Freeze changed '+sha)
 x=json.loads(raw);rows=[]
 for kind in ['sources','artifacts']:
  for item in x[kind]:
   p=work/item['path'] if kind=='sources' else Path(item['path']);b=p.read_bytes();row={'path':item['path'],'kind':kind,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
   if kind=='sources':row['gitBlob']=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
   row['matched']=row['bytes']==item['bytes'] and row['sha256']==item['sha256'] and (kind!='sources' or row['gitBlob']==item['gitBlob']);rows.append(row)
 out={'at':now(),'freezeSha256':sha,'sources':len(x['sources']),'artifacts':len(x['artifacts']),'allMatched':all(r['matched'] for r in rows),'rows':rows};(root/(label+'-'+phase+'-binding.json')).write_text(json.dumps(out,indent=2)+'\n')
 if not out['allMatched']:raise RuntimeError('Mismatch '+str([r['path'] for r in rows if not r['matched']]))
if (root/(label+'-invocation.json')).exists():raise RuntimeError('No implicit rerun')
checkpoint('before');(root/'adapter-freeze-v1.json').write_bytes(freeze.read_bytes());inv={'label':label,'argv':commands[label],'cwd':str(work),'environmentOverrides':env,'startedAt':now(),'freezeSha256':expected,'attempt':1};(root/(label+'-invocation.json')).write_text(json.dumps(inv,indent=2)+'\n');print('START '+label,flush=True);start=time.monotonic()
with (root/(label+'.log')).open('wb') as output:r=subprocess.run(commands[label],cwd=work,env={**os.environ,**env},stdout=output,stderr=subprocess.STDOUT)
inv.update({'finishedAt':now(),'elapsedSeconds':time.monotonic()-start,'exitCode':r.returncode,'logSha256':hashlib.sha256((root/(label+'.log')).read_bytes()).hexdigest()});(root/(label+'-invocation.json')).write_text(json.dumps(inv,indent=2)+'\n');checkpoint('after');print('END '+label+' exit='+str(r.returncode),flush=True);print('\n'.join((root/(label+'.log')).read_text(errors='replace').splitlines()[-28:]),flush=True);sys.exit(r.returncode)
