import copy,json
from unittest.mock import patch
from ai_computer_control.utils import macos_recording as r
from ai_computer_control.utils.macos import DesktopError
events=[{'type': 'mouse_down', 'at_us': 0, 'flags': 0, 'x': 25, 'y': 35, 'button': 0, 'click_state': 1, 'pressure': 1, 'delta_x': 0, 'delta_y': 0, 'source_subtype': 3, 'associated_events_mask': 17179869254}, {'type': 'mouse_up', 'at_us': 20, 'flags': 0, 'x': 25, 'y': 35, 'button': 0, 'click_state': 1, 'pressure': 0, 'delta_x': 0, 'delta_y': 0, 'source_subtype': 3, 'associated_events_mask': 17179869254}]
source={'id':'com.apple.keylayout.ABC','type':'TISTypeKeyboardLayout'}
bounds={'x':0,'y':0,'width':100,'height':100}
doc={'schema':3,'pointer_profile':'standard_mouse','replay_scope':'keyboard_and_standard_mouse','platform':'darwin','coordinate_space':'macos_global_points','source':'native_window_events','complete':True,'end_reason':'stopped','application':{'executable':'/owned/Fixture','bundle_id':''},'bounds':bounds,'input_source':source,'actions':[{'op':'input.sequence','at':0,'ended':.1,'events':events}]}
cases=[('schema3-valid',copy.deepcopy(doc),True)]
def add(name,change):
 x=copy.deepcopy(doc);change(x);cases.append((name,x,False))
add('schema2-downgrade',lambda x:(x.update(schema=2),x.pop('pointer_profile'),x.pop('replay_scope')))
add('schema3-missing-profile',lambda x:x.pop('pointer_profile'))
add('schema3-wrong-profile',lambda x:x.update(pointer_profile='exact'))
add('schema3-wrong-scope',lambda x:x.update(replay_scope='exact'))
add('schema3-bool-schema',lambda x:x.update(schema=True))
add('manual-action-standard-override',lambda x:x['actions'][0].update(pointer_profile='standard_mouse'))
add('manual-action-exact-override',lambda x:x['actions'][0].update(pointer_profile='exact'))
controlled=copy.deepcopy(doc);controlled.update(schema=1,source='controlled_native_requests');controlled.pop('pointer_profile');controlled.pop('replay_scope');controlled.pop('input_source');controlled['actions'][0].update(pointer_profile='standard_mouse',input_source=source);cases.append(('schema1-cannot-upgrade-action',controlled,False))
legacy=copy.deepcopy(doc);legacy.update(schema=2);legacy.pop('pointer_profile');legacy.pop('replay_scope');legacy['actions'][0]['events']=[{k:v for k,v in event.items() if k not in ('source_subtype','associated_events_mask')} for event in events];cases.append(('schema2-exact-still-valid',legacy,True))
legacy1=copy.deepcopy(legacy);legacy1.update(schema=1,source='controlled_native_requests');legacy1.pop('input_source');legacy1['actions'][0]['input_source']=source;cases.append(('schema1-exact-still-valid',legacy1,True))
results=[]
for name,item,accepted in cases:
 original=copy.deepcopy(item)
 with patch.object(r,'request',return_value={'target':{'bounds':bounds},'application':doc['application']}) as native:
  try:
   steps=r.prepare_recording(item,{'bounds':bounds});ok=True;code=None
  except DesktopError as error:ok=False;code=error.code
  assert ok is accepted,name
  assert native.call_count==(1 if accepted else 0),name
  assert item==original,name
  if name=='schema3-valid':
   assert native.call_args.args[0]['pointer_profile']=='standard_mouse'
   assert steps[0]['args']['pointer_profile']=='standard_mouse'
   assert steps[0]['args']['events']==events
  results.append({'name':name,'accepted':ok,'code':code,'nativeCalls':native.call_count})
print(json.dumps(results))
