"""Verify copied license bytes against their pinned wheel members; no execution."""
import hashlib,json,pathlib,zipfile
root=pathlib.Path(__file__).resolve().parents[2]
directory=root/'output/m4-license-review-20261117-r1'
raw=(directory/'freeze.json').read_bytes()
pin='17ce0145bef17fce7140ecc4655316760e2e825cd5721c698916fdd3a65a6add'
assert hashlib.sha256(raw).hexdigest()==pin
freeze=json.loads(raw)
assert len(freeze['bindings'])==69
for row in freeze['bindings']:
    data=pathlib.Path(row['path']).read_bytes()
    assert len(data)==row['bytes'] and hashlib.sha256(data).hexdigest()==row['sha256']
review=json.loads((directory/'component-license-review.json').read_bytes())
assert len(review['components'])==21
verified_wheels=set(); count=0; copies=set()
for component in review['components']:
    for row in component['pinnedWheelNotices']:
        wheel=pathlib.Path(row['wheelPath'])
        if str(wheel) not in verified_wheels:
            h=hashlib.sha256()
            with wheel.open('rb') as stream:
                for chunk in iter(lambda:stream.read(1024*1024),b''):h.update(chunk)
            assert h.hexdigest()==row['wheelSha256']
            verified_wheels.add(str(wheel))
        with zipfile.ZipFile(wheel) as archive:
            data=archive.read(row['member'])
        assert len(data)==row['bytes'] and hashlib.sha256(data).hexdigest()==row['sha256']
        assert pathlib.Path(row['reviewCopy']).read_bytes()==data
        copies.add(row['sha256']);count+=1
assert count==69 and len(copies)==62 and len(verified_wheels)==21
result={'status':'ROOT_69_NOTICE_PATHS_62_ORIGINAL_BYTES_MATCH_WHEELS_DRAFT_ONLY','freezeSha256':pin,'bindings':69,'wheelFiles':21,'noticePaths':count,'uniqueNoticeContents':len(copies),'sourceOrBinaryExecuted':False,'licenseClassificationAccepted':False,'redistributionAdmitted':False,'limits':['Exact copied notice bytes only; preliminary classifications, final package contents, native/font obligations and public distribution remain separate.']}
(directory/'root-review.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
print(json.dumps(result))
