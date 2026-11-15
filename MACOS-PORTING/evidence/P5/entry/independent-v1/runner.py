import datetime,hashlib,json,os,pathlib,re,subprocess,tempfile,time,traceback
ROOT=pathlib.Path('/tmp/ruyi-p5-entry-worktree');OUT=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac/MACOS-PORTING/evidence/P5/entry/independent-v1');BASE=OUT.parent;FREEZE=BASE/'freeze-v4.json';REVIEW=BASE/'code-review-v1.json';NODE='/Users/jiming/.local/bin/node';PYTHON='/Users/jiming/Documents/ruyi-workbench-mac/mcp/ai-computer-control/.venv/bin/python';HELPER=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/runtime/macos/ruyi-automation-helper');APP=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/dist/Ruyi.app')
CHECKS=[];RUNS=[]
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def digest(p):
 b=pathlib.Path(p).read_bytes();return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def save(n,o):(OUT/n).write_text(json.dumps(o,indent=2)+'\n')
F=json.loads(FREEZE.read_text());V=json.loads(REVIEW.read_text());assert V['verdict']=='passed_final_source_review_all_findings_closed' and not V['unresolvedFindings'];FSHA=digest(FREEZE)['sha256'];RSHA=digest(REVIEW)['sha256'];PROCESS=ROOT/'ruyi-workbench/runtime/macos/ruyi-process-helper';PROCESS_HASH=digest(PROCESS)
def check(label):
 files=[{'path':x['path'],'expectedSha256':x['sha256'],**digest(ROOT/x['path'])} for x in F['files']]
 for x in files:x['matched']=x['sha256']==x['expectedSha256']
 artifacts=[{'path':x['path'],'expectedSha256':x['sha256'],**digest(x['path'])} for x in F['artifacts']]
 for x in artifacts:x['matched']=x['sha256']==x['expectedSha256']
 row={'label':label,'at':now(),'files':files,'artifacts':artifacts,'fileCount':len(files),'artifactCount':len(artifacts),'allMatched':all(x['matched'] for x in files+artifacts),'freezeUnchanged':digest(FREEZE)['sha256']==FSHA,'reviewUnchanged':digest(REVIEW)['sha256']==RSHA,'processHelperUnchanged':digest(PROCESS)==PROCESS_HASH};CHECKS.append(row);save('source-artifact-checks.json',CHECKS)
 assert len(files)==15 and len(artifacts)==3 and row['allMatched'] and row['freezeUnchanged'] and row['reviewUnchanged'] and row['processHelperUnchanged'],'Source/artifact drift'
def table():
 raw=subprocess.run(['ps','-axo','pid=,ppid=,lstart=,command='],capture_output=True,text=True,check=True).stdout;rows=[]
 for line in raw.splitlines():
  p=line.split(None,7)
  if len(p)==8:rows.append({'pid':int(p[0]),'ppid':int(p[1]),'birth':' '.join(p[2:7]),'command':p[7]})
 return rows

