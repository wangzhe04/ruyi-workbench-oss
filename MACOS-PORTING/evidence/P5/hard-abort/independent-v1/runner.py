import pathlib,json,hashlib,datetime,subprocess,tempfile,os,time,re,traceback
R=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac');W=pathlib.Path('/tmp/ruyi-p5-hard-abort-worktree');O=pathlib.Path(__file__).resolve().parent;E=O.parent;F=json.loads((E/'freeze-v4.json').read_text());F3=json.loads((E/'freeze-v3.json').read_text());P=json.loads((O/'preflight.json').read_text());PROCESS=W/'ruyi-workbench/runtime/macos/ruyi-process-helper';NODE='/Users/jiming/.local/bin/node';checks=[];seen={};rootBirth=None;child=None;exitCode=None;runtime=None;error=None;blocked=False;remaining=None;remainingRecorded=None;counts=None;beforeSign=[];afterSign=[]
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def dg(p):
 b=pathlib.Path(p).read_bytes();return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def save(n,x):(O/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def check(label):
 rows=[{'path':x['path'],**dg(W/x['path']),'expectedSha256':x['sha256']} for x in F['sources']];arts=[{'path':x['path'],**dg(x['path']),'expectedSha256':x['sha256']} for x in F['artifacts']]
 for x in rows+arts:x['matched']=x['sha256']==x['expectedSha256']
 okay=all(x['matched'] for x in rows+arts) and all(dg(x['path'])=={'bytes':x['bytes'],'sha256':x['sha256']} for x in [P['freeze'],*P['reviews']]);checks.append({'label':label,'at':now(),'sources':rows,'artifacts':arts,'allMatched':okay});save('source-artifact-checks.json',checks);assert okay,'source/artifact/review drift'
def table():
 p=subprocess.run([str(PROCESS),'--snapshot'],capture_output=True,text=True,check=True,timeout=8);assert p.stdout.startswith('RUYI-PROCESS-V1\n');rows=[]
 for line in p.stdout.splitlines()[1:]:
  x=line.split(',')
  if len(x)>=3:rows.append({'pid':int(x[0]),'ppid':int(x[1]),'created':int(x[2])})
 return rows
def sample():
 global rootBirth
 rows=table();by={x['pid']:x for x in rows};root=by.get(child.pid)
 if root and rootBirth is None and root['ppid']==os.getpid() and child.poll() is None:rootBirth=root['created']
 if not root or root['created']!=rootBirth:return
 own={child.pid};changed=True
 while changed:
  changed=False
  for x in rows:
   parent=by.get(x['ppid'])
   if x['pid'] not in own and x['ppid'] in own and parent and x['created']>=parent['created']:own.add(x['pid']);changed=True
 after={x['pid']:x for x in table()}
 for pid in own:
  x=by[pid]
  if after.get(pid,{}).get('created')==x['created']:seen[(pid,x['created'])]=x
 save('observed-identities.json',list(seen.values()))
def signatures():
 rows=[]
 for x in F['artifacts']:
  argv=['/usr/bin/codesign','--verify','--strict',x['path']];p=subprocess.run(argv,capture_output=True,text=True,timeout=10);rows.append({'argv':argv,'exitCode':p.returncode,'stdout':p.stdout,'stderr':p.stderr});assert p.returncode==0
 return rows
def reuse():
 result=[]
 for name,freeze,expected,passed in [('engineering-v1',F3,['syntax','build','unit','fast'],[0,0,0,1]),('engineering-v2',F,['fast'],[0])]:
  base=E/'development'/name;execution=json.loads((base/'execution.json').read_text());assert [x['name'] for x in execution]==expected and [x['exitCode'] for x in execution]==passed
  snapshots=json.loads((base/'source-artifact-checks.json').read_text());assert len(snapshots)==(8 if name=='engineering-v1' else 2)
  for ck in snapshots:
   assert ck['sources']==freeze['sources'] and ck['artifacts']==freeze['artifacts']
  result.append({'name':name,'execution':execution,'hashCheckpoints':len(snapshots),'sourceCount':len(freeze['sources']),'artifactCount':2,'files':[{'path':str(p),**dg(p)} for p in sorted(base.iterdir()) if p.is_file()]})
 save('engineering-reuse.json',{'independentEngineeringReruns':0,'runs':result,'history':'Primary fast v1 failed route coverage metadata79/80, with built-in retry. Only generated inventories were refreshed; v2 fast reran including its own unit preflight and passed80/80. Prior syntax/build/unit reuse is bound to unchanged37 source inputs. No overall zero-rerun claim.'})
def validate():
 assert counts=={'pass':12,'fail':0,'skip':0} and runtime['failures']==0 and not runtime.get('failure') and runtime['retainedRoot'] is None and runtime['archiveErrors']==[]
 assert runtime['spec']['args']['steps']==[{'tool':'wait','args':{'seconds':30}}]
 assert runtime['helperSha256']==runtime['finalHelperSha256']==F['artifacts'][0]['sha256']
 fault=runtime['fault'];assert fault['injectedSignal']=='SIGKILL' and fault['scope']=='root-only' and fault['signalCode']=='SIGKILL' and fault['exitCode'] is None and 0<=fault['elapsedMs']<15000
 assert len(fault['topology'])==5 and not any(x.get('externalIntervention') for x in runtime['cleanups'])
 for row in runtime['observations']+runtime['reports']:
  if row.get('event') not in ('ready','state'):continue
  assert row['downs']==row['ups']==row['otherInput']==0 and row['receipts']==[] and not any(row[k] for k in ['hidLeft','combinedLeft','hidModifiers','combinedModifiers'])
 assert runtime['restart']['view']['status']==200 and runtime['restart']['view']['json']['execution'] is None and runtime['restart']['view']['json']['resumable'].get('live') is not True and runtime['restart']['providerCountBefore']==runtime['restart']['providerCountAfter']
 assert all(x.get('closedAt') and not x.get('archiveError') for x in runtime['serviceOutput'])
 for snap in runtime['snapshots']:
  assert snap['nonAtomicCrossFileSnapshot'] is True
  for f in snap['files']:assert dg(O/'native'/snap['label']/f['path'])=={'bytes':f['bytes'],'sha256':f['sha256']}
try:
 check('initial');reuse();beforeSign=signatures();save('signatures.json',{'before':beforeSign});base=pathlib.Path(tempfile.mkdtemp(dir='/tmp',prefix='p5hi-'));assert subprocess.run(['git','-C',str(base),'rev-parse','--show-toplevel'],capture_output=True).returncode==128
 vals={k:str(base/v) for k,v in [('HOME','h'),('USERPROFILE','u'),('APPDATA','a'),('LOCALAPPDATA','l'),('WCW_DATA_DIR','w'),('RUYI_HOME','r'),('WIN_CLAUDE_WORKBENCH_HOME','c'),('TMPDIR','t')]}
 for x in vals.values():pathlib.Path(x).mkdir()
 vals.update({'RUYI_REAL_HOME':'/Users/jiming','RUYI_P5_ABORT_REQUIRED':'1','RUYI_P5_ABORT_HELPER':F['artifacts'][0]['path'],'RUYI_P5_ABORT_EVIDENCE':str(O/'native'),'RUYI_ACC_PYTHON':str(R/'mcp/ai-computer-control/.venv/bin/python'),'DYLD_FRAMEWORK_PATH':'/Users/jiming/.local/esp-runtimes','DYLD_LIBRARY_PATH':'/Users/jiming/.local/esp-runtimes/Python.framework/Versions/3.12/lib','PYTHONPATH':str(W/'mcp/ai-computer-control/src'),'PYTHONDONTWRITEBYTECODE':'1'});assert len(os.fsencode(vals['TMPDIR']))<32;env=os.environ.copy();env.pop('WCW_SESSION_ID',None);env.update(vals);log=O/'output.txt';assert not log.exists(),'refuse calibration retry';check('native-before');start=time.monotonic()
 with log.open('wb') as f:
  child=subprocess.Popen([NODE,'dev-harness/macos-neutral-abort.e2e.js'],cwd=W,env=env,stdout=f,stderr=subprocess.STDOUT);save('invocation.json',{'executor':'/root/p5_acceptance','at':now(),'pid':child.pid,'argv':child.args,'cwd':str(W),'environment':vals,'attempt':1,'scope':P['claim']})
  while child.poll() is None:
   sample()
   if time.monotonic()-start>600:blocked=True;raise TimeoutError('Calibration still running; no extra-root kill or automatic retry')
   time.sleep(.15)
  exitCode=child.wait()
 text=log.read_text();counts={k:len(re.findall('^'+k.upper()+' ',text,re.M)) for k in ['pass','fail','skip']};save('counts.json',counts);assert exitCode==0 and 'MACOS NEUTRAL ABORT E2E: ALL PASS' in text
 runtime=json.loads((O/'native/results.json').read_text());validate();check('native-after');afterSign=signatures();save('signatures.json',{'before':beforeSign,'after':afterSign});check('final')
except BaseException as exc:
 error=repr(exc);traceback.print_exc()
 if child and child.poll() is None:blocked=True
finally:
 try:
  current=table();remaining=[x for x in current if (x['pid'],x['created']) in seen];inside={(x['pid'],int(x['created'])) for sample in runtime['samples'] for x in sample['rows']} if runtime else set();remainingRecorded=[x for x in current if (x['pid'],x['created']) in inside]
 except Exception as exc:error=(error or '')+' final snapshot '+repr(exc)
 passed=error is None and exitCode==0 and runtime is not None and rootBirth is not None and remaining==remainingRecorded==[]
 save('report.json',{'schemaVersion':1,'executor':'/root/p5_acceptance','at':now(),'status':'passed_independent_wait_only_neutral_calibration' if passed else 'blocked_independent_neutral_calibration' if blocked else 'failed_independent_neutral_calibration','freeze':P['freeze'],'counts':counts,'nativeInvocations':1 if child else 0,'manualRetries':0,'exitCode':exitCode,'error':error,'childStillRunning':bool(child and child.poll() is None),'sourceCount':39,'artifactCount':2,'observedOuterRootBirth':rootBirth,'observedOuterIdentities':len(seen),'remainingObservedOuterIdentities':remaining,'remainingRecordedFixtureIdentities':remainingRecorded,'GUIReleased':not blocked and remaining==remainingRecorded==[],'engineeringRerun':False,'scope':'One approved/pending ordinary wait-only call root-only SIGKILL calibration, zero input. No ACC await-entry ACK or macro invocation/terminal durable-attribution guarantee, no held/release/durable hard-abort total-gate pass. GET-only restart observations only.','phaseStatus':'in_progress'});print(json.dumps({'passed':passed,'counts':counts,'exitCode':exitCode,'error':error,'blocked':blocked}),flush=True)
if not passed:raise SystemExit(1)
