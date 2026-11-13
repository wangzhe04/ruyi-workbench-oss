import sys,json,hashlib,subprocess,datetime,os,time,shlex,shutil,platform,tempfile
from pathlib import Path
root=Path('/tmp/ruyi-p5-receipts-evidence/independent-root-dispatch-v1');freeze=Path('/tmp/ruyi-p5-receipts-evidence/root-dispatch-freeze-v1.json');expected='ed4178309b78e119e4428a34dc05e179411def97e74b6a8d77916abc706334bc';work=Path('/tmp/ruyi-p5-execution-receipts-worktree');helper=work/'ruyi-workbench/runtime/macos/ruyi-process-helper';label=sys.argv[1];labels=['unit','python-control','dispatch','context','module-graph','routes','durable','build'];index=labels.index(label)
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def info(p):
 b=p.read_bytes();return {'path':str(p),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
initial=root/'os-process-helper-baseline.json'
if not initial.exists():initial.write_text(json.dumps(info(helper),indent=2)+'\n')
def checkpoint(phase):
 raw=freeze.read_bytes();sha=hashlib.sha256(raw).hexdigest()
 if sha!=expected:raise RuntimeError('Freeze changed '+sha)
 x=json.loads(raw);rows=[]
 for item in x['sources']:
  p=work/item['path'];b=p.read_bytes();row={'path':item['path'],'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'gitBlob':hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()};row['matched']=all(row[k]==item[k] for k in ['bytes','sha256','gitBlob']);rows.append(row)
 arts=[{**info(Path(a['path'])),'matched':info(Path(a['path']))==a} for a in x['artifacts']];h=info(helper);hm=h==json.loads(initial.read_text());out={'at':now(),'freezeSha256':sha,'sourceCount':len(rows),'allMatched':all(r['matched'] for r in rows),'rows':rows,'additionalActualOSProcessHelper':h,'osProcessHelperMatchesBaseline':hm,'artifacts':arts,'allArtifactsMatched':all(a['matched'] for a in arts)};(root/(label+'-'+phase+'-binding.json')).write_text(json.dumps(out,indent=2)+'\n')
 if not out['allMatched'] or not hm or not out['allArtifactsMatched']:raise RuntimeError('Source/helper mismatch')
 return x
if (root/(label+'-invocation.json')).exists():raise RuntimeError('No implicit repeat')
x=checkpoint('before');(root/'root-dispatch-freeze-v1.json').write_bytes(freeze.read_bytes())
iso=Path(tempfile.mkdtemp(prefix='rd-',dir='/tmp'));env={}
for key,sub in {'HOME':'home','USERPROFILE':'userprofile','APPDATA':'appdata','LOCALAPPDATA':'localappdata','RUYI_HOME':'data','WIN_CLAUDE_WORKBENCH_HOME':'data','WCW_DATA_DIR':'acc-data','TMPDIR':'tmp','XDG_CONFIG_HOME':'xdg-config','XDG_CACHE_HOME':'xdg-cache'}.items():
 p=iso/sub;p.mkdir(parents=True,exist_ok=True);env[key]=str(p)
env.update({'RUYI_REAL_HOME':'/Users/jiming','PYTHONDONTWRITEBYTECODE':'1','DYLD_FRAMEWORK_PATH':'/Users/jiming/.local/esp-runtimes','DYLD_LIBRARY_PATH':'/Users/jiming/.local/esp-runtimes/Python.framework/Versions/3.12/lib'})
python='/Users/jiming/Documents/ruyi-workbench-mac/mcp/ai-computer-control/.venv/bin/python'
if label in ['dispatch','context']:env.update({'RUYI_EXECUTION_CONTEXT_HELPER':'/tmp/ruyi-p5-receipts-helper','RUYI_ACC_PYTHON':python})
if label=='dispatch':env.update({'RUYI_EXECUTION_DISPATCH_REQUIRED':'1','RUYI_EXECUTION_DISPATCH_EVIDENCE':str(root/'dispatch-results.json')})
if label=='context':env.update({'RUYI_EXECUTION_CONTEXT_REQUIRED':'1','RUYI_EXECUTION_CONTEXT_EVIDENCE':str(root/'context')})
versions=json.loads((root/'runtime-versions.json').read_text())
(root/'runtime-versions.json').write_text(json.dumps(versions,indent=2)+'\n');tests=x['tests'];commands={'unit':tests['node'],'python-control':[python,tests['pythonControl']],'dispatch':['node',tests['actualDispatch']],'context':['node',tests['actualRequiredContext']],'module-graph':['node',tests['module']],'routes':['node',tests['route']],'durable':['node',*tests['durable']],'build':['node',*tests['build']]};cmd=commands[label];inv={'label':label,'argv':cmd,'cwd':str(work),'environmentOverrides':env,'startedAt':now(),'freezeSha256':expected,'attempt':1,'runtimeVersions':versions};(root/(label+'-invocation.json')).write_text(json.dumps(inv,indent=2)+'\n');print('START '+label,flush=True)
def snapshot():
 r=subprocess.run([str(helper),'--snapshot'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
 if r.returncode!=0 or not r.stdout.startswith(b'RUYI-PROCESS-V1\n'):raise RuntimeError('OS process snapshot unavailable')
 rows=[]
 for line in r.stdout.decode().splitlines()[1:]:
  fields=line.split(',')
  if len(fields)>=3 and all(v.isdigit() for v in fields[:3]):rows.append({'pid':int(fields[0]),'ppid':int(fields[1]),'created':fields[2]})
 return rows
observed={};start=time.monotonic()
with (root/(label+'.log')).open('wb') as output:
 child=subprocess.Popen(cmd,cwd=work,env={**os.environ,**env},stdout=output,stderr=subprocess.STDOUT)
 while True:
  rows=snapshot();own={r['pid']:r for r in rows if r['pid']==child.pid or (r['pid'],r['created']) in observed};changed=True
  while changed:
   changed=False
   for r in rows:
    p=own.get(r['ppid'])
    if p and int(r['created'])>=int(p['created']) and r['pid'] not in own:own[r['pid']]=r;changed=True
  for r in own.values():observed[(r['pid'],r['created'])]=r
  if child.poll() is not None:break
  time.sleep(.04)
 code=child.wait()
remaining=[]
for attempt in range(30):
 table=snapshot();remaining=[r for r in table if (r['pid'],r['created']) in observed]
 if not remaining:break
 time.sleep(.05)
cleanup={'at':now(),'rootPid':child.pid,'observedIdentities':list(observed.values()),'allObservedIdentitiesExited':not remaining,'remaining':remaining,'scope':'Only this test root and birth-checked observed descendants; not global/escaped process completeness. OS snapshots are additional read-only observation, not desktop native calls.'};(root/(label+'-cleanup.json')).write_text(json.dumps(cleanup,indent=2)+'\n')
inv.update({'finishedAt':now(),'elapsedSeconds':time.monotonic()-start,'exitCode':code,'log':info(root/(label+'.log'))});(root/(label+'-invocation.json')).write_text(json.dumps(inv,indent=2)+'\n');checkpoint('after');print('END '+label+' exit='+str(code)+' observed='+str(len(observed))+' allExited='+str(not remaining),flush=True);print('\n'.join((root/(label+'.log')).read_text(errors='replace').splitlines()[-16:]),flush=True)
if remaining:raise RuntimeError('Owned observed process remains; stop and review cleanup')
isolation={'root':str(iso),'ownedShortTempIsolation':True,'outerDirectoryRetainedForEvidence':True,'allObservedIdentitiesExited':not remaining};(root/(label+'-isolation-cleanup.json')).write_text(json.dumps(isolation,indent=2)+'\n');sys.exit(code)
