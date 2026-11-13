import copy,datetime,hashlib,json,os,pathlib,re,struct,subprocess,tempfile,time,traceback
ROOT=pathlib.Path('/tmp/ruyi-p5-touch-worktree');OUT=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac/MACOS-PORTING/evidence/P5/manual/standard-mouse/independent-offline-v1');FREEZE=OUT.parent/'freeze-v1.json';NODE='/Users/jiming/.local/bin/node';PYTHON='/Users/jiming/Documents/ruyi-workbench-mac/mcp/ai-computer-control/.venv/bin/python'
DATA=json.loads(FREEZE.read_text());STEPS=[];CHECKS=[];ARTIFACTS=[];CONTRACTS={}
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def digest(p):
 b=pathlib.Path(p).read_bytes();return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def save(n,o):(OUT/n).write_text(json.dumps(o,indent=2)+'\n')
FREEZE_SHA=digest(FREEZE)['sha256']
def check(label):
 rows=[{'path':p,'expected':e,'actual':digest(ROOT/p)} for p,e in DATA['files'].items()]
 for r in rows:r['matched']=r['actual']==r['expected']
 c={'label':label,'at':now(),'count':len(rows),'files':rows,'allMatched':all(r['matched'] for r in rows),'freezeUnchanged':digest(FREEZE)['sha256']==FREEZE_SHA};CHECKS.append(c);save('source-checks.json',CHECKS)
 assert c['count']==34 and c['allMatched'] and c['freezeUnchanged'],'Source freeze drift'
def environment():
 base=pathlib.Path(tempfile.mkdtemp(dir='/tmp',prefix='ruyi-sm1-'));p=subprocess.run(['git','-C',str(base),'rev-parse','--show-toplevel'],capture_output=True);assert p.returncode==128
 vals={k:str(base/v) for k,v in [('HOME','h'),('USERPROFILE','u'),('APPDATA','a'),('LOCALAPPDATA','l'),('WCW_DATA_DIR','w'),('RUYI_HOME','r'),('WIN_CLAUDE_WORKBENCH_HOME','c'),('TMPDIR','t')]}
 for v in vals.values():pathlib.Path(v).mkdir()
 vals.update({'RUYI_MACOS_AUTOMATION_HELPER':str(base/'absent-helper'),'DYLD_FRAMEWORK_PATH':'/Users/jiming/.local/esp-runtimes','DYLD_LIBRARY_PATH':'/Users/jiming/.local/esp-runtimes/Python.framework/Versions/3.12/lib','PYTHONPATH':str(ROOT/'mcp/ai-computer-control/src'),'PYTHONDONTWRITEBYTECODE':'1','PYTHONUNBUFFERED':'1'})
 env=os.environ.copy();env.pop('RUYI_TEST_SESSION_MONITOR_FAILURE',None);env.update(vals);return env,vals

def execute(name,cmd,expected=0,payload=None,cwd=ROOT):
 check(name+'-before');env,vals=environment();log=OUT/(name+'.txt');assert not log.exists(),'Refuse repeated case '+name;start=time.monotonic();began=now()
 with log.open('wb') as f:p=subprocess.run(cmd,cwd=cwd,env=env,input=payload,stdout=f,stderr=subprocess.STDOUT,timeout=900)
 row={'name':name,'command':cmd,'cwd':str(cwd),'startedAt':began,'elapsedSeconds':round(time.monotonic()-start,3),'exitCode':p.returncode,'expectedExitCode':expected,'environment':vals,'tmpdirPathBytes':len(os.fsencode(vals['TMPDIR'])),'log':str(log),'logDigest':digest(log)}
 STEPS.append(row);save('steps.json',STEPS);check(name+'-after');print(json.dumps({'case':name,'exit':p.returncode,'expected':expected,'seconds':row['elapsedSeconds']}),flush=True);assert p.returncode==expected,'Unexpected exit '+name
 return log.read_text(errors='replace'),row

def native(name,helper,op,args=None,accepted=True):
 request={'version':1,'op':op,**(args or {})};text,row=execute(name,[str(helper)],0 if accepted else 1,json.dumps(request).encode());result=json.loads(text);row['request']=request;row['response']=result;save('steps.json',STEPS)
 assert result.get('ok') is accepted and (accepted or result.get('code')=='invalid_args'),'Native response '+name
 return result

