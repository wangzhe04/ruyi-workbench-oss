import json,pathlib
from ai_computer_control.utils.macos_sequence import validate_events
from ai_computer_control.utils.macos import DesktopError
rows=json.loads(pathlib.Path(__file__).with_name('field-matrix-input.json').read_text())
for row in rows:
 try:
  validate_events(row['events'],pointer_profile=row['pointer_profile']);row['pythonAccepted']=True;row['pythonCode']=None
 except DesktopError as error:
  row['pythonAccepted']=False;row['pythonCode']=error.code
 assert row['pythonAccepted'] is row['nativeAccepted'] is row['expectedAccepted'],row['label']
 assert row['pythonCode']==row['nativeCode'],row['label']
print(json.dumps(rows))