def run(name,command,expected_pass=None):
 check(name+'-before');base=pathlib.Path(tempfile.mkdtemp(dir='/tmp',prefix='ruyi-ei1-'));probe=subprocess.run(['git','-C',str(base),'rev-parse','--show-toplevel'],capture_output=True);assert probe.returncode==128
 envvals={k:str(base/v) for k,v in [('HOME','h'),('USERPROFILE','u'),('APPDATA','a'),('LOCALAPPDATA','l'),('WCW_DATA_DIR','w'),('RUYI_HOME','r'),('WIN_CLAUDE_WORKBENCH_HOME','c'),('TMPDIR','t')]}
 for v in envvals.values():pathlib.Path(v).mkdir()
 directory=OUT/name;directory.mkdir(exist_ok=True)
 envvals.update({'RUYI_REAL_HOME':'/Users/jiming','RUYI_ACC_PYTHON':PYTHON,'DYLD_FRAMEWORK_PATH':'/Users/jiming/.local/esp-runtimes','DYLD_LIBRARY_PATH':'/Users/jiming/.local/esp-runtimes/Python.framework/Versions/3.12/lib','PYTHONPATH':str(ROOT/'mcp/ai-computer-control/src'),'PYTHONDONTWRITEBYTECODE':'1','RUYI_P5_ENTRY_HELPER':str(HELPER)})
 if name=='native':envvals.update({'RUYI_P5_ENTRY_REQUIRED':'1','RUYI_P5_ENTRY_EVIDENCE':str(directory)})
 env=os.environ.copy()
 for key in ['WCW_SESSION_ID','RUYI_P5_ENTRY_REQUIRED','RUYI_P5_ENTRY_EVIDENCE','RUYI_TEST_SESSION_MONITOR_FAILURE','RUYI_P5_MANUAL_CLEANUP_FAULT']:env.pop(key,None)
 env.update(envvals);log=directory/'output.txt';assert not log.exists(),'Refuse scenario retry'
 start=time.monotonic();started=now();observed={}
 with log.open('wb') as f:
  child=subprocess.Popen(command,cwd=ROOT,env=env,stdout=f,stderr=subprocess.STDOUT)
  save(name+'/invocation.json',{'command':command,'pid':child.pid,'startedAt':started,'environment':envvals,'tmpdirPathBytes':len(os.fsencode(envvals['TMPDIR']))})
  while child.poll() is None:
   snapshot=table();owned={child.pid};changed=True
   while changed:
    changed=False
    for row in snapshot:
     if row['ppid'] in owned and row['pid'] not in owned:owned.add(row['pid']);changed=True
   for row in snapshot:
    if row['pid'] in owned:observed[(row['pid'],row['birth'])]=row
   save(name+'/observed-process-identities.json',list(observed.values()))
   if time.monotonic()-start>900:raise TimeoutError('Owned acceptance is still running; identity receipts retained, no automatic retry or unverified forced cleanup')
   time.sleep(1)
  exit_code=child.wait()
 text=log.read_text(errors='replace');current=table();remnants=[x for x in current if (x['pid'],x['birth']) in observed]
 result={'name':name,'command':command,'startedAt':started,'elapsedSeconds':round(time.monotonic()-start,3),'exitCode':exit_code,'log':str(log),'logDigest':digest(log),'passLines':len(re.findall(r'^PASS ',text,re.M)),'failLines':len(re.findall(r'^FAIL ',text,re.M)),'skipLines':len(re.findall(r'^SKIP ',text,re.M)),'environment':envvals,'tmpdirPathBytes':len(os.fsencode(envvals['TMPDIR'])),'observedOwnedIdentities':list(observed.values()),'remainingObservedOwnedIdentities':remnants,'processObservationScope':'Popen-owned Node and descendants sampled once per second; transient children may not be sampled. The fixtures separately record and confirm exact owned birth identities at cleanup.'}
 if name=='fast':
  m=re.search(r'^# 汇总: (\d+) pass / (\d+) fail / (\d+) known-fail / (\d+) unexpected-pass / (\d+) flaky / (\d+) ran / (\d+) skipped',text,re.M);assert m;result['counts']=dict(zip(['pass','fail','knownFail','unexpectedPass','flaky','ran','skipped'],map(int,m.groups())))
  n=re.search(r'^# unit 测试: ℹ tests (\d+) / ℹ pass (\d+) / ℹ fail (\d+) / ℹ skipped (\d+)',text,re.M);assert n;result['nestedUnitCounts']=dict(zip(['tests','pass','fail','skipped'],map(int,n.groups())));result['retryLines']=[s for s in text.splitlines() if '[retry]' in s or '[flaky:' in s]
  result['passed']=exit_code==0 and result['counts']['fail']==0 and not remnants
 else:result['passed']=exit_code==0 and result['passLines']==expected_pass and result['failLines']==0 and result['skipLines']==0 and bool(re.search(r'E2E: ALL PASS',text)) and not remnants
 if name=='offline':
  receipts=[s.split('Owned cleanup receipt: ',1)[1] for s in text.splitlines() if s.startswith('Owned cleanup receipt: ')];result['cleanupReceipts']=[json.loads(s) for s in receipts];assert receipts
 if name=='native' and (directory/'results.json').exists():
  receipt=json.loads((directory/'results.json').read_text());result['runtimeEvidenceDigest']=digest(directory/'results.json');result['cleanupSafe']=receipt['cleanupSafe'];result['cleanupReceipts']=receipt['cleanups'];result['inputSourceRestored']=any(s.get('event')=='input-source-restore' and s.get('restored') for s in receipt['reports']);result['clipboardRestored']=any(s.get('event')=='clipboard-restore' and s.get('restored') for s in receipt['reports']);assert result['cleanupSafe'] and result['inputSourceRestored'] and result['clipboardRestored']
 check(name+'-after');save(name+'/report.json',result);RUNS.append(result);save('results.json',RUNS);print(json.dumps({'stage':name,'exitCode':exit_code,'passLines':result['passLines'],'failLines':result['failLines'],'counts':result.get('counts'),'seconds':result['elapsedSeconds']}),flush=True);assert result['passed'],'Acceptance failed '+name
 return result

