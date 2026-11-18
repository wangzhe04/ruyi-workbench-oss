"""Publish exact failed integration outcomes without closing release gates."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'docs/optimization-plan/evidence/semantic-retrieval-20261116'
sha = lambda raw: hashlib.sha256(raw).hexdigest()
load = lambda file: json.loads(file.read_text(encoding='utf-8'))


def save(file, value, exclusive=False):
    with file.open('x' if exclusive else 'w', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def bind(file, expected=None):
    digest = sha(file.read_bytes())
    if expected:
        assert digest == expected
    return {'path': file.relative_to(ROOT).as_posix(), 'sha256': digest}


old = BASE / '3.1-progress-20261118-r3.json'
assert sha(old.read_bytes()) == 'f9e642600fb6ea6c4d947a789169fea35fe20811fc6711a44071ef48bca09e69'
out = BASE / '3.1-progress-20261118-r4.json'
assert not out.exists()
progress = load(old)
now = datetime.now(timezone.utc).isoformat()
progress.update(updatedAt=now, status='PRE_RC_GENERATION_ROOT_ACCESS_AND_M5_HEALTH_BLOCKERS')
root = ROOT / 'output'
directory = root / 'semantic-export-directory-category-v1/root-review.json'
generation = root / 'semantic-export-generation-category-v1/root-review.json'
m5base = root / 'm5-http-fixed-harness-candidate-20261118-r1'
m5first = m5base / 'actualrun-group-v6/case-output/root-review.json'
m5health = m5base / 'actualrun-group-v8/case-output/root-review.json'
progress['rootEvidence'] += [
    bind(directory, '0cd4479b7a33ba982e7417fff58cb563c590478da4b2fa029fbb832fbaf2830a'),
    bind(generation, 'ef48fca68f9c12c51b154fa65f27b3acdfaaff9a1d5a6c8328272bb6aa126570'),
    bind(m5first, 'a28324cbf1eed012b6d3789b7db5fef09e64d8964165fd9af6b35aa100d286b4'),
    bind(m5health, '50bf4d39edd576f7874e7d825a2f893c0c8156d0a34862ba6e0b1421b5014b4f'),
    bind(m5base / 'actualrun-group-v8/case-output/root-server-startup-error.json'),
    bind(root / 'm5-http-root-v8-preflight-20261118-r1/root-review.json'),
]
capsules = [
    ('s3c-export-directory-reviewed-20261118-r1', '93fb0c3dbbe36862f634a77b0ca69634e470bbb5369fdd3d73ee0c1ccfca271d'),
    ('s3c-export-generation-reviewed-20261118-r1', '6e2072fbca86bd2b10ccbfd148a86683d3d9a22b9b36fbad0f676b3d54e9b6a4'),
    ('s3c-m5-fixed-http-reviewed-20261118-r1', 'a9040873eb0180c5027d05198725af070fc2b357ea703e71f23cab4ea0e8bf5e'),
    ('s3c-m5-health-diagnostic-reviewed-20261118-r1', '7d6295188080a81360c252e783fe060940300eb188ab4766416b61d382ee5e85'),
]
progress['immutableSourceCapsules'] += [bind(BASE / name / 'manifest.json', digest) for name, digest in capsules]
progress['encryptedLifecycle']['diagnostic'].update(
    objectGroup='generation-root', generationRootIdentified=True,
    exactDirectoryOrActorIdentified=False, actorIdentified=False)
progress['encryptedLifecycle']['categoryRuns'] = [
    {'bindings': 694, 'rootPreflightPass': 11, 'group': 'generation-other', 'status': 'FAIL'},
    {'bindings': 701, 'rootPreflightPass': 12, 'group': 'generation-root', 'status': 'FAIL'},
]
progress['encryptedLifecycle']['next'] = 'Distinguish first native, actual Node binding and final native inside the same complete lifecycle; preserve namespace/identity checks and implement actual held-owner access without source flushing or timestamp writeback.'
progress['m5'] = {
    'status': 'ACTUAL_FIXED_GROUP_FAILED_OBSERVER_THEN_ORIGINAL_HEALTH_DEADLINE',
    'firstActual': {'bindings': 293, 'rootMockPass': 17, 'realHttpStackMockPass': 1,
                    'sampleRows': 883, 'uniqueIdentities': 6, 'sampledPairingObserved': True,
                    'controllerReceiptProduced': False, 'failure': 'native identity observer unknown'},
    'secondActual': {'bindings': 293, 'rootMockPass': 21, 'sampleRows': 890,
                     'uniqueIdentities': 6, 'sampledPairingObserved': True,
                     'fixtureExitCode': 1, 'fixtureCloseCode': 1,
                     'stdoutAndStderrEnded': True, 'runnerTimedOut': False,
                     'failure': 'original serve health absolute deadline',
                     'serverErrorCode': 'work_data_setup.native_helper_uncertain',
                     'exactHelperIdentified': False},
    'outerForcedReclaimBoth': True, 'outerActiveAfterReclaimBoth': 0,
    'rootExtraStaticToolFirstFailureRetained': True,
    'rootWrongStreamReviewAssertionRetainedAndCorrectedWithoutNativeRerun': True,
    'humanScope': 'Five types and nine actions remain required; no human actual run yet.',
    'guardFindings': 'DNS/custom lookup/connection override gaps fixed in candidates; server-role deny-all-spawn conflicts with legitimate frozen WorkData native helper dependency. Exact safe helper allowlist remains unimplemented.',
    'wholeHttpFixtureQualified': False, 'realPlatformQualified': False,
    'groupContinuousRevisionProviderQualified': False,
}
save(out, progress, exclusive=True)
review = bind(out)
auditfile = BASE / '3.1-remaining-requirements-audit-20261117.json'
audit = load(auditfile)
audit.update(progressUpdatedAt=now, latestProgressReview=review)
for row in audit['requirements']:
    if row['id'] == 'M3-enable-restore':
        row['gap'] = 'Export fails before capture at held-basic generation-root directory time.access. Triggering access path still unknown; native/Node/final-census phase diagnostic pending. Disable/delete not reached; restore/recovery, special ADS/uploads/portable and independent fresh-source Access remain unqualified.'
    elif row['id'] == 'M5-platform':
        row['evidence'] += ' Two root actual fixed group runs are FAIL: first native identity observer unknown; next original serve-health deadline, sampled identity pairing true but native_helper_uncertain startup error. Both forced Job reclaims observed active0; neither is normal functional closure.'
        row['gap'] = 'Fixed current-source HTTP cannot reach server health yet; legitimate WorkData helper startup needs a precisely reviewed harness allowance, not a product disable or deadline change. Full nine-action human, real platform callbacks/receipts/privacy/replay, and production continuous group audience revision provider remain unqualified.'
save(auditfile, audit)
gatesfile = BASE / 'release-gates.json'
gates = load(gatesfile)
assert gates['status'] == 'pending' and len(gates['gates']) == 8
assert all(row['status'] == 'pending' for row in gates['gates'])
gates.update(updatedAt=now, currentStatus=progress['status'])
work = gates['currentWork']
work['latestProgressReview20261118R4'] = review
work['complete31RequirementsAudit']['audit'] = bind(auditfile)
work['generationAndM5Failures20261118R4'] = {
    'progress': review, 'generationRootAccessFail': bind(generation),
    'm5ObserverFail': bind(m5first), 'm5HealthFail': bind(m5health),
    'sourceCapsules': [bind(BASE / name / 'manifest.json') for name, _ in capsules],
    'wholeIntegrationQualified': False,
}
for gate in gates['gates']:
    if gate['id'] == 'SR6':
        gate['notes'] = 'Scoped resident65 and early Node-death preparation reclaim passed. Complete encrypted lifecycle fails at generation-root Access before export capture. Full Desktop-owner lifecycle, trusted home/ACL, all supported legacy/direct Node/fallback paths, privacy/keys and clean Windows remain pending.'
save(gatesfile, gates)

document = ROOT / 'docs/optimization-plan/147-3.1-semantic-retrieval-and-recovery.md'
text = document.read_text(encoding='utf-8')
assert '### 10.35 ' in text and '### 10.36 ' not in text
text += '''
### 10.36 导出 generation 根断点与固定 HTTP 实测首红

Root先后核694／701绑定、独跑11／12项回归并单次执行固定目录类与generation细类诊断，均仍为FAIL。拒绝固定为before-capture、held-basic、directory、generation-root、time.access；因此已识别generation根角色，不能继续称“任意目录未知”，也不能据此采用仅index读取的研究修复。触发访问的实际代码路径仍未知。原四Basic、namespace、身份、源内容和完整生命周期不放宽，源不刷盘、时间不回写，旧失败根不重跑。下一步在同一census内区分首次native／Node绑定／最终native，随后实现保留全部约束的真实held-owner访问。两批外层均兜底到active0，不等于正常关闭或导出通过。

M5完整human范围确认是五类九项，各自启动／关闭独立fixture；旧全局单server规则在执行前撤回。守卫的c-ares／Resolver与自定义lookup／connection覆写缺口已在固定候选中补上；root复跑17项mock、真实HTTP栈仅替换socket正例及build／graph／static后实际执行group。首轮运行已获得883行真实Job身份样本，服务配对可核，但keeper在未细化的native查询步骤报unknown，控制器最终收据未写，外层兜底active0／total6。保留失败，不把配对或回收当业务通过。

下一候选只细化固定错误阶段／数值码，并把stdout／stderr在原合计2MiB限额内增量保存。Root核293绑定、独跑21项mock／静态后单次执行：890行身份样本和原child exit／close1、双流end均观察到，controller未触发120s runner超时；原45s serve-health期限失败，尚未进入group业务断言。本轮未出现keeper身份诊断错误，不能据此抹去上轮observer首红。Root定向读取本次owned合成保留日志，server只报work_data_setup.native_helper_uncertain；守卫server-role拒全部spawn与产品合法WorkData helper存在静态冲突，但具体调用仍待锁定。不得靠关闭M3、延长期限、换旧source或宽泛放行PowerShell来过测。human九项、真实QQ／飞书及连续群成员revision仍待。Root额外静态工具缺项首红及误以为失败写stderr的验收断言均保留，后者改读实际两流后完成后验，未重跑native。

以上源和结果已归档并分别经root独立原件／gzip／引用manifest postwalk：[目录分类](evidence/semantic-retrieval-20261116/s3c-export-directory-reviewed-20261118-r1/manifest.json)714别名／148本地内容，[generation根](evidence/semantic-retrieval-20261116/s3c-export-generation-reviewed-20261118-r1/manifest.json)721／154，[M5首轮](evidence/semantic-retrieval-20261116/s3c-m5-fixed-http-reviewed-20261118-r1/manifest.json)613／69，[M5健康检查](evidence/semantic-retrieval-20261116/s3c-m5-health-diagnostic-reviewed-20261118-r1/manifest.json)604／69。数据根、home、备份、密钥、模型、盲测与native binary不归档。精确SHA与最新状态见[进度记录r4](evidence/semantic-retrieval-20261116/3.1-progress-20261118-r4.json)。完整3.1范围不缩；SR1–SR8仍全pending，版本3.0.1／原默认不变，未commit/push/发布。
'''
document.write_text(text, encoding='utf-8', newline='\n')
notice = '> 2026-11-18 最新进度：早期Node退出回收限定实测通过；完整加密生命周期在export的generation根Access校验失败，触发路径仍待定位。M5真实本地group测试也保留FAIL：身份观察器首红及后续serve-health/native helper启动断点，尚未进入业务验收。详见 [147 §10.36](147-3.1-semantic-retrieval-and-recovery.md#1036-导出-generation-根断点与固定-http-实测首红)。3.1未达到RC，全部SR门仍pending。'
for name in ('README.md', '86-3.1-completion-and-privacy-roadmap.md', '92-3.1-implementation-handoff.md'):
    file = ROOT / 'docs/optimization-plan' / name
    lines = file.read_text(encoding='utf-8').splitlines()
    matches = [i for i, line in enumerate(lines) if line.startswith('> 2026-11-18 最新进度：')]
    assert len(matches) == 1
    lines[matches[0]] = notice
    file.write_text('\n'.join(lines) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({'progress': review, 'audit': bind(auditfile), 'section': '10.36', 'allEightGates': 'pending'}))
