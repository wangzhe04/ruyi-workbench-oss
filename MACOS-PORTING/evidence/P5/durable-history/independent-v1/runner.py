import pathlib,json,hashlib,datetime,subprocess,tempfile,os,time,re,sys,traceback
assert sys.argv[1:]==['--authorized-run'],'Wait for completed four gates and explicit parent run/GUI handoff'
R=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac');W=pathlib.Path('/tmp/ruyi-p5-durable-history-worktree');O=pathlib.Path(__file__).resolve().parent;E=O.parent;F=json.loads((E/'freeze-v3.json').read_text());F2=json.loads((E/'freeze-v2.json').read_text());P=json.loads((O/'preparation-v2.json').read_text());assert P['supplementalReviewPending'] is False and P['supplementalReview'],'Await final census supplemental review';PROCESS=W/'ruyi-workbench/runtime/macos/ruyi-process-helper';NODE='/Users/jiming/.local/bin/node';checks=[];runs=[];active=None;error=None;blocked=False;signBefore=[];signAfter=[];allSeen={};caseDirs=[]
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def dg(p):
 b=pathlib.Path(p).read_bytes();return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def save(n,x):(O/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def check(label):
 rows=[{'path':x['path'],**dg(W/x['path'])} for x in F['sources']];arts=[{'path':x['path'],**dg(x['path'])} for x in F['artifacts']];digest=hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()).hexdigest();extras=[{'path':x['path'],**dg(W/x['path'])} for x in P['additionalEntryFixtures']];extraOkay=all(y=={k:x[k] for k in ['path','bytes','sha256']} for x,y in zip(P['additionalEntryFixtures'],extras));okay=extraOkay and rows==F['sources'] and arts==F['artifacts'] and digest==F['sourceDigest'] and all(dg(x['path'])=={'bytes':x['bytes'],'sha256':x['sha256']} for x in [P['freeze'],P['codeReview'],P['supplementalReview'],P['additionalEntryBinding']]);checks.append({'label':label,'at':now(),'sourceFiles':len(rows),'sourceDigest':digest,'sources':rows,'artifacts':arts,'additionalEntryFixtures':extras,'allMatched':okay});save('source-artifact-checks.json',checks);assert okay,'source/artifact/review drift'
def table():
 p=subprocess.run([str(PROCESS),'--snapshot'],capture_output=True,text=True,check=True,timeout=8);assert p.stdout.startswith('RUYI-PROCESS-V1\n');rows=[]
 for line in p.stdout.splitlines()[1:]:
  x=line.split(',')
  if len(x)>=3:rows.append({'pid':int(x[0]),'ppid':int(x[1]),'created':int(x[2])})
 return rows
def signatures():
 rows=[]
 for x in F['artifacts']:
  argv=['/usr/bin/codesign','--verify','--strict',x['path']];p=subprocess.run(argv,capture_output=True,text=True,timeout=10);rows.append({'argv':argv,'exitCode':p.returncode,'stdout':p.stdout,'stderr':p.stderr});assert p.returncode==0
 return rows
def engineReuse():
 evidence=[];runsSummary=[]
 for name,freeze,labels,exits,checkpointCount in [('engineering-v1',F2,['syntax','build','unit','fast'],[0,0,0,1],8),('engineering-v2',F,['syntax','fast'],[0,0],4)]:
  base=E/'development'/name;execution=json.loads((base/'execution.json').read_text());assert [x['label'] for x in execution]==labels and [x['exitCode'] for x in execution]==exits,'engineering not completed at expected final scope';ck=json.loads((base/'source-artifact-checks.json').read_text());assert len(ck)==checkpointCount
  for x in ck:assert x['sourceFiles']==len(freeze['sources']) and x['sourceDigest']==freeze['sourceDigest'] and x['unchanged'] is True and x['artifacts']==freeze['artifacts']
  evidence.extend({'path':str(p),**dg(p)} for p in sorted(base.iterdir()) if p.is_file());runsSummary.append({'name':name,'execution':execution,'sourceCount':len(freeze['sources']),'sourceDigest':freeze['sourceDigest'],'hashCheckpoints':checkpointCount})
 targeted=E/'development/targeted-final';tr=json.loads((targeted/'execution.json').read_text());assert len(tr)==4 and all(x['exitCode']==0 for x in tr);tc=json.loads((targeted/'source-artifact-checks.json').read_text());assert len(tc)==8 and all(x['sourceFiles']==126 and x['sourceDigest']==F2['sourceDigest'] and x['unchanged'] is True and x['artifacts']==F2['artifacts'] for x in tc)
 evidence.extend({'path':str(p),**dg(p)} for p in sorted(targeted.iterdir()) if p.is_file())
 save('engineering-reuse.json',{'independentFullEngineeringReruns':0,'runs':runsSummary,'relatedFinalExecution':tr,'relatedFinalSourceCheckpoints':8,'files':evidence,'history':'Primary v1 syntax/build/unit passed, fast79/80 failed session-save-census with built-in retry. Only static census changed outside original126-source freeze. Final v2 syntax/fullfast includes another unit preflight; build/standalone unit reused by unchanged126-source/2-artifact hashes. Independent runs only new unit9/offline11/native12 plus separately authorized unchanged entry31, not full unit/fast.'})
