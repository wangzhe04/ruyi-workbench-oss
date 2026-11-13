import pathlib,subprocess,json,hashlib,datetime,traceback
R=pathlib.Path('/Users/jiming/Documents/ruyi-workbench-mac');O=pathlib.Path(__file__).resolve().parent;F=json.loads((O/'frozen-sources.json').read_text());P=json.loads((O/'finder-preflight.json').read_text());B=json.loads((O/'observer-binding.json').read_text());child=None;code=None;result=None;error=None
command=['/usr/bin/python3',str(O/'observer.py'),'finder',str(O/'finder')]
def dg(p):
 b=pathlib.Path(p).read_bytes();return {'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def save(n,x):(O/n).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def check():
 assert all(dg(R/x['path'])=={'bytes':x['bytes'],'sha256':x['sha256']} for x in F),'source drift'
 assert dg(O/'observer.py')=={k:v for k,v in B['independentCopy'].items() if k!='path'},'observer drift'
 assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=R,text=True).strip()==P['head'],'HEAD drift'
try:
 check();assert not (O/'finder').exists(),'refuse Finder retry'
 with (O/'finder-outer.txt').open('wb') as log:
  child=subprocess.Popen(command,cwd=R,stdout=log,stderr=subprocess.STDOUT)
  save('finder-dispatch.json',{'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'executor':'/root/p5_acceptance','argv':command,'pid':child.pid,'attempt':1,'policy':'First unexpected failure stops; no retry.'})
  code=child.wait()
 result=json.loads((O/'finder/report.json').read_text());assert code==0 and result['passed'] and result['pass']==10 and result['fail']==result['skip']==0,'Finder case failed'
 assert json.loads((O/'finder/source-before.json').read_text())==F==json.loads((O/'finder/source-after.json').read_text()),'Finder source mismatch';check()
except BaseException as exc:
 error=repr(exc);traceback.print_exc()
finally:
 save('finder-independent-run.json',{'schemaVersion':1,'executor':'/root/p5_acceptance','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'passed_independent_finder_current_host' if error is None and result else 'failed_or_blocked_independent_finder','head':P['head'],'exitCode':code,'result':result,'error':error,'independentFinderInvocations':1 if child else 0,'manualRetries':0,'preconditionChange':P['changedPrecondition'],'priorFailureRetained':True,'GUIReleased':bool(result and not result['childStillRunning'] and result['remainingObservedIdentities']==[]),'scope':'One independent current-helper Finder owned-window scenario after the user closed pre-existing Finder content windows. No default/renderer/core/manual/engineering rerun.','phaseStatus':'in_progress'})
 print(json.dumps({'status':'passed_independent_finder_current_host' if error is None else 'failed_or_blocked_independent_finder','exitCode':code,'pass':result['pass'] if result else None,'error':error}),flush=True)
if error is not None:raise SystemExit(1)
