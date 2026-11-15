import datetime,hashlib,json,os,pathlib,re,selectors,subprocess,tempfile,time,traceback
ROOT=pathlib.Path('/tmp/ruyi-p5-manual-worktree')
OUT=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac/MACOS-PORTING/evidence/P5/manual/independent-offline-v5')
FREEZE=OUT.parent/'development/sequence/current-source-v5.json'
EXPECTED=json.loads(FREEZE.read_text())['files']; FREEZE_SHA=hashlib.sha256(FREEZE.read_bytes()).hexdigest()
NODE='/Users/jiming/.local/bin/node'; PYTHON='/Users/jiming/Documents/ruyi-workbench-mac/mcp/ai-computer-control/.venv/bin/python'
STEPS=[]; CHECKS=[]; NATIVE=[]; ARTIFACTS=[]
def stamp(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def digest(path):
 b=pathlib.Path(path).read_bytes(); return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def save(name,value): (OUT/name).write_text(json.dumps(value,indent=2)+'\n')
def check(label):
 rows=[{'path':p,'actual':digest(ROOT/p),'expected':e} for p,e in EXPECTED.items()]
 for r in rows:r['matched']=r['actual']==r['expected']
 row={'label':label,'at':stamp(),'count':len(rows),'freezeUnchanged':digest(FREEZE)['sha256']==FREEZE_SHA,'allMatched':all(r['matched'] for r in rows),'files':rows}
 CHECKS.append(row);save('source-checks.json',CHECKS)
 assert len(rows)==34 and row['allMatched'] and row['freezeUnchanged'], 'Source freeze drift at '+label

def environment(name):
 base=pathlib.Path(tempfile.mkdtemp(dir='/tmp',prefix='ruyi-v5-'))
 probe=subprocess.run(['git','-C',str(base),'rev-parse','--show-toplevel'],capture_output=True,text=True)
 assert probe.returncode==128,'Isolation root is in a Git repository'
 mapping={'HOME':'home','USERPROFILE':'userprofile','APPDATA':'appdata','LOCALAPPDATA':'localappdata','WCW_DATA_DIR':'wcw-data','RUYI_HOME':'ruyi-home','WIN_CLAUDE_WORKBENCH_HOME':'win-claude-home','TMPDIR':'tmp'}
 vals={k:str(base/v) for k,v in mapping.items()}
 for v in vals.values():pathlib.Path(v).mkdir(parents=True,exist_ok=True)
 vals.update({'DYLD_FRAMEWORK_PATH':'/Users/jiming/.local/esp-runtimes','DYLD_LIBRARY_PATH':'/Users/jiming/.local/esp-runtimes/Python.framework/Versions/3.12/lib','PYTHONPATH':str(ROOT/'mcp/ai-computer-control/src'),'PYTHONDONTWRITEBYTECODE':'1','RUYI_MACOS_AUTOMATION_HELPER':str(base/'absent-native-helper'),'ACC_HIDE_TOOLS':'','PYTHONUNBUFFERED':'1'})
 assert not pathlib.Path(vals['RUYI_MACOS_AUTOMATION_HELPER']).exists()
 env=os.environ.copy();env.pop('RUYI_TEST_SESSION_MONITOR_FAILURE',None);env.update(vals);return env,vals

def run(name,cmd,timeout=180,cwd=ROOT,request=None,expectedExit=0):
 check(name+'-before'); env,vals=environment(name); log=OUT/(name+'.txt')
 assert not log.exists(), 'Command already attempted: '+name
 started=stamp();start=time.monotonic()
 with log.open('wb') as f:
  p=subprocess.run(cmd,cwd=str(cwd),env=env,input=json.dumps(request).encode() if request is not None else None,stdout=f,stderr=subprocess.STDOUT,timeout=timeout)
 row={'name':name,'command':cmd,'cwd':str(cwd),'startedAt':started,'elapsedSeconds':round(time.monotonic()-start,3),'exitCode':p.returncode,'expectedExitCode':expectedExit,'tmpdirPathBytes':len(os.fsencode(vals['TMPDIR'])),'environment':vals,'request':request,'log':str(log),'logDigest':digest(log)}
 STEPS.append(row);save('steps.json',STEPS);check(name+'-after')
 print(json.dumps({'step':name,'exit':p.returncode,'seconds':row['elapsedSeconds']}),flush=True)
 assert p.returncode==expectedExit,'Unexpected exit: '+name
 return log.read_text(errors='replace'),row

def native(name,helper,request,predicate):
 expectedExit=1 if name.startswith('native-invalid-') or name.startswith('normal-excludes-') else 0
 output,row=run(name,[str(helper)],request={'version':1,**request},expectedExit=expectedExit)
 result=json.loads(output);row['nativeResult']=result;assert predicate(result),'Native assertion failed '+name+': '+output
 save('steps.json',STEPS);return result

def assertion(name,condition):
 NATIVE.append({'assertion':name,'passed':bool(condition)});save('native-assertions.json',NATIVE)
 assert condition,'Native assertion failed '+name
 print('PASS '+name,flush=True)

try:
 check('initial')
 outdir=pathlib.Path(tempfile.mkdtemp(prefix='ruyi-v5-build-',dir='/tmp')); normal=outdir/'normal-helper';testing=outdir/'testing-helper'
 for mode,path in [('normal',normal),('testing',testing)]:
  code="const b=require('./ruyi-workbench/tools/build-macos-automation-helper.js');console.log(b.buildMacAutomationHelper({output:"+json.dumps(str(path))+",testing:"+('true' if mode=='testing' else 'false')+"}));"
  run('build-'+mode,[NODE,'-e',code],timeout=100)
  ARTIFACTS.append({'mode':mode,'path':str(path),**digest(path)})
 save('artifacts.json',ARTIFACTS)
 r=native('native-release-allocation',testing,{'op':'test_release_allocation'},lambda r:r.get('ok') is True)
 for field in ['cleanup_refused','ownership_retained','permission_ownership_retained','cross_tool_blocked']:assertion(field,r.get(field) is True)
 r=native('native-stopped-mutations',testing,{'op':'test_stopped_mutations'},lambda r:r.get('ok') is True)
 expected={'window.focus','window.move','window.resize','window.maximize','window.minimize','window.close','clipboard.set','clipboard.image.set','application.launch','keyboard.text','keyboard.chord','mouse.click','mouse.move','mouse.drag','mouse.scroll','input.sequence','ax.invoke','record.start'}
 assertion('18 stopped mutations false and not_dispatched',len(r['results'])==18 and {x['op'] for x in r['results']}==expected and all(x['result'].get('ok') is False and x['result'].get('acted') is False and x['result'].get('action_sent') is False and x['result'].get('outcome')=='not_dispatched' and x['result'].get('code')=='input_cancelled' for x in r['results']))
 def key(kind,at=0,flags=0,repeat=0):return {'type':kind,'at_us':at,'flags':flags,'keycode':0,'keyboard_type':0,'repeat':repeat}
 good=[key('key_down',flags=0x20000000),key('key_up',10,flags=0x20000000)]
 r=native('native-raw-flags',testing,{'op':'test_validate_sequence','events':good},lambda r:r.get('ok') is True)
 assertion('raw flags 0x20000000 valid',r['ok'] is True)
 scroll={'type':'scroll','at_us':0,'flags':0,'x':1,'y':1,'delta':[1,0,0],'fixed':[1,0,0],'point':[1,0,0],'continuous':True,'phase':2,'momentum':0,'scroll_count':1}
 cases={'unmatched':[key('key_up')],'repeat':[key('key_down',repeat=1),key('key_up',10)],'scroll':[scroll],'device':[key('key_down',flags=2),key('key_up',10)],'bool':[{**key('key_down'),'keycode':False},key('key_up',10)]}
 for name,events in cases.items():
  r=native('native-invalid-'+name,testing,{'op':'test_validate_sequence','events':events},lambda r:r.get('ok') is False and r.get('code')=='invalid_args')
  assertion('reject '+name,r['ok'] is False and r['code']=='invalid_args')
 for op in ['test_release_allocation','test_stopped_mutations','test_validate_sequence','test_stall_sequence']:
  r=native('normal-excludes-'+op,normal,{'op':op},lambda r:r.get('ok') is False and r.get('code')=='invalid_args')
  assertion('normal excludes '+op,r['ok'] is False and r['code']=='invalid_args')
 assert len(NATIVE)==15
 pointer_native=native('native-pointer-subtypes',testing,{'op':'test_pointer_subtypes'},lambda r:r.get('ok') is True)
 pointer_cases=pointer_native.get('cases',[])
 assert len(pointer_cases)==50 and {(r['subtype'],r['type']) for r in pointer_cases}=={(s,t) for s in range(5) for t in [1,2,3,4,5,6,7,25,26,27]}
 assert pointer_native.get('pressure_association_refused') is True,'Associated pressure must be refused'
 for row in pointer_cases:
  assert row.get('matched') is True,'Native pointer reconstruction mismatch'
  if row['subtype'] in (0,3):
   actual=row['row'];assert actual.get('subtype',0)==row['subtype'] and not row['failure']
   assert actual['x']==25 and actual['y']==35 and actual['button']==(2 if row['type']>=25 else 1 if row['type'] in [3,4,7] else 0) and actual['click_state']==2 and 0<=actual['pressure']<=1 and actual['delta_x']==7 and actual['delta_y']==-4 and actual['flags']==0
  else:assert not row['row'] and row['failure']['code']=='pointer_event_unsupported'
 save('native-pointer-subtypes.json',pointer_native)
 native('normal-excludes-test_pointer_subtypes',normal,{'op':'test_pointer_subtypes'},lambda r:r.get('ok') is False and r.get('code')=='invalid_args')
 pointer={'type':'move','at_us':0,'flags':0,'x':25,'y':35,'button':0,'click_state':2,'pressure':.5,'delta_x':7,'delta_y':-4}
 subtype_matrix=[('omitted',None,True),('zero',0,True),('touch',3,True),('zero-float',0.0,True),('touch-float',3.0,True),('tablet',1,False),('proximity',2,False),('unknown',4,False),('negative',-1,False),('large-unknown',255,False),('true',True,False),('false',False,False),('null',None,False),('string','3',False),('fraction',3.5,False)]
 parity=[]
 for label,subtype,accepted in subtype_matrix:
  event={**pointer,**({} if label=='omitted' else {'subtype':subtype})}
  name=('native-subtype-' if accepted else 'native-invalid-subtype-')+label
  response=native(name,testing,{'op':'test_validate_sequence','events':[event]},lambda r,accepted=accepted:r.get('ok') is accepted and (accepted or r.get('code')=='invalid_args'))
  parity.append({'label':label,'events':[event],'expectedAccepted':accepted,'nativeAccepted':response['ok'],'nativeCode':response.get('code')})
 save('subtype-parity-input.json',parity)
 parity_script=OUT/'python-subtype-parity.py'
 parity_script.write_text("import json,pathlib\nfrom ai_computer_control.utils.macos_sequence import validate_events\nfrom ai_computer_control.utils.macos import DesktopError\nrows=json.loads(pathlib.Path(__file__).with_name('subtype-parity-input.json').read_text())\nfor row in rows:\n try:\n  validate_events(row['events']);row['pythonAccepted']=True;row['pythonCode']=None\n except DesktopError as error:\n  row['pythonAccepted']=False;row['pythonCode']=error.code\n assert row['pythonAccepted'] is row['nativeAccepted'] is row['expectedAccepted']\n assert row['pythonCode']==row['nativeCode']\nprint(json.dumps(rows))\n")
 output,_=run('python-subtype-parity',[PYTHON,str(parity_script)])
 pointer_parity=json.loads(output);assert len(pointer_parity)==15
 save('subtype-native-python-parity.json',pointer_parity)
 for mode,helper in [('testing',testing),('production',normal)]:
  for fault in ['create','register','wait']:
   name='session-'+mode+'-'+fault;check(name+'-before');env,vals=environment(name)
   env['RUYI_TEST_SESSION_MONITOR_FAILURE']=fault;vals['RUYI_TEST_SESSION_MONITOR_FAILURE']=fault
   log=OUT/(name+'.txt');assert not log.exists(),'Refuse duplicate lifetime command'
   started=stamp();start=time.monotonic();cmd=[str(helper),'--input-session']
   child=subprocess.Popen(cmd,cwd=str(ROOT),env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
   response=None;request=None;pipe_open_at_exit=False
   try:
    if mode=='production':
     request={'version':1,'op':'window.list','id':23};child.stdin.write((json.dumps(request)+'\n').encode());child.stdin.flush()
     with selectors.DefaultSelector() as selector:
      selector.register(child.stdout,selectors.EVENT_READ)
      assert selector.select(5),'Production read-only response timed out'
      line=child.stdout.readline();response=json.loads(line)
     assert response.get('id')==23 and response.get('ok') is True,'Production read-only frame refused'
     child.stdin.close();child.wait(timeout=5)
    else:
     child.wait(timeout=5);pipe_open_at_exit=not child.stdin.closed
    stdout=child.stdout.read();stderr=child.stderr.read()
   finally:
    if child.poll() is None:
     child.terminate()
     try:child.wait(timeout=2)
     except subprocess.TimeoutExpired:child.kill();child.wait(timeout=2)
    if child.stdin and not child.stdin.closed:child.stdin.close()
   data={'mode':mode,'fault':fault,'exitCode':child.returncode,'expectedExitCode':70 if mode=='testing' else 0,'request':request,'response':response,'framesWritten':0 if mode=='testing' else 1,'stdinOpenAtExit':pipe_open_at_exit,'stdoutAfterResponse':stdout.decode(errors='replace'),'stderr':stderr.decode(errors='replace')}
   save(name+'.txt',data)
   row={'name':name,'command':cmd,'cwd':str(ROOT),'startedAt':started,'elapsedSeconds':round(time.monotonic()-start,3),'environment':vals,'tmpdirPathBytes':len(os.fsencode(vals['TMPDIR'])),'exitCode':child.returncode,'expectedExitCode':data['expectedExitCode'],'log':str(log),'logDigest':digest(log),'sessionResult':data}
   STEPS.append(row);save('steps.json',STEPS);check(name+'-after')
   assert child.returncode==data['expectedExitCode'],'Unexpected session exit '+name
   assert not stdout,'Unexpected uncorrelated response bytes '+name
   if mode=='testing':assert pipe_open_at_exit and not response,'Testing exited without preserving open stdin contract'
   print(json.dumps({'step':name,'exitCode':child.returncode,'framesWritten':data['framesWritten'],'seconds':row['elapsedSeconds']}),flush=True)
 for suite,count in [('smoke_audit_cancellation',12),('smoke_macos_record',31),('smoke_macos_sequence',17),('smoke_macos_composed',16),('smoke_macos_visual',25),('smoke_macos_capture',13),('smoke_macos_shared',8),('smoke_macos_input',21),('smoke_macos_events',16),('smoke_macos_ax',8)]:
  output,row=run(suite,[PYTHON,str(ROOT/'mcp/ai-computer-control/tests'/(suite+'.py'))],cwd=ROOT/'mcp/ai-computer-control')
  ran=re.search(r'^Ran (\d+) tests? in ([\d.]+)s',output,re.M);row['tests']=int(ran.group(1)) if ran else None
  row['skipped']=len(re.findall(r'\.\.\. skipped ',output));row['unittestOK']=bool(re.search(r'^OK$',output,re.M));save('steps.json',STEPS)
  assert row['tests']==count and row['skipped']==0 and row['unittestOK'],'Python result mismatch '+suite
 gates=[('syntax',[NODE,'dev-harness/syntax-gate.js']),('build-check',[NODE,'ruyi-workbench/app/build.js','--check']),('fullunit',[NODE,'--test','dev-harness/unit/*.test.js']),('run-all-fast',[NODE,'dev-harness/run-all.js','--fast'])]
 for name,cmd in gates:
  output,row=run(name,cmd,timeout=900)
  row['summaryLines']=[s for s in output.splitlines() if re.search(r'^(?:#|ℹ) (?:tests|suites|pass|fail|cancelled|skipped|todo|汇总|件数)|flaky|retry|重跑|SKIP',s)]
  save('steps.json',STEPS)
 check('final')
 report={'schemaVersion':1,'reviewer':'/root/p5_acceptance','at':stamp(),'status':'passed_v5_offline_subset','scope':'Independent v5 offline subset: memory-only native fixtures with no down/up posts; testing monitor create/register/wait faults before frames; production variable exclusion with read-only window.list/EOF. No GUI, default helper/App rebuild or system-setting mutations.','freezePath':str(FREEZE),'freezeSha256':FREEZE_SHA,'frozenFiles':34,'checkpoints':len(CHECKS),'allSourceChecksMatched':all(c['allMatched'] and c['freezeUnchanged'] for c in CHECKS),'manualRetries':0,'expectedNativeNegativeExitOne':sum(x['exitCode']==1 and x['expectedExitCode']==1 for x in STEPS),'expectedMonitorNegativeExitSeventy':sum(x['exitCode']==70 and x['expectedExitCode']==70 for x in STEPS),'unexpectedCommandExits':sum(x['exitCode']!=x.get('expectedExitCode',0) for x in STEPS),'nativeAssertions':NATIVE,'artifacts':ARTIFACTS,'steps':STEPS,'pythonTests':sum(s.get('tests',0) or 0 for s in STEPS),'pythonSkipped':sum(s.get('skipped',0) for s in STEPS),'pending':['Expanded real GUI manual E2E','Real Ruyi App manual chain','Physical human input','Original P5 remaining audit and external gates'],'limitations':'These results do not establish manual recording full acceptance or P5 completion. Previous v2 invalid-environment logs remain unchanged and do not characterize this candidate. Fast runner automatic retry/skip statistics are retained in raw logs.'}
 report['pointerSubtypeNativeCases']=pointer_cases;report['pressureAssociationRefused']=pointer_native['pressure_association_refused'];report['pointerSubtypeNativePythonParity']=pointer_parity;save('report.json',report);print('OFFLINE V5 ALL PASS',flush=True)
except BaseException as e:
 traceback.print_exc();
 try:check('failure-final')
 except BaseException:traceback.print_exc()
 save('report.json',{'schemaVersion':1,'reviewer':'/root/p5_acceptance','at':stamp(),'status':'failed_or_blocked','error':repr(e),'steps':STEPS,'nativeAssertions':NATIVE,'checkpoints':CHECKS,'artifacts':ARTIFACTS,'manualRetries':0,'pending':['All remaining commands were not run; do not infer GUI or full manual acceptance']})
 raise