def validateOffline(raw):
 assert raw['retainedRoot'] is None and raw['serverSha256']==next(x['sha256'] for x in F['sources'] if x['path']=='ruyi-workbench/app/server.js');assert all(not x.get('incomplete') and not x.get('skipped') for x in raw['cleanups']);assert len(raw['turns'])==2
 snaps={x['label']:x for x in raw['snapshots']};before=snaps['before-kill'];after=snaps['after-kill'];assert before['provider']==after['provider'];batch=next(x for x in before['provider'] if x['role']=='assistant' and len(x.get('tool_calls',[]))==2);assert [x['id'] for x in batch['tool_calls']]==['call_1','call_2'];assert any(x['role']=='tool' and x['tool_call_id']=='call_1' and json.loads(x['content'])['ok'] is True for x in before['provider']);assert not any(x['role']=='tool' and x['tool_call_id']=='call_2' for x in before['provider'])
 for snap in raw['snapshots']:
  for suffix,obj in [('.json',snap['head']),('.provider.ndjson',snap['provider']),('.messages.ndjson',snap['messages'])]:
   p=O/'offline/native'/snap['label']/(snap['id']+suffix);actual=json.loads(p.read_text()) if suffix=='.json' else [json.loads(x) for x in p.read_text().splitlines() if x.strip()];assert actual==obj
 return {(x['pid'],int(x['created'])) for x in raw['observed']}
def validateNative(raw):
 assert raw['failures']==0 and not raw.get('failure') and raw['retainedRoot'] is None and raw['archiveErrors']==[];assert raw['spec']['args']['steps']==[{'tool':'wait','args':{'seconds':30}}];assert raw['fault']['signalCode']=='SIGKILL' and raw['fault']['exitCode'] is None and 0<=raw['fault']['elapsedMs']<15000;assert not any(x.get('externalIntervention') for x in raw['cleanups'])
 for x in raw['reports']:
  if x.get('event') in ['ready','state']:assert x['downs']==x['ups']==x['otherInput']==0 and x['receipts']==[] and not any(x[k] for k in ['hidLeft','combinedLeft','hidModifiers','combinedModifiers'])
 sid=raw['sessionId'];intentRows=[]
 for snap in raw['snapshots']:
  base=O/'native/native'/snap['label']
  for x in snap['files']:assert dg(base/x['path'])=={'bytes':x['bytes'],'sha256':x['sha256']}
  rows=[json.loads(x) for x in (base/'sessions'/(sid+'.provider.ndjson')).read_text().splitlines() if x.strip()];head=json.loads((base/'sessions'/(sid+'.json')).read_text());assistant=next(x for x in rows if x['role']=='assistant' and x.get('tool_calls'));assert len(assistant['tool_calls'])==1;tc=assistant['tool_calls'][0];assert tc['id']==raw['spec']['callId'] and tc['function']['name']=='tool_invoke_exec' and json.loads(tc['function']['arguments'])=={'name':'ai_computer_control__macro_run','arguments':raw['spec']['args']};assert not any(x['role']=='tool' for x in rows) and head['providerHistoryCount']==len(rows);intentRows.append({'stage':snap['label'],'callId':tc['id'],'name':tc['function']['name'],'args':json.loads(tc['function']['arguments']),'providerRoles':[x['role'] for x in rows],'headCount':head['providerHistoryCount']})
 view=raw['restart']['view']['json'];assert view['execution'] is None and view['resumable']['dangling'] is True and view['resumable']['kind']=='tool_calls' and raw['restart']['providerCountBefore']==raw['restart']['providerCountAfter'];assert raw['helperSha256']==raw['finalHelperSha256']==F['artifacts'][0]['sha256'];save('native-intent-review.json',{'source':'Independent raw provider files, not inference from twelve old fixture assertions','stages':intentRows,'restartResumable':view['resumable'],'requestedIntentPersisted':True,'roleToolOrMacroTerminalPresent':False,'actualDispatchOrACCWaitEntryAckProved':False,'permissionIsDistinctFromDispatch':True,'hardAbortGate':'open'})
 return {(x['pid'],int(x['created'])) for sample in raw['samples'] for x in sample['rows']}
