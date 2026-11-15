import pathlib,json,subprocess,hashlib,datetime,traceback
R=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac');O=pathlib.Path(__file__).resolve().parent;E=O.parent;PYTHON='/usr/bin/python3';runs=[];error=None
F=json.loads((O/'frozen-sources.json').read_text());P=json.loads((O/'preflight.json').read_text());B=json.loads((O/'observer-binding.json').read_text())
def dg(p):
 b=pathlib.Path(p).read_bytes();return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def save(n,x):(O/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def check():
 assert all(dg(R/x['path'])=={'bytes':x['bytes'],'sha256':x['sha256']} for x in F),'frozen source drift'
 assert dg(O/'observer.py')=={k:v for k,v in B['independentCopy'].items() if k!='path'},'observer drift'
 assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=R,text=True).strip()==P['head'],'HEAD drift'
try:
 for case,expected in [('default',31),('renderer',33)]:
  check();dest=O/case;assert not dest.exists(),'refuse retry'
  with (O/(case+'-outer.txt')).open('wb') as log:
   p=subprocess.Popen([PYTHON,str(O/'observer.py'),case,str(dest)],cwd=R,stdout=log,stderr=subprocess.STDOUT)
   save(case+'-dispatch.json',{'executor':'/root/p5_acceptance','pid':p.pid,'argv':p.args,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
   code=p.wait()
  result=json.loads((dest/'report.json').read_text());runs.append({'case':case,'outerExitCode':code,'report':str(dest/'report.json'),'reportDigest':dg(dest/'report.json'),'result':result});save('results.json',runs)
  print(json.dumps({'case':case,'outerExitCode':code,'status':result['status'],'pass':result['pass'],'fail':result['fail'],'skip':result['skip']}),flush=True)
  assert code==0 and result['passed'] and result['executor']=='/root/p5_acceptance' and result['pass']==expected,'case failed; later stages stopped'
  assert json.loads((dest/'source-before.json').read_text())==F==json.loads((dest/'source-after.json').read_text()),'case source mismatch'
  check()
except BaseException as exc:
 error=repr(exc);traceback.print_exc()
finally:
 finalSourceMatch=all(dg(R/x['path'])=={'bytes':x['bytes'],'sha256':x['sha256']} for x in F)
 report={'schemaVersion':1,'executor':'/root/p5_acceptance','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'passed_independent_default_renderer' if error is None and len(runs)==2 and finalSourceMatch else 'failed_or_blocked_independent_selected_cases','head':P['head'],'productionImplementation':P['productionImplementation'],'sourceCount':len(F),'sourceMatchesPreflightAfterAllCases':finalSourceMatch,'runs':runs,'error':error,'independentInvocations':{x['case']:1 for x in runs},'manualRetries':0,'finderRun':False,'finderStatus':'blocked_existing_user_content_window; not retried by independent executor','scope':'Independent execution by /root/p5_acceptance of current-helper selected TextEdit and CFT default/renderer scenes. Actual native helper bytes are retained outside Git and compared to default1cc excluding only UUID/signature. Wrapper executor/status labels were changed and exact diff retained. No full core/manual/engineering reruns, Finder, App-origin AX route, TCC revoke, OS lock or external environment acceptance.','GUIReleased':not any(x['result']['childStillRunning'] or x['result']['remainingObservedIdentities'] is None or x['result']['remainingObservedIdentities'] for x in runs),'phaseStatus':'in_progress'}
 save('report.json',report);print(report['status'],flush=True)
if error is not None:raise SystemExit(1)
