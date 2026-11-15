import pathlib,json,hashlib,datetime,subprocess,tempfile,os,time,re,sys,traceback,math
assert sys.argv[1:]==['--authorized-gui'],'Await completed engineering and explicit GUI handoff'
R=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac');W=pathlib.Path('/tmp/ruyi-p5-transition-worktree');O=pathlib.Path(__file__).resolve().parent;E=O.parent;ENG=E/'development/engineering-v1';F=json.loads((E/'freeze-v3.json').read_text());P=json.loads((O/'preparation.json').read_text());PROCESS=W/'ruyi-workbench/runtime/macos/ruyi-process-helper';HELPER=pathlib.Path(F['artifacts'][0]['path']);NODE='/Users/jiming/.local/bin/node';checks=[];observed={};rootBirth=None;child=None;code=None;runtime=None;error=None;blocked=False;isolation=None;counts=None;remaining=None;remainingInner=None;signBefore=[];signAfter=[]
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def dg(p):
 b=pathlib.Path(p).read_bytes();return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def save(n,x):(O/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def check(label):
 files=[{'path':x['path'],**dg(W/x['path']),'expectedSha256':x['sha256']} for x in F['files']];arts=[{'path':x['path'],**dg(x['path']),'expectedSha256':x['sha256']} for x in F['artifacts']]
 for x in files+arts:x['matched']=x['sha256']==x['expectedSha256']
 okay=all(x['matched'] for x in files+arts) and all(dg(x['path'])=={'bytes':x['bytes'],'sha256':x['sha256']} for x in [P['freeze'],P['review']]) and all(dg(W/x['path'])=={'bytes':x['bytes'],'sha256':x['sha256']} for x in P['additionalSources'])
 checks.append({'label':label,'at':now(),'files':files,'artifacts':arts,'allMatched':okay});save('source-artifact-checks.json',checks);assert okay,'source/artifact/review drift'
def snapshot():
 p=subprocess.run([str(PROCESS),'--snapshot'],capture_output=True,text=True,check=True,timeout=8);assert p.stdout.startswith('RUYI-PROCESS-V1\n');rows=[]
 for line in p.stdout.splitlines()[1:]:
  a=line.split(',')
  if len(a)>=3:rows.append({'pid':int(a[0]),'ppid':int(a[1]),'created':int(a[2])})
 return rows
def sample():
 global rootBirth
 rows=snapshot();by={x['pid']:x for x in rows};root=by.get(child.pid)
 if root and rootBirth is None and root['ppid']==os.getpid() and child.poll() is None:rootBirth=root['created']
 if not root or root['created']!=rootBirth:return
 owned={child.pid};changed=True
 while changed:
  changed=False
  for x in rows:
   parent=by.get(x['ppid'])
   if x['pid'] not in owned and x['ppid'] in owned and parent and x['created']>=parent['created']:owned.add(x['pid']);changed=True
 after={x['pid']:x for x in snapshot()}
 for pid in owned:
  x=by[pid]
  if after.get(pid,{}).get('created')==x['created']:observed[(pid,x['created'])]=x
 save('observed-identities.json',list(observed.values()))
def signatures():
 rows=[]
 for path in [HELPER,PROCESS]:
  argv=['/usr/bin/codesign','--verify','--strict',str(path)];p=subprocess.run(argv,capture_output=True,text=True,timeout=10);rows.append({'argv':argv,'exitCode':p.returncode,'stdout':p.stdout,'stderr':p.stderr});assert p.returncode==0
 return rows
def validateRuntime():
 assert runtime['helperHash']==F['artifacts'][0]['sha256'] and runtime['retainedRoot'] is None,'helper identity/retention failure'
 captures={x['label']:x for x in runtime['captures']};moving=[captures['moving-'+str(i)] for i in range(8)];assert len([x for x in runtime['captures'] if re.fullmatch(r'moving-\d+',x['label'])])==8
 ready=next(x for x in runtime['reports'] if x['event']=='ready');start=next(x for x in runtime['reports'] if x['event']=='motion-start');stop=next(x for x in runtime['reports'] if x['event']=='motion-stop');assert ready['ok'] and start['ok'] and stop['ok'] and not stop['moving'] and stop['frame']['x']>ready['frame']['x']
 changed=0;successes=0;witnessed=0;states=[x for x in runtime['reports'] if x['event']=='state'];assert len(states)==8
 for index,x in enumerate(moving):
  assert x['signal'] is None and x['exitCode']==(0 if x['result']['ok'] else 1)
  tuples=set()
  for row in runtime['reports']:
   if row['event']=='motion-frame' and x['startedAt']<=row['wall_ms']<=x['endedAt'] and row.get('ok') and row['pid']==ready['pid'] and row['id']==ready['id']:
    v=tuple(row.get('frame',{}).get(k) for k in ['x','y','width','height'])
    if all(isinstance(a,(int,float)) and math.isfinite(a) for a in v):tuples.add(v)
  assert len(tuples)==x['observedFramesDuringRequest']
  if len(tuples)>=2:witnessed+=1
  if x['result']['ok']:
   successes+=1;assert x['patternMatches']==[True]*4 and x['fixtureBackingScale']==ready['backingScale'];assert dg(O/'native'/(x['label']+'.png'))['sha256']==x['pngSha256']
   r=x['result'];assert r['pid']==ready['pid'] and r['window_id']==ready['id'] and all(r['logical_bounds'][k]==ready['frame'][k] for k in ['y','width','height']);assert states[index]['ok'] and states[index]['backingScale']==ready['backingScale'] and start['frame']['x']<=r['logical_bounds']['x']<=states[index]['frame']['x']
  else:
   assert x['result']['code'] in ['window_changed','capture_failed'] and not x.get('pngSha256')
   if x['result']['code']=='window_changed' and len(tuples)>=2:changed+=1
 assert changed>=1 and witnessed>=1
 for label,actual in [('stable-before',ready),('stable-after',stop)]:
  x=captures[label];r=x['result'];assert r['ok'] and x['exitCode']==0 and x['signal'] is None and r['pid']==actual['pid'] and r['window_id']==actual['id'] and r['logical_bounds']==actual['frame'] and x['patternMatches']==[True]*4 and x['fixtureBackingScale']==actual['backingScale'];assert dg(O/'native'/(label+'.png'))['sha256']==x['pngSha256']
 summary=captures['motion-summary'];assert summary=={'label':'motion-summary','changedRefusalsWithWitness':changed,'requestsWithMotionWitness':witnessed,'movingSuccesses':successes};assert counts['pass']==18+successes and counts['fail']==counts['skip']==0
 assert len(runtime['observed'])>=12 and runtime['cleanups']==[],'missing owned root observations/forced cleanup'
 save('semantic-counts.json',{'movingRequests':8,'movingSuccesses':successes,'changedRefusalsWithWitness':changed,'requestsWithMotionWitness':witnessed,'expectedDynamicPass':18+successes,'actualCounts':counts})
try:
 check('initial');er=json.loads((ENG/'results.json').read_text());assert [x['label'] for x in er]==['syntax','build','unit','fast'] and all(x['exitCode']==0 for x in er),'engineering not complete/passed';ec=json.loads((ENG/'source-artifact-checks.json').read_text());assert len(ec)==8
 for stage in ec:
  assert len(stage['files'])==12 and len(stage['artifacts'])==2
  for x in stage['files']:assert x['matched'] and x['sha256']==next(f['sha256'] for f in F['files'] if f['path']==x['path'])==dg(W/x['path'])['sha256']
  for x in stage['artifacts']:assert x['matched'] and x['sha256']==dg(x['path'])['sha256']
 save('engineering-reuse.json',{'scope':'Primary engineering reused by exact hashes; no independent syntax/build/unit/fast rerun.','results':er,'checkpoints':len(ec),'evidence':[{'path':str(p),**dg(p)} for p in sorted(ENG.iterdir()) if p.is_file()]});signBefore=signatures();save('signatures.json',{'before':signBefore})
 isolation=pathlib.Path(tempfile.mkdtemp(dir='/tmp',prefix='p5ti-'));assert subprocess.run(['git','-C',str(isolation),'rev-parse','--show-toplevel'],capture_output=True).returncode==128
 vals={k:str(isolation/v) for k,v in [('HOME','h'),('USERPROFILE','u'),('APPDATA','a'),('LOCALAPPDATA','l'),('WCW_DATA_DIR','w'),('RUYI_HOME','r'),('WIN_CLAUDE_WORKBENCH_HOME','c'),('TMPDIR','t')]}
 for p in vals.values():pathlib.Path(p).mkdir()
 vals.update({'RUYI_REAL_HOME':'/Users/jiming','RUYI_P5_TRANSITION_REQUIRED':'1','RUYI_P5_TRANSITION_HELPER':str(HELPER),'RUYI_P5_TRANSITION_EVIDENCE':str(O/'native'),'PYTHONDONTWRITEBYTECODE':'1'});assert len(os.fsencode(vals['TMPDIR']))<32;env=os.environ.copy();env.pop('WCW_SESSION_ID',None);env.update(vals);log=O/'output.txt';assert not log.exists(),'refuse independent retry';check('native-before');began=time.monotonic()
 with log.open('wb') as f:
  child=subprocess.Popen([NODE,'dev-harness/macos-capture-transition.e2e.js'],cwd=W,env=env,stdout=f,stderr=subprocess.STDOUT);save('invocation.json',{'executor':'/root/p5_acceptance','at':now(),'pid':child.pid,'argv':child.args,'cwd':str(W),'environment':vals,'attempt':1})
  while child.poll() is None:
   sample()
   if time.monotonic()-began>600:blocked=True;raise TimeoutError('Fixture still running; preserve identities, no blind kill or retry')
   time.sleep(.2)
  code=child.wait()
 text=log.read_text();counts={k:len(re.findall('^'+k.upper()+' ',text,re.M)) for k in ['pass','fail','skip']};save('counts.json',counts);runtime=json.loads((O/'native/results.json').read_text());assert code==0 and counts['fail']==counts['skip']==0 and 'MACOS CAPTURE TRANSITION E2E: ALL PASS' in text;validateRuntime();check('native-after');signAfter=signatures();save('signatures.json',{'before':signBefore,'after':signAfter});check('final')
except BaseException as exc:
 error=repr(exc);traceback.print_exc()
 if child and child.poll() is None:blocked=True
finally:
 try:
  current=snapshot();remaining=[x for x in current if (x['pid'],x['created']) in observed];inside={(x['pid'],int(x['created'])) for x in runtime['observed']} if runtime else set();remainingInner=[x for x in current if (x['pid'],x['created']) in inside]
 except Exception as exc:error=(error or '')+' final snapshot '+repr(exc)
 passed=error is None and code==0 and runtime is not None and rootBirth is not None and remaining==remainingInner==[]
 save('report.json',{'schemaVersion':1,'executor':'/root/p5_acceptance','at':now(),'status':'passed_independent_transition_freeze_v3' if passed else 'blocked_independent_transition' if blocked else 'failed_independent_transition','freeze':P['freeze'],'sourceCount':12,'artifactCount':2,'counts':counts,'nativeInvocationCount':1 if child else 0,'exitCode':code,'error':error,'childStillRunning':bool(child and child.poll() is None),'observedOuterRootBirth':rootBirth,'observedOuterIdentities':len(observed),'remainingOuterObservedIdentities':remaining,'remainingInnerObservedIdentities':remainingInner,'GUIReleased':not blocked and remaining==remainingInner==[],'engineeringRerun':False,'scope':'Independent actual default1cc raw helper and owned-window capture transition with8 serial moving requests and exact static controls. Dynamic success origin is bounded, not instant-exact. No physical displays/scale change, App/provider/Workbench entry, keyboard/mouse/clipboard/TCC/lock or environment acceptance.','phaseStatus':'in_progress'});print(json.dumps({'passed':passed,'counts':counts,'exitCode':code,'error':error,'blocked':blocked}),flush=True)
if not passed:raise SystemExit(1)