def validateEntry(raw):
 assert raw['cleanupSafe'] is True and raw['retainedRoot'] is None and len(raw['checkpoints'])==4
 assert any(x.get('event')=='input-source-restore' and x.get('restored') for x in raw['reports']) and any(x.get('event')=='clipboard-restore' and x.get('restored') for x in raw['reports'])
 assert {x['label'] for x in raw['turns']}=={'ENTRY_APPROVAL_allow','ENTRY_APPROVAL_deny','ENTRY_APPROVAL_cancel','ENTRY_IMAGE_window_screenshot_false','ENTRY_IMAGE_window_screenshot_true','ENTRY_IMAGE_get_clipboard_image_false','ENTRY_IMAGE_get_clipboard_image_true'}
 recorded=set()
 for cleanup in raw['cleanups']:
  if 'receipt' in cleanup:assert not cleanup['receipt'].get('incomplete') and not cleanup['receipt'].get('skipped')
  recorded.update((x['pid'],int(x['created'])) for x in cleanup.get('observed',[]))
 return recorded
def run(name,argv,expected):
 global active,blocked
 check(name+'-before');out=O/name;out.mkdir(exist_ok=False);caseDirs.append(out);base=pathlib.Path(tempfile.mkdtemp(dir='/tmp',prefix='p5dh-'));assert subprocess.run(['git','-C',str(base),'rev-parse','--show-toplevel'],capture_output=True).returncode==128
 vals={k:str(base/v) for k,v in [('HOME','h'),('USERPROFILE','u'),('APPDATA','a'),('LOCALAPPDATA','l'),('WCW_DATA_DIR','w'),('RUYI_HOME','r'),('WIN_CLAUDE_WORKBENCH_HOME','c'),('TMPDIR','t')]}
 for p in vals.values():pathlib.Path(p).mkdir()
 vals.update({'RUYI_REAL_HOME':'/Users/jiming','PYTHONDONTWRITEBYTECODE':'1','DYLD_FRAMEWORK_PATH':'/Users/jiming/.local/esp-runtimes','DYLD_LIBRARY_PATH':'/Users/jiming/.local/esp-runtimes/Python.framework/Versions/3.12/lib','RUYI_ACC_PYTHON':str(R/'mcp/ai-computer-control/.venv/bin/python'),'PYTHONPATH':str(W/'mcp/ai-computer-control/src')})
 if name=='offline':vals['RUYI_TOOL_HISTORY_EVIDENCE']=str(out/'native')
 if name=='native':vals.update({'RUYI_P5_ABORT_REQUIRED':'1','RUYI_P5_ABORT_HELPER':F['artifacts'][0]['path'],'RUYI_P5_ABORT_EVIDENCE':str(out/'native')})
 if name=='entry':vals.update({'RUYI_P5_ENTRY_REQUIRED':'1','RUYI_P5_ENTRY_HELPER':F['artifacts'][0]['path'],'RUYI_P5_ENTRY_EVIDENCE':str(out/'native')})
 env=os.environ.copy()
 for k in ['WCW_SESSION_ID','RUYI_TEST_SERVER_JS','RUYI_TOOL_HISTORY_EVIDENCE','RUYI_P5_ABORT_REQUIRED','RUYI_P5_ABORT_HELPER','RUYI_P5_ABORT_EVIDENCE','RUYI_P5_ENTRY_REQUIRED','RUYI_P5_ENTRY_HELPER','RUYI_P5_ENTRY_EVIDENCE']:env.pop(k,None)
 env.update(vals);assert len(os.fsencode(vals['TMPDIR']))<32;seen={};birth=None;began=time.monotonic();log=out/'output.txt'
 with log.open('wb') as f:
  child=subprocess.Popen(argv,cwd=W,env=env,stdout=f,stderr=subprocess.STDOUT);active=child;save(name+'/invocation.json',{'executor':'/root/p5_acceptance','at':now(),'argv':argv,'pid':child.pid,'cwd':str(W),'environment':vals,'attempt':1})
  while child.poll() is None:
   rows=table();by={x['pid']:x for x in rows};root=by.get(child.pid)
   if root and birth is None and root['ppid']==os.getpid() and child.poll() is None:birth=root['created']
   if root and root['created']==birth:
    own={child.pid};changed=True
    while changed:
     changed=False
     for x in rows:
      p=by.get(x['ppid'])
      if x['pid'] not in own and x['ppid'] in own and p and x['created']>=p['created']:own.add(x['pid']);changed=True
    after={x['pid']:x for x in table()}
    for pid in own:
     x=by[pid]
     if after.get(pid,{}).get('created')==x['created']:seen[(pid,x['created'])]=x;allSeen[(pid,x['created'])]=x
   save(name+'/observed-identities.json',list(seen.values()))
   if time.monotonic()-began>600:blocked=True;raise TimeoutError('Owned case still running; no retry or extra-root kill')
   time.sleep(.15)
  code=child.wait();active=None
 text=log.read_text();recorded=set();raw=None
 if name=='unit':
  found={k:int(re.search(r'^# '+k+r' (\d+)\s*$',text,re.M)[1]) for k in ['tests','pass','fail','skipped']};assert found=={'tests':9,'pass':9,'fail':0,'skipped':0};counts=found
 else:
  counts={k:len(re.findall('^'+k.upper()+' ',text,re.M)) for k in ['pass','fail','skip']};assert counts=={'pass':expected,'fail':0,'skip':0} and 'E2E: ALL PASS' in text;raw=json.loads((out/'native/results.json').read_text());recorded=validateOffline(raw) if name=='offline' else validateNative(raw) if name=='native' else validateEntry(raw)
 current=table();remain=[x for x in current if (x['pid'],x['created']) in seen];remainRecorded=[x for x in current if (x['pid'],x['created']) in recorded];assert code==0 and birth is not None and remain==remainRecorded==[]
 check(name+'-after');result={'name':name,'executor':'/root/p5_acceptance','exitCode':code,'counts':counts,'seconds':time.monotonic()-began,'rootBirth':birth,'observedOuterIdentities':len(seen),'remainingOuterIdentities':remain,'remainingRecordedIdentities':remainRecorded,'log':str(log),'logDigest':dg(log),'runtimeEvidenceDigest':dg(out/'native/results.json') if raw else None,'passed':True};save(name+'/report.json',result);runs.append(result);save('results.json',runs);print(json.dumps({'case':name,'exitCode':code,'counts':counts}),flush=True)