def pointer(kind='move',at=0,**fields):return {'type':kind,'at_us':at,'flags':0,'x':25,'y':35,'button':0,'click_state':1,'pressure':1 if kind in ('mouse_down','drag') else 0,'delta_x':0,'delta_y':0,**fields}
def pair(**fields):return [pointer('mouse_down',**fields),pointer('mouse_up',20,**fields)]
try:
 check('initial');assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()==DATA['baseCommit']
 original_product=digest(DATA['product']['helper']['path']);assert original_product=={k:DATA['product']['helper'][k] for k in ['bytes','sha256']}
 buildroot=pathlib.Path(tempfile.mkdtemp(dir='/tmp',prefix='ruyi-sm1-build-'));production=buildroot/'production-helper';testing=buildroot/'testing-helper'
 for mode,path in [('production',production),('testing',testing)]:
  code="const b=require('./ruyi-workbench/tools/build-macos-automation-helper');console.log(b.buildMacAutomationHelper({output:"+json.dumps(str(path))+",testing:"+str(mode=='testing').lower()+"}));"
  execute('build-'+mode,[NODE,'-e',code]);ARTIFACTS.append({'mode':mode,'path':str(path),**digest(path)})
 save('artifacts.json',ARTIFACTS)
 allocation=native('native-owned-release',testing,'test_release_allocation');assert all(allocation[k] is True for k in ['cleanup_refused','ownership_retained','permission_ownership_retained','cross_tool_blocked']);CONTRACTS['releaseAllocation']=allocation
 stopped=native('native-stopped-mutations',testing,'test_stopped_mutations');assert len(stopped['results'])==18 and all(x['result']['ok'] is False and x['result']['action_sent'] is False and x['result']['outcome']=='not_dispatched' for x in stopped['results']);CONTRACTS['stoppedMutations']=stopped
 exact=native('native-exact-subtypes',testing,'test_pointer_subtypes');types=[1,2,3,4,5,6,7,25,26,27]
 assert len(exact['cases'])==50 and {(x['subtype'],x['type']) for x in exact['cases']}=={(s,t) for s in range(5) for t in types} and all(x['matched'] is True for x in exact['cases'])
 assert type(exact['pressure_association_refused']) in (bool,int) and exact['pressure_association_refused']==1
 projection=native('native-standard-projection',testing,'test_pointer_projection');assert len(projection['cases'])==20 and {(x['subtype'],x['type']) for x in projection['cases']}=={(s,t) for s in [0,3] for t in types}
 for case in projection['cases']:
  assert case['matched'] is True and not case.get('failure');row=case['row'];assert row.get('subtype',0)==0 and row['pressure']==(1 if row['type'] in ('mouse_down','drag') else 0)
  assert row.get('source_subtype',0)==case['subtype'] and row['button']==(2 if case['type']>=25 else 1 if case['type'] in [3,4,7] else 0)
  if row['type']=='move':assert 'associated_events_mask' not in row
  else:assert type(row['associated_events_mask']) is int and row['associated_events_mask']&(1<<34)
 CONTRACTS.update({'exact':exact,'standardProjection':projection})
 for op in ['test_release_allocation','test_stopped_mutations','test_validate_sequence','test_stall_sequence','test_pointer_subtypes','test_pointer_projection']:
  native('production-excludes-'+op,production,op,accepted=False)
 mask=(1<<34)|70;allowed=sum(1<<x for x in [1,2,3,4,5,6,7,25,26,27,34]);cases=[]
 def add(label,events,profile,accepted):cases.append({'label':label,'events':events,'pointer_profile':profile,'expectedAccepted':accepted})
 base=pair(source_subtype=3,associated_events_mask=mask)
 add('standard-base',base,'standard_mouse',True);add('standard-no-provenance',pair(),'standard_mouse',True)
 for label,value,accepted in [('zero',0,True),('all-allowed',allowed,True),('float',float(mask),False),('true',True,False),('false',False,False),('null',None,False),('string','70',False),('negative',-1,False),('unknown-bit',1,False),('unknown-high',1<<35,False),('unsafe-range',1<<53,False),('max-json',9007199254740991,False)]:
  add('mask-'+label,pair(associated_events_mask=value),'standard_mouse',accepted)
 for label,profile in [('exact','exact'),('none',None),('unknown','standard'),('true',True),('false',False),('number',0),('list',[]),('dict',{})]:add('profile-'+label,base,profile,False)
 for label,value,accepted in [('zero',0,True),('touch',3,True),('float-touch',3.0,True),('tablet',1,False),('proximity',2,False),('unknown',4,False),('negative',-1,False),('true',True,False),('false',False,False),('null',None,False),('string','3',False),('fraction',3.5,False)]:add('source-subtype-'+label,pair(source_subtype=value),'standard_mouse',accepted)
 for label,value,accepted in [('zero',0,True),('float-zero',0.0,True),('touch',3,False),('tablet',1,False),('unknown',4,False),('true',True,False),('false',False,False),('null',None,False),('string','0',False)]:add('canonical-subtype-'+label,pair(subtype=value),'standard_mouse',accepted)
 for label,value in [('half',.5),('zero',0),('true',True),('null',None)]:add('down-pressure-'+label,[pointer('mouse_down',pressure=value),pointer('mouse_up',20)],'standard_mouse',False)
 add('up-pressure-one',[pointer('mouse_down'),pointer('mouse_up',20,pressure=1)],'standard_mouse',False)
 add('move-pressure-one',[pointer(pressure=1)],'standard_mouse',False);add('move-mask-zero',[pointer(associated_events_mask=0)],'standard_mouse',False)
 add('move-source-touch',[pointer(source_subtype=3)],'standard_mouse',True)
 add('drag-canonical',[pointer('mouse_down'),pointer('drag',10),pointer('mouse_up',20)],'standard_mouse',True)
 add('drag-wrong-pressure',[pointer('mouse_down'),pointer('drag',10,pressure=.5),pointer('mouse_up',20)],'standard_mouse',False)
 add('exact-legacy-pressure',[pointer('mouse_down',pressure=.5),pointer('mouse_up',20,pressure=.5)],'exact',True)
 add('exact-source-metadata',pair(source_subtype=0),'exact',False);add('exact-associated-zero',pair(associated_events_mask=0),'exact',False)
 for case in cases:
  answer=native('matrix-'+case['label'],testing,'test_validate_sequence',{'events':case['events'],'pointer_profile':case['pointer_profile']},case['expectedAccepted']);case['nativeAccepted']=answer['ok'];case['nativeCode']=answer.get('code')
 save('field-matrix-input.json',cases)
 parity=OUT/'python-field-parity.py';parity.write_text("import json,pathlib\nfrom ai_computer_control.utils.macos_sequence import validate_events\nfrom ai_computer_control.utils.macos import DesktopError\nrows=json.loads(pathlib.Path(__file__).with_name('field-matrix-input.json').read_text())\nfor row in rows:\n try:\n  validate_events(row['events'],pointer_profile=row['pointer_profile']);row['pythonAccepted']=True;row['pythonCode']=None\n except DesktopError as error:\n  row['pythonAccepted']=False;row['pythonCode']=error.code\n assert row['pythonAccepted'] is row['nativeAccepted'] is row['expectedAccepted'],row['label']\n assert row['pythonCode']==row['nativeCode'],row['label']\nprint(json.dumps(rows))\n")
 text,_=execute('python-field-parity',[PYTHON,str(parity)]);CONTRACTS['fieldMatrix']=json.loads(text);save('field-native-python-parity.json',CONTRACTS['fieldMatrix'])
 # Safe production whole-document preflight errors. No source or target is supplied,
 # so the distinct action-override error must occur before desktop target checks.
 keyrows=[{'type':'key_down','at_us':0,'flags':0,'keycode':0,'keyboard_type':91,'repeat':0},{'type':'key_up','at_us':10,'flags':0,'keycode':0,'keyboard_type':91,'repeat':0}]
 native_preflights=[]
 for label,outer,inner in [('omitted-root',None,'standard_mouse'),('exact-root','exact','standard_mouse'),('standard-root','standard_mouse','exact')]:
  request={'version':1,'id':1,'op':'record.target','target':{},'actions':[{'op':'input.sequence','events':keyrows},{'op':'input.sequence','events':keyrows,'pointer_profile':inner}]}
  if outer is not None:request['pointer_profile']=outer
  text,row=execute('native-action-override-'+label,[str(production),'--input-session'],0,(json.dumps(request)+'\n').encode());answer=json.loads(text);assert answer.get('ok') is False and answer.get('code')=='invalid_args' and answer.get('error')=='An action cannot override the recording pointer profile'
  native_preflights.append({'request':request,'response':answer,'sessionExitCode':row['exitCode'],'scope':'Error response on healthy JSONL session; no target lookup or input dispatch'})
 CONTRACTS['nativeWholePreflight']=native_preflights
 # Independent document-level acceptance and downgrade checks, all native requests mocked.
 schema=OUT/'python-schema-contracts.py';schema.write_text("import copy,json\nfrom unittest.mock import patch\nfrom ai_computer_control.utils import macos_recording as r\nfrom ai_computer_control.utils.macos import DesktopError\nevents="+repr(base)+"\nsource={'id':'com.apple.keylayout.ABC','type':'TISTypeKeyboardLayout'}\nbounds={'x':0,'y':0,'width':100,'height':100}\ndoc={'schema':3,'pointer_profile':'standard_mouse','replay_scope':'keyboard_and_standard_mouse','platform':'darwin','coordinate_space':'macos_global_points','source':'native_window_events','complete':True,'end_reason':'stopped','application':{'executable':'/owned/Fixture','bundle_id':''},'bounds':bounds,'input_source':source,'actions':[{'op':'input.sequence','at':0,'ended':.1,'events':events}]}\ncases=[('schema3-valid',copy.deepcopy(doc),True)]\ndef add(name,change):\n x=copy.deepcopy(doc);change(x);cases.append((name,x,False))\nadd('schema2-downgrade',lambda x:(x.update(schema=2),x.pop('pointer_profile'),x.pop('replay_scope')))\nadd('schema3-missing-profile',lambda x:x.pop('pointer_profile'))\nadd('schema3-wrong-profile',lambda x:x.update(pointer_profile='exact'))\nadd('schema3-wrong-scope',lambda x:x.update(replay_scope='exact'))\nadd('schema3-bool-schema',lambda x:x.update(schema=True))\nadd('manual-action-standard-override',lambda x:x['actions'][0].update(pointer_profile='standard_mouse'))\nadd('manual-action-exact-override',lambda x:x['actions'][0].update(pointer_profile='exact'))\ncontrolled=copy.deepcopy(doc);controlled.update(schema=1,source='controlled_native_requests');controlled.pop('pointer_profile');controlled.pop('replay_scope');controlled.pop('input_source');controlled['actions'][0].update(pointer_profile='standard_mouse',input_source=source);cases.append(('schema1-cannot-upgrade-action',controlled,False))\nlegacy=copy.deepcopy(doc);legacy.update(schema=2);legacy.pop('pointer_profile');legacy.pop('replay_scope');legacy['actions'][0]['events']=[{k:v for k,v in event.items() if k not in ('source_subtype','associated_events_mask')} for event in events];cases.append(('schema2-exact-still-valid',legacy,True))\nlegacy1=copy.deepcopy(legacy);legacy1.update(schema=1,source='controlled_native_requests');legacy1.pop('input_source');legacy1['actions'][0]['input_source']=source;cases.append(('schema1-exact-still-valid',legacy1,True))\nresults=[]\nfor name,item,accepted in cases:\n original=copy.deepcopy(item)\n with patch.object(r,'request',return_value={'target':{'bounds':bounds},'application':doc['application']}) as native:\n  try:\n   steps=r.prepare_recording(item,{'bounds':bounds});ok=True;code=None\n  except DesktopError as error:ok=False;code=error.code\n  assert ok is accepted,name\n  assert native.call_count==(1 if accepted else 0),name\n  assert item==original,name\n  if name=='schema3-valid':\n   assert native.call_args.args[0]['pointer_profile']=='standard_mouse'\n   assert steps[0]['args']['pointer_profile']=='standard_mouse'\n   assert steps[0]['args']['events']==events\n  results.append({'name':name,'accepted':ok,'code':code,'nativeCalls':native.call_count})\nprint(json.dumps(results))\n")
 text,_=execute('python-schema-contracts',[PYTHON,str(schema)]);CONTRACTS['schemaContracts']=json.loads(text);save('schema-contracts.json',CONTRACTS['schemaContracts']);save('native-contracts.json',CONTRACTS)
 for name,count in [('smoke_audit_cancellation',12),('smoke_macos_record',31),('smoke_macos_sequence',20),('smoke_macos_composed',16),('smoke_macos_visual',25),('smoke_macos_capture',13),('smoke_macos_shared',8),('smoke_macos_input',21),('smoke_macos_events',16),('smoke_macos_ax',8)]:
  text,row=execute(name,[PYTHON,str(ROOT/'mcp/ai-computer-control/tests'/(name+'.py'))],cwd=ROOT/'mcp/ai-computer-control');m=re.search(r'^Ran (\d+) tests? in',text,re.M);row['tests']=int(m.group(1)) if m else None;row['skipped']=len(re.findall(r'\.\.\. skipped ',text));row['unittestOK']=bool(re.search(r'^OK$',text,re.M));save('steps.json',STEPS);assert row['tests']==count and row['skipped']==0 and row['unittestOK'],'Smoke result '+name
 for name,command in [('syntax',[NODE,'dev-harness/syntax-gate.js']),('build-check',[NODE,'ruyi-workbench/app/build.js','--check']),('fullunit',[NODE,'--test','dev-harness/unit/*.test.js']),('fast',[NODE,'dev-harness/run-all.js','--fast'])]:
  text,row=execute(name,command)
  if name=='fullunit':row['counts']={k:int(re.search(r'^ℹ '+k+r' (\d+)$',text,re.M).group(1)) for k in ['tests','suites','pass','fail','cancelled','skipped','todo']}
  if name=='fast':
   m=re.search(r'^# 汇总: (\d+) pass / (\d+) fail / (\d+) known-fail / (\d+) unexpected-pass / (\d+) flaky / (\d+) ran / (\d+) skipped',text,re.M);assert m;row['counts']=dict(zip(['pass','fail','knownFail','unexpectedPass','flaky','ran','skipped'],map(int,m.groups())));row['retryLines']=[s for s in text.splitlines() if '[retry]' in s or '[flaky:' in s]
  save('steps.json',STEPS)
 check('final')
 report={'schemaVersion':1,'reviewer':'/root/p5_acceptance','at':now(),'status':'passed_standard_mouse_v1_offline_subset','worktree':str(ROOT),'freezePath':str(FREEZE),'freezeSha256':FREEZE_SHA,'frozenFiles':34,'checkpoints':len(CHECKS),'allSourceChecksMatched':all(c['allMatched'] and c['freezeUnchanged'] for c in CHECKS),'artifacts':ARTIFACTS,'declaredDevelopmentProductObservedBeforeRun':{'path':DATA['product']['helper']['path'],**original_product},'steps':STEPS,'contracts':CONTRACTS,'newScenarioInvocations':len(STEPS),'expectedOneShotNegativeExits':sum(s['expectedExitCode']==1 for s in STEPS),'unexpectedExitCodes':sum(s['exitCode']!=s['expectedExitCode'] for s in STEPS),'manualRetries':0,'pythonSmokeTests':sum(s.get('tests',0) or 0 for s in STEPS),'pythonSmokeSkipped':sum(s.get('skipped',0) for s in STEPS),'scope':DATA['scope'],'limitations':['No GUI, App or physical input demonstration by this reviewer','Pressure stages are neither captured nor replayed; automatic pressure gesture detection is not promised and no global pressure monitor is tested','source_subtype and associated_events_mask are provenance only; canonical ordinary mouse projection is explicit schema3 standard_mouse scope','Actual active controlled-recording profile mismatch requires the later owned live GUI chain; only the source branch and pure document/native override refusal were reviewed here','Original P5 remaining audit/environment gates persist'],'phaseStatus':'in_progress','claim':'Offline profile, projection, strict validation, schema boundaries and engineering checks pass within this frozen candidate. This does not release the entire P5 phase or establish unsupported pressure semantics.'}
 save('report.json',report);print('STANDARD MOUSE V1 OFFLINE PASS',flush=True)
except BaseException as error:
 traceback.print_exc()
 try:check('failure-final')
 except BaseException:traceback.print_exc()
 save('report.json',{'schemaVersion':1,'reviewer':'/root/p5_acceptance','at':now(),'status':'failed_or_blocked','error':repr(error),'steps':STEPS,'checks':CHECKS,'contracts':CONTRACTS,'artifacts':ARTIFACTS,'phaseStatus':'in_progress','retryPolicy':'Stopped at first unexpected result; no automatic retries.'});raise