def signatures():
 rows=[]
 for path,deep in [(HELPER,False),(APP,True),(PROCESS,False)]:
  command=['/usr/bin/codesign','--verify',*(['--deep'] if deep else []),'--strict',str(path)];p=subprocess.run(command,capture_output=True,text=True);rows.append({'command':command,'exitCode':p.returncode,'stdout':p.stdout,'stderr':p.stderr});assert p.returncode==0
 return rows
try:
 check('initial');signed={'before':signatures()};save('artifact-signatures.json',signed)
 run('offline',[NODE,'dev-harness/checkpoint-proxy-session.e2e.js'],13)
 run('native',[NODE,'dev-harness/macos-native-entry.e2e.js'],31)
 run('fast',[NODE,'dev-harness/run-all.js','--fast'])
 signed['after']=signatures();save('artifact-signatures.json',signed);check('final')
 save('report.json',{'schemaVersion':1,'reviewer':'/root/p5_acceptance','at':now(),'status':'passed_entry_freeze_v4_independent_acceptance','worktree':str(ROOT),'freeze':{'path':str(FREEZE),'digest':digest(FREEZE)},'codeReview':{'path':str(REVIEW),'digest':digest(REVIEW)},'sourceFiles':15,'artifacts':3,'processHelper':{'path':str(PROCESS),**PROCESS_HASH},'checkpoints':len(CHECKS),'allSourceArtifactsMatched':all(x['allMatched'] and x['freezeUnchanged'] and x['reviewUnchanged'] and x['processHelperUnchanged'] for x in CHECKS),'runs':RUNS,'independentScenarioInvocations':{'offline':1,'native':1,'fast':1},'manualRetries':0,'fastAutomaticRetriesObserved':len(RUNS[-1].get('retryLines',[])),'phaseStatus':'in_progress','scope':'Actual ordinary provider-session proxy checkpoint and native approval allow/deny/cancel plus image create/overwrite/rollback. Real Mac receiver/ACC and offline model provider. No OS lock, TCC revocation, physical human input, App LaunchServices or Windows-runtime test in this acceptance. Existing native/Python/manual suites were not rerun.','history':'Initial parent fast76/80 then78/80 had fixture inventory/doc failures with runner automatic retries. Later parent fast80/80 overlapped harness/README edits. This is the separate frozen-v4 serial independent run; no overall zero-rerun claim.','claim':'Entry slice passes within its recorded current-host scope, including exact session/turn checkpoints and observed cleanup. Original remaining P5/application/environment gates remain open.'})
 print('ENTRY INDEPENDENT V1 PASS',flush=True)
except BaseException as error:
 traceback.print_exc()
 try:check('failure-final')
 except BaseException:traceback.print_exc()
 save('report.json',{'schemaVersion':1,'reviewer':'/root/p5_acceptance','at':now(),'status':'failed_or_blocked','error':repr(error),'runs':RUNS,'checks':CHECKS,'phaseStatus':'in_progress','retryPolicy':'First unexpected failure stops later stages; no automatic rerun.'});raise
