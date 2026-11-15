import pathlib,json,hashlib,datetime,subprocess,tempfile,os,time,re,sys,traceback
assert sys.argv[1:]==['--authorized-gui'],'Run only after explicit parent GUI handoff and completed engineering gates'
R=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac');W=pathlib.Path('/tmp/ruyi-p5-readiness-worktree');O=pathlib.Path(__file__).resolve().parent;E=O.parent;ENG=E/'development/engineering-v1';NODE='/Users/jiming/.local/bin/node';PYTHON=str(R/'mcp/ai-computer-control/.venv/bin/python');F=json.loads((E/'freeze-v5.json').read_text());P=json.loads((O/'preparation.json').read_text());PROCESS=W/'ruyi-workbench/runtime/macos/ruyi-process-helper';HELPER=pathlib.Path(F['nativeHelper']['path']);checks=[];observed={};rootBirth=None;child=None;exitCode=None;error=None;blocked=False;runtime=None;signatureBefore=[];signatureAfter=[];envvals={};base=None

def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def dg(p):
 b=pathlib.Path(p).read_bytes();return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def save(n,x):(O/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def check(label):
 rows=[{'path':f['path'],**dg(W/f['path']),'expectedSha256':f['sha256']} for f in F['files']]
 for row in rows:row['matched']=row['sha256']==row['expectedSha256']
 art=[{'path':f['path'],**dg(f['path']),'expectedSha256':f['sha256']} for f in P['runtimeArtifacts']]
 for row in art:row['matched']=row['sha256']==row['expectedSha256']
 refs=[P['freeze'],*P['reviews']]
 allGood=all(x['matched'] for x in rows+art) and all(dg(f['path'])=={'bytes':f['bytes'],'sha256':f['sha256']} for f in refs) and all(dg(W/f['path'])=={'bytes':f['bytes'],'sha256':f['sha256']} for f in P['additionalReviewedDependencies'])
 checks.append({'label':label,'at':now(),'files':rows,'artifacts':art,'reviewedDependenciesCount':len(P['additionalReviewedDependencies']),'allMatched':allGood});save('source-artifact-checks.json',checks);assert allGood,'source/artifact/review drift'
def snapshot():
 p=subprocess.run([str(PROCESS),'--snapshot'],capture_output=True,text=True,check=True,timeout=8);assert p.stdout.startswith('RUYI-PROCESS-V1\n');rows=[]
 for line in p.stdout.splitlines()[1:]:
  f=line.split(',')
  if len(f)>=3:rows.append({'pid':int(f[0]),'ppid':int(f[1]),'created':int(f[2])})
 return rows
def sample():
 global rootBirth
 rows=snapshot();by={r['pid']:r for r in rows};root=by.get(child.pid)
 if root and rootBirth is None and root['ppid']==os.getpid() and child.poll() is None:rootBirth=root['created']
 if not root or root['created']!=rootBirth:return
 owned={child.pid};changed=True
 while changed:
  changed=False
  for r in rows:
   parent=by.get(r['ppid'])
   if r['pid'] not in owned and r['ppid'] in owned and parent and r['created']>=parent['created']:owned.add(r['pid']);changed=True
 after={r['pid']:r for r in snapshot()}
 for pid in owned:
  r=by[pid]
  if after.get(pid,{}).get('created')==r['created']:observed[(pid,r['created'])]=r
 save('observed-identities.json',list(observed.values()))
def signatures():
 result=[]
 for path in [HELPER,PROCESS]:
  argv=['/usr/bin/codesign','--verify','--strict',str(path)];p=subprocess.run(argv,capture_output=True,text=True,timeout=10);result.append({'argv':argv,'exitCode':p.returncode,'stdout':p.stdout,'stderr':p.stderr});assert p.returncode==0
 return result
try:
 check('initial')
 er=json.loads((ENG/'results.json').read_text());assert [r['label'] for r in er]==['syntax','build','unit','fast'] and all(r['exitCode']==0 for r in er),'engineering not complete/passed'
 ec=json.loads((ENG/'source-artifact-checks.json').read_text());assert len(ec)==8 and [r['label'] for r in ec]==[x+'-'+y for x in ['syntax','build','unit','fast'] for y in ['before','after']]
 for row in ec:
  assert len(row['files'])==14 and len(row['artifacts'])==2
  for item in row['files']:
   expected=next(x for x in F['files'] if x['path']==item['path']);assert item['matched'] and item['sha256']==expected['sha256']==dg(W/item['path'])['sha256']
  for item in row['artifacts']:assert item['matched'] and item['sha256']==dg(item['path'])['sha256']
 save('engineering-reuse.json',{'scope':'Hash-bound reuse of primary engineering; no unit/static/build/syntax rerun by independent executor.','results':er,'sourceArtifactCheckpoints':len(ec),'evidence':[{'path':str(p),**dg(p)} for p in sorted(ENG.iterdir()) if p.is_file()]})
 signatureBefore=signatures();save('signatures.json',{'before':signatureBefore})
 base=pathlib.Path(tempfile.mkdtemp(dir='/tmp',prefix='p5ri-'));assert subprocess.run(['git','-C',str(base),'rev-parse','--show-toplevel'],capture_output=True).returncode==128
 envvals={k:str(base/v) for k,v in [('HOME','h'),('USERPROFILE','u'),('APPDATA','a'),('LOCALAPPDATA','l'),('WCW_DATA_DIR','w'),('RUYI_HOME','r'),('WIN_CLAUDE_WORKBENCH_HOME','c'),('TMPDIR','t')]}
 for p in envvals.values():pathlib.Path(p).mkdir()
 envvals.update({'RUYI_REAL_HOME':'/Users/jiming','RUYI_P5_READINESS_REQUIRED':'1','RUYI_P5_READINESS_HELPER':str(HELPER),'RUYI_P5_READINESS_EVIDENCE':str(O/'native'),'RUYI_ACC_PYTHON':PYTHON,'PYTHONPATH':str(W/'mcp/ai-computer-control/src'),'PYTHONDONTWRITEBYTECODE':'1','DYLD_FRAMEWORK_PATH':'/Users/jiming/.local/esp-runtimes','DYLD_LIBRARY_PATH':'/Users/jiming/.local/esp-runtimes/Python.framework/Versions/3.12/lib'})
 env=os.environ.copy();env.pop('WCW_SESSION_ID',None);env.update(envvals);log=O/'output.txt';assert not log.exists(),'refuse independent rerun';assert len(os.fsencode(envvals['TMPDIR']))<32
 check('native-before');started=now();start=time.monotonic()
 with log.open('wb') as f:
  child=subprocess.Popen([NODE,'dev-harness/macos-native-readiness.e2e.js'],cwd=W,env=env,stdout=f,stderr=subprocess.STDOUT)
  save('invocation.json',{'executor':'/root/p5_acceptance','argv':child.args,'pid':child.pid,'cwd':str(W),'environment':envvals,'at':started,'attempt':1,'policy':'First unexpected failure stops; no retry, no blind forced cleanup.'})
  while child.poll() is None:
   sample()
   if time.monotonic()-start>900:blocked=True;raise TimeoutError('Independent fixture still running; identities retained and no automatic kill/retry')
   time.sleep(.25)
  exitCode=child.wait()
 runtime=json.loads((O/'native/results.json').read_text());text=log.read_text();counts={'pass':len(re.findall(r'^PASS ',text,re.M)),'fail':len(re.findall(r'^FAIL ',text,re.M)),'skip':len(re.findall(r'^SKIP ',text,re.M))};save('counts.json',counts)
 assert exitCode==0 and counts=={'pass':40,'fail':0,'skip':0} and 'MACOS NATIVE READINESS E2E: ALL PASS' in text,'unexpected E2E result'
 assert runtime['cleanupSafe'] and runtime['retainedRoot'] is None and any(r.get('event')=='input-source-restore' and r.get('restored') for r in runtime['reports']),'native cleanup/source restore not confirmed'
 assert len(runtime['cleanups'])==5 and all(not r['receipt'].get('incomplete') and not r['receipt'].get('skipped') and r.get('observed') for r in runtime['cleanups']),'incomplete service cleanup receipt'
 check('native-after');signatureAfter=signatures();save('signatures.json',{'before':signatureBefore,'after':signatureAfter});check('final')
except BaseException as exc:
 error=repr(exc);traceback.print_exc()
 if child and child.poll() is None:blocked=True
finally:
 remaining=None
 try:remaining=[r for r in snapshot() if (r['pid'],r['created']) in observed]
 except Exception as exc:error=(error or '')+' final snapshot '+repr(exc)
 passed=error is None and exitCode==0 and runtime is not None and rootBirth is not None and remaining==[]
 save('report.json',{'schemaVersion':1,'executor':'/root/p5_acceptance','at':now(),'status':'passed_independent_readiness_freeze_v5' if passed else 'blocked_independent_readiness' if blocked else 'failed_independent_readiness','freeze':P['freeze'],'sourceCount':14,'runtimeArtifactCount':2,'additionalReviewedDependencies':len(P['additionalReviewedDependencies']),'engineeringRerun':False,'nativeInvocationCount':1 if child else 0,'exitCode':exitCode,'error':error,'childStillRunning':bool(child and child.poll() is None),'observedRootBirth':rootBirth,'observedIdentityCount':len(observed),'remainingObservedIdentities':remaining,'cleanupSafe':runtime.get('cleanupSafe') if runtime else None,'GUIReleased':not blocked and remaining==[],'temporaryIsolationRoot':str(base) if base else None,'scope':'Independent one-shot current-host ordinary provider readiness/catalog/registry/master-switch and actual controlled recording replay. Actual helper1cc; Node service launch. Generated CLI policy configuration read only, no CLI runtime or Node registry-removal claim. No real TCC revoke/lock/App/Windows/environment closure.','phaseStatus':'in_progress'})
 print(json.dumps({'passed':passed,'exitCode':exitCode,'error':error,'blocked':blocked}),flush=True)
if not passed:raise SystemExit(1)
