import datetime,hashlib,json,os,pathlib,re,subprocess,tempfile,time,traceback
ROOT=pathlib.Path('/tmp/ruyi-p5-manual-worktree')
OUT=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac/MACOS-PORTING/evidence/P5/manual/independent-offline-v2')
FREEZE=OUT.parent/'development/sequence/current-source-v2.json'
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
 base=OUT/'isolation'/name
 mapping={'HOME':'home','USERPROFILE':'userprofile','APPDATA':'appdata','LOCALAPPDATA':'localappdata','WCW_DATA_DIR':'wcw-data','RUYI_HOME':'ruyi-home','WIN_CLAUDE_WORKBENCH_HOME':'win-claude-home','TMPDIR':'tmp'}
 vals={k:str(base/v) for k,v in mapping.items()}
 for v in vals.values():pathlib.Path(v).mkdir(parents=True,exist_ok=True)
 vals.update({'DYLD_FRAMEWORK_PATH':'/Users/jiming/.local/esp-runtimes','DYLD_LIBRARY_PATH':'/Users/jiming/.local/esp-runtimes/Python.framework/Versions/3.12/lib','PYTHONPATH':str(ROOT/'mcp/ai-computer-control/src'),'PYTHONDONTWRITEBYTECODE':'1','RUYI_MACOS_AUTOMATION_HELPER':str(base/'absent-native-helper'),'ACC_HIDE_TOOLS':'','PYTHONUNBUFFERED':'1'})
 assert not pathlib.Path(vals['RUYI_MACOS_AUTOMATION_HELPER']).exists()
 env=os.environ.copy();env.update(vals);return env,vals

def run(name,cmd,timeout=180,cwd=ROOT,request=None):
 check(name+'-before'); env,vals=environment(name); log=OUT/(name+'.txt')
 assert not log.exists(), 'Command already attempted: '+name
 started=stamp();start=time.monotonic()
 with log.open('wb') as f:
  p=subprocess.run(cmd,cwd=str(cwd),env=env,input=json.dumps(request).encode() if request is not None else None,stdout=f,stderr=subprocess.STDOUT,timeout=timeout)
 row={'name':name,'command':cmd,'cwd':str(cwd),'startedAt':started,'elapsedSeconds':round(time.monotonic()-start,3),'exitCode':p.returncode,'environment':vals,'request':request,'log':str(log),'logDigest':digest(log)}
 STEPS.append(row);save('steps.json',STEPS);check(name+'-after')
 print(json.dumps({'step':name,'exit':p.returncode,'seconds':row['elapsedSeconds']}),flush=True)
 assert p.returncode==0,'Nonzero exit: '+name
 return log.read_text(errors='replace'),row

def native(name,helper,request,predicate):
 output,row=run(name,[str(helper)],request={'version':1,**request})
 result=json.loads(output);row['nativeResult']=result;assert predicate(result),'Native assertion failed '+name+': '+output
 save('steps.json',STEPS);return result

def assertion(name,condition):
 NATIVE.append({'assertion':name,'passed':bool(condition)});save('native-assertions.json',NATIVE)
 assert condition,'Native assertion failed '+name
 print('PASS '+name,flush=True)

try:
 check('initial')
 outdir=pathlib.Path(tempfile.mkdtemp(prefix='owned-helpers-',dir=OUT)); normal=outdir/'normal-helper';testing=outdir/'testing-helper'
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
 for suite,count in [('smoke_audit_cancellation',12),('smoke_macos_record',31),('smoke_macos_sequence',16),('smoke_macos_composed',16),('smoke_macos_visual',25),('smoke_macos_capture',13),('smoke_macos_shared',8),('smoke_macos_input',21),('smoke_macos_events',16),('smoke_macos_ax',8)]:
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
 report={'schemaVersion':1,'reviewer':'/root/p5_acceptance','at':stamp(),'status':'passed_offline_subset','scope':'Independent v2 offline subset only; no GUI, default helper/App rebuild or system setting mutations. Native fixtures are memory-only with fake held state and no down/up posts.','freezePath':str(FREEZE),'freezeSha256':FREEZE_SHA,'frozenFiles':34,'checkpoints':len(CHECKS),'allSourceChecksMatched':all(c['allMatched'] and c['freezeUnchanged'] for c in CHECKS),'manualRetries':0,'nativeAssertions':NATIVE,'artifacts':ARTIFACTS,'steps':STEPS,'pythonTests':sum(s.get('tests',0) or 0 for s in STEPS),'pythonSkipped':sum(s.get('skipped',0) for s in STEPS),'pending':['Expanded real GUI manual E2E','Real Ruyi App manual chain','Physical human input','Original P5 remaining audit and external gates'],'limitations':'These results do not establish manual recording full acceptance or P5 completion. Fast runner may automatically retry; actual retry/skip summary is retained in the step logs and report.'}
 save('report.json',report);print('OFFLINE V2 ALL PASS',flush=True)
except BaseException as e:
 traceback.print_exc();
 try:check('failure-final')
 except BaseException:traceback.print_exc()
 save('report.json',{'schemaVersion':1,'reviewer':'/root/p5_acceptance','at':stamp(),'status':'failed_or_blocked','error':repr(e),'steps':STEPS,'nativeAssertions':NATIVE,'checkpoints':CHECKS,'artifacts':ARTIFACTS,'manualRetries':0,'pending':['All remaining commands were not run; do not infer GUI or full manual acceptance']})
 raise