try:
 check('initial');engineReuse();signBefore=signatures();save('signatures.json',{'before':signBefore})
 run('unit',[NODE,'--test','--test-reporter=tap','dev-harness/unit/session-required-persistence.test.js'],9)
 run('offline',[NODE,'dev-harness/provider-tool-history.e2e.js'],11)
 run('native',[NODE,'dev-harness/macos-neutral-abort.e2e.js'],12)
 run('entry',[NODE,'dev-harness/macos-native-entry.e2e.js'],31)
 signAfter=signatures();save('signatures.json',{'before':signBefore,'after':signAfter});check('final')
except BaseException as exc:
 error=repr(exc);traceback.print_exc()
 if active and active.poll() is None:blocked=True
finally:
 finalRemaining=None;finalRecordedRemaining=None
 try:
  current=table();finalRemaining=[x for x in current if (x['pid'],x['created']) in allSeen];recorded=set()
  for d in caseDirs:
   f=d/'native/results.json'
   if f.exists():
    raw=json.loads(f.read_text());recorded.update((x['pid'],int(x['created'])) for x in raw.get('observed',[]));recorded.update((x['pid'],int(x['created'])) for sample in raw.get('samples',[]) for x in sample['rows']);recorded.update((x['pid'],int(x['created'])) for cleanup in raw.get('cleanups',[]) for x in cleanup.get('observed',[]))
  finalRecordedRemaining=[x for x in current if (x['pid'],x['created']) in recorded]
 except Exception as exc:error=(error or '')+' final cleanup observation '+repr(exc)
 passed=error is None and len(runs)==4 and finalRemaining==finalRecordedRemaining==[]
 save('report.json',{'schemaVersion':1,'executor':'/root/p5_acceptance','at':now(),'status':'passed_independent_durable_history_freeze_v3' if passed else 'blocked_independent_durable_history' if blocked else 'failed_independent_durable_history','freeze':P['freeze'],'sourceCount':len(F['sources']),'sourceDigest':F['sourceDigest'],'artifactCount':2,'runs':runs,'error':error,'childStillRunning':bool(active and active.poll() is None),'independentInvocations':{x['name']:1 for x in runs},'manualRetries':0,'engineeringReruns':0,'remainingFinalObservedIdentities':finalRemaining,'remainingFinalRecordedIdentities':finalRecordedRemaining,'GUIReleased':not blocked and finalRemaining==finalRecordedRemaining==[],'scope':'Requested/model tool intent before processing and received-prefix result persistence, targeted effect/image/owner cases plus zero-input native root-only calibration. Native requested callID/name/args survives and GET restart kind tool_calls; existing entry31 separately exercises actual default approvals, balanced input, image checkpoints/rollback and restoration. No actual dispatch/ACC await entry/terminal or held hard-abort guarantee is inferred from the zero-input calibration.','hardAbortGateStatus':'open','phaseStatus':'in_progress'});print(json.dumps({'passed':passed,'runs':len(runs),'error':error,'blocked':blocked}),flush=True)
if not passed:raise SystemExit(1)
