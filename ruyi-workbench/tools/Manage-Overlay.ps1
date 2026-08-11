<#
  Manage-Overlay.ps1 - apply / rollback / list / verify / precheck / audit a 如意 Ruyi overlay.

  第53波 EC-B 安全更新中心:把已有 apply/rollback/verify 安全原语加固为「先预检、可审计、可幂等」的受测核心。
  GUI/API 只编排这一份脚本,不复制第二套更新实现(roadmap EC-B 规划原则)。

  Layout (inside the extracted overlay package):
    Manage-Overlay.cmd        (thin wrapper -> this script)
    Manage-Overlay.ps1
    APPLY-OVERLAY.md
    payload\                   (the files that land in the deployed folder)
      update-manifest.json     (sha256 of every payload file, relative to deployed root + minHostVersion)
      app\... Start-Workbench.cmd resources\... tools\...

  Usage (CLI, backward compatible):
    Manage-Overlay.cmd apply    "C:\path\to\Ruyi-offline"
    Manage-Overlay.cmd rollback "C:\path\to\Ruyi-offline"
    Manage-Overlay.cmd list     "C:\path\to\Ruyi-offline"
    Manage-Overlay.cmd verify   "C:\path\to\Ruyi-offline"

  Usage (EC-B 安全原语,GUI/API 编排用):
    Manage-Overlay.ps1 -Action precheck -OverlayRoot <extracted-pkg> -Target <deploy> [-Json] [-Force]
    Manage-Overlay.ps1 -Action apply     -OverlayRoot <extracted-pkg> -Target <deploy> [-Json] [-Force]
    Manage-Overlay.ps1 -Action rollback  -Target <deploy> [-Json] [-Force]
    Manage-Overlay.ps1 -Action audit     -Target <deploy> [-Json] [-Limit 50]

  输出纪律(-Json 模式):每个 action 向 pipeline 输出【恰好一个】JSON 对象(供 API 解析)。
  因此内部 helper 一律用赋值收集结果、不向 pipeline 散写;Get-ChildItem/New-Item 全 Out-Null;
  自增用 `$x = $x + 1`(赋值)而非 `$x++`(表达式会向 pipeline 吐旧值)。

  Precheck(写入前拒绝)失败类别:
    - path traversal:manifest 条目含 .. / 盘符 / 绝对路径(防 zip-slip 越界写)
    - checksum:payload 文件缺失或 sha256 != manifest(防篡改/缺文件包)
    - version:包 minHostVersion > 宿主 package.json version(防不兼容版本)
    - idempotency:同版本已 apply 且无 -Force(防重复应用,明确拒绝语义)
#>
param(
  [Parameter(Position = 0)][ValidateSet('apply', 'rollback', 'list', 'verify', 'precheck', 'audit')][string]$Action = 'apply',
  [Parameter(Position = 1)][string]$Target = '',
  [string]$OverlayRoot = '',          # 覆盖 $PSCommandPath 所在目录(API 编排已解压 zip 时用)
  [switch]$Json,                       # 机器可读输出(JSON;API 消费)
  [switch]$Force,                      # 跳过 idempotency 拒绝(同版本重 apply)/ rollback 端口拒
  [int]$Limit = 50                     # audit 动作返回条数上限
)
$ErrorActionPreference = 'Stop'
$script:overlayRoot = if ($OverlayRoot) { (Resolve-Path $OverlayRoot).Path } else { Split-Path -Parent $PSCommandPath }
$script:payload = Join-Path $script:overlayRoot 'payload'
$script:manifestPath = Join-Path $script:payload 'update-manifest.json'

function Fail($m) { Write-Host "[overlay] ERROR: $m" -ForegroundColor Red; exit 1 }
function Info($m) { if (-not $Json) { Write-Host "[overlay] $m" } }
function Warn($m) { if (-not $Json) { Write-Warning $m } }

function Resolve-Target {
  param([string]$t)
  if (-not $t) {
    # Try the parent of the overlay folder, then CWD, if they look like a deployment.
    # v1.0-S9 exe 改名 Ruyi.exe;双名兼容(存量部署仍名 WinClaudeWorkbench.exe)。
    foreach ($cand in @((Split-Path -Parent $script:overlayRoot), (Get-Location).Path)) {
      if ($cand -and ((Test-Path (Join-Path $cand 'app\server.js')) -or (Test-Path (Join-Path $cand 'Ruyi.exe')) -or (Test-Path (Join-Path $cand 'WinClaudeWorkbench.exe')))) { return $cand }
    }
    Fail "Target folder not given and could not be auto-detected. Pass the deployed Ruyi-offline folder."
  }
  if (-not (Test-Path $t)) { Fail "Target not found: $t" }
  return (Resolve-Path $t).Path
}

function Assert-Deployment($t) {
  if (-not ((Test-Path (Join-Path $t 'app')) -or (Test-Path (Join-Path $t 'Ruyi.exe')) -or (Test-Path (Join-Path $t 'WinClaudeWorkbench.exe')) -or (Test-Path (Join-Path $t 'runtime\node\node.exe')))) {
    Fail "'$t' does not look like a Ruyi deployment (no app\, exe, or runtime\node)."
  }
}

function Port-Listening($port) {
  try { return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) } catch { return $false }
}

function Get-Manifest { if (-not (Test-Path $script:manifestPath)) { Fail "payload\update-manifest.json missing." }; return Get-Content -Raw $script:manifestPath | ConvertFrom-Json }

# 宿主版本:部署根 package.json version(无则空 -> 版本预检放行,不阻塞)。
function Get-HostVersion($t) {
  $pkg = Join-Path $t 'package.json'
  if (Test-Path $pkg) {
    try { return [string]((Get-Content -Raw $pkg | ConvertFrom-Json).version) } catch {}
  }
  return $null
}

# 语义版本比较:current >= min -> true。不可解析 -> true(不阻塞,向后兼容)。
function Test-VersionCompat($min, $current) {
  if (-not $min -or -not $current) { return $true }
  try {
    # 仅取主.次.修(剥 -pre 后缀),按点分段数值比较。
    $minCore = ($min -split '-')[0]
    $curCore = ($current -split '-')[0]
    $minParts = $minCore.Split('.') | ForEach-Object { [int]$_ }
    $curParts = $curCore.Split('.') | ForEach-Object { [int]$_ }
    $len = [Math]::Max($minParts.Count, $curParts.Count)
    for ($i = 0; $i -lt $len; $i++) {
      $mn = if ($i -lt $minParts.Count) { $minParts[$i] } else { 0 }
      $cu = if ($i -lt $curParts.Count) { $curParts[$i] } else { 0 }
      if ($cu -gt $mn) { return $true }
      if ($cu -lt $mn) { return $false }
    }
    return $true
  } catch { return $true }
}

# 已应用标记(.overlay-applied.json;rollback 会清)。
function Get-AppliedMarker($t) {
  $p = Join-Path $t '.overlay-applied.json'
  if (Test-Path $p) { try { return Get-Content -Raw $p | ConvertFrom-Json } catch {} }
  return $null
}

# 路径逃逸检测:任何含 .. / 盘符(X:) / 绝对路径(leading \ or /)的 manifest 条目都判越界。
function Test-PathTraversal($rel) {
  if ($rel -match '(^|[/\\])\.\.([/\\]|$)') { return $true }
  if ($rel -match '^[A-Za-z]:') { return $true }
  if ($rel -match '^[\\/]') { return $true }
  return $false
}

# 审计日志:append-only jsonl。每条 {seq,ts,action,version,result,target,fileCount,backup,error}
function Write-Audit($t, $entry) {
  $logPath = Join-Path $t '.overlay-audit.jsonl'
  $seq = 0
  if (Test-Path $logPath) {
    try { $seq = @(Get-Content $logPath -ErrorAction Stop | Where-Object { $_.Trim() }).Count } catch {}
  }
  $rec = [ordered]@{
    seq      = $seq
    ts       = (Get-Date).ToString('o')
    action   = [string]$entry.action
    version  = [string]$entry.version
    result   = [string]$entry.result
    target   = [string]$t
    fileCount= [int]$entry.fileCount
    backup   = [string]$entry.backup
    error    = [string]$entry.error
  }
  try { Add-Content -LiteralPath $logPath -Value ($rec | ConvertTo-Json -Compress) -Encoding UTF8 } catch {}
}

# 依赖无关的 SHA256(治 Get-FileHash 漂移):Get-FileHash 是 PS5.1 Microsoft.PowerShell.Utility 里靠
# PSModulePath 自动加载的【脚本定义】函数——在 PSModulePath 被污染的机器(如 pwsh7 模块路径混入 CI
# runner)上它会消失,而同一模块的编译型 cmdlet 仍正常,极难排查。.NET SHA256 是 BCL 内置、与
# PSModulePath/版本无关,所有 Windows PowerShell 5.1 / pwsh 都可用。签名与 Get-FileHash 语义一致。
function Get-Sha256Hex {
  param([string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $algo = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($algo.ComputeHash($stream))).Replace('-', '').ToLower() }
    finally { $algo.Dispose() }
  } finally { $stream.Dispose() }
}

# 静默 helper:返回 verify 结果对象(不向 pipeline 输出;供 Do-Verify action 与 Do-Apply 内部复用)。
function Get-VerifyResult($t) {
  if (-not (Test-Path $script:manifestPath)) { return @{ ok = $false; error = 'manifest missing'; version = $null; fileCount = 0; mismatches = @() } }
  $m = Get-Manifest
  $bad = @()
  foreach ($f in $m.files) {
    $dst = Join-Path $t $f.path
    if (-not (Test-Path $dst)) { $bad += "$($f.path) [missing]"; continue }
    $sha = Get-Sha256Hex $dst
    if ($sha -ne $f.sha256.ToLower()) { $bad += "$($f.path) [hash mismatch]" }
  }
  return @{ ok = ($bad.Count -eq 0); error = ''; version = [string]$m.version; fileCount = [int]$m.fileCount; mismatches = $bad }
}

# ── precheck 核心(4 检查:路径逃逸/完整性/版本/幂等;静默返回,不输出) ──────────────
# Invoke-Precheck(action,带预览+输出)与 Invoke-PrecheckInternal(Do-Apply 内联)共用,消除重复(对抗审查 BUG-3)。
function Get-PrecheckCore($t) {
  if (-not (Test-Path $script:manifestPath)) {
    return [ordered]@{ ok = $false; errors = @('payload\update-manifest.json missing'); warnings = @(); version = $null; minHostVersion = $null; hostVersion = $null; fileCount = 0 }
  }
  $m = Get-Manifest
  $errors = @(); $warnings = @()
  # 1) 路径逃逸(逐条 manifest 条目;越界即整包拒,防 zip-slip 越界写)
  $traversal = @()
  foreach ($f in $m.files) { if (Test-PathTraversal $f.path) { $traversal += $f.path } }
  if ($traversal.Count) { $errors += "path traversal: $($traversal -join ', ')" }
  # 2) 完整性:payload 每文件存在 + sha256 == manifest(防篡改/缺文件)
  $missing = @(); $mismatched = @()
  foreach ($f in $m.files) {
    $src = Join-Path $script:payload $f.path
    if (-not (Test-Path $src)) { $missing += $f.path; continue }
    $sha = Get-Sha256Hex $src
    if ($sha -ne [string]$f.sha256.ToLower()) { $mismatched += $f.path }
  }
  if ($missing.Count) { $errors += "missing files: $($missing -join ', ')" }
  if ($mismatched.Count) { $errors += "checksum mismatch: $($mismatched -join ', ')" }
  # 3) 版本兼容:包 minHostVersion > 宿主 version -> 拒
  $hostVersion = Get-HostVersion $t
  $minHost = [string]$m.minHostVersion
  if ($minHost -and $hostVersion -and -not (Test-VersionCompat $minHost $hostVersion)) {
    $errors += "version incompatible: package requires host >= $minHost, current host is $hostVersion"
  }
  # 4) 幂等:同版本已 apply 且无 -Force -> 警告(apply 时升格为拒;precheck 只提示)
  $applied = Get-AppliedMarker $t
  if ($applied -and [string]$applied.version -eq [string]$m.version -and -not $Force) {
    $warnings += "version $($m.version) already applied at $($applied.appliedAt); re-apply needs -Force"
  }
  return [ordered]@{
    ok = $errors.Count -eq 0; errors = $errors; warnings = $warnings
    version = [string]$m.version; minHostVersion = $minHost; hostVersion = $hostVersion; fileCount = [int]$m.fileCount
  }
}

# precheck 静默内部版(供 Do-Apply 内联;不输出,只返回 core)。
function Invoke-PrecheckInternal($t) {
  Assert-Deployment $t
  return Get-PrecheckCore $t
}

# ── precheck action:写入前全检 + 变更预览,返回结构化结果(供 -Json 机器消费 / 人读文本) ──
function Invoke-Precheck($t) {
  Assert-Deployment $t
  $core = Get-PrecheckCore $t
  # 变更预览(仅 manifest 在时算;core.fileCount=0 表示 manifest 缺)
  $preview = $null
  if ($core.fileCount -gt 0) {
    $m = Get-Manifest
    $newFiles = @(); $overwritten = @(); $unchanged = @()
    foreach ($f in $m.files) {
      $dst = Join-Path $t $f.path
      if (-not (Test-Path $dst)) { $newFiles += $f.path; continue }
      $dstSha = Get-Sha256Hex $dst
      if ($dstSha -eq [string]$f.sha256.ToLower()) { $unchanged += $f.path } else { $overwritten += $f.path }
    }
    $deleted = @()
    $curMani = Join-Path $t 'update-manifest.json'
    if (Test-Path $curMani) {
      try {
        $old = Get-Content -Raw $curMani | ConvertFrom-Json
        $newPaths = @($m.files | ForEach-Object { $_.path })
        foreach ($of in $old.files) { if ($newPaths -notcontains $of.path) { $deleted += $of.path } }
      } catch {}
    }
    $preview = [ordered]@{ new = $newFiles; overwritten = $overwritten; unchanged = $unchanged; deleted = $deleted }
  }
  $result = [ordered]@{
    ok = $core.ok; errors = $core.errors; warnings = $core.warnings
    version = $core.version; minHostVersion = $core.minHostVersion; hostVersion = $core.hostVersion
    fileCount = $core.fileCount; preview = $preview
  }
  if ($Json) { $result | ConvertTo-Json -Depth 6 }
  else {
    foreach ($e in $result.errors) { Write-Host "[overlay] ERROR: $e" -ForegroundColor Red }
    foreach ($w in $result.warnings) { Write-Warning $w }
    if ($preview) { Info "Precheck v$($result.version): new=$($preview.new.Count) overwritten=$($preview.overwritten.Count) unchanged=$($preview.unchanged.Count) deleted=$($preview.deleted.Count) host=$($result.hostVersion) minHost=$($result.minHostVersion)" }
    if (-not $result.ok) { exit 1 }
  }
}

function Do-Apply($t) {
  Assert-Deployment $t
  # EC-B:apply 前先跑 precheck 全检(路径逃逸/完整性/版本/幂等);失败即拒,绝不写入。
  $check = Invoke-PrecheckInternal $t
  $applyResult = $null
  if (-not $check.ok) {
    $msg = ($check.errors -join '; ')
    Write-Audit $t @{ action='apply'; version=$check.version; result='rejected'; fileCount=$check.fileCount; backup=''; error=$msg }
    $applyResult = [ordered]@{ ok = $false; rejected = $true; errors = $check.errors; warnings = $check.warnings; version = $check.version }
  } elseif ($check.warnings.Count -and -not $Force) {
    # 幂等:同版本已 apply 且无 -Force -> 明确拒绝(precheck 只警告,apply 升格拒)
    $idemMsg = ($check.warnings -join '; ')
    Write-Audit $t @{ action='apply'; version=$check.version; result='idempotent_rejected'; fileCount=$check.fileCount; backup=''; error=$idemMsg }
    $applyResult = [ordered]@{ ok = $false; idempotent = $true; warnings = $check.warnings; version = $check.version }
  } else {
    $m = Get-Manifest
    Info "Applying overlay v$($m.version) ($($m.fileCount) files) -> $t"
    if ((Port-Listening 8765) -or (Port-Listening 8799)) { Warn "A workbench server may be running. Close it before restarting so the new server.js loads." }
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = Join-Path $t ".overlay-backups\$($m.version)-$ts"
    try {
      New-Item -ItemType Directory -Force -Path $backup | Out-Null
      # 1) Back up any existing counterpart of each payload file.
      foreach ($f in $m.files) {
        $dst = Join-Path $t $f.path
        if (Test-Path $dst) {
          $bdst = Join-Path $backup $f.path
          New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bdst) | Out-Null
          Copy-Item -LiteralPath $dst -Destination $bdst -Force
        }
      }
      $curMani = Join-Path $t 'update-manifest.json'
      if (Test-Path $curMani) { Copy-Item $curMani (Join-Path $backup 'update-manifest.json') -Force }
      Info "Backed up existing files -> $backup"
      # 2) Copy payload over the target.
      foreach ($f in $m.files) {
        $src = Join-Path $script:payload $f.path
        $dst = Join-Path $t $f.path
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
        Copy-Item -LiteralPath $src -Destination $dst -Force
      }
      Copy-Item $script:manifestPath (Join-Path $t 'update-manifest.json') -Force
      # 3) Marker + prune old backups (keep newest 5).
      @{ version = $m.version; overlay = $m.overlay; appliedAt = (Get-Date).ToString('o'); backup = $backup } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $t '.overlay-applied.json') -Encoding UTF8
      $backups = @(Get-ChildItem (Join-Path $t '.overlay-backups') -Directory -ErrorAction SilentlyContinue | Sort-Object CreationTime -Descending)
      if ($backups.Count -gt 5) { $backups | Select-Object -Skip 5 | Remove-Item -Recurse -Force }
      # post-apply verify(静默取结果,不向 pipeline 散写)。对抗审查 BUG-2:verify 结果决定顶层 ok/审计 result,
      # 不再硬编码 ok -- copy 成功但写入损坏(磁盘位翻转/杀毒改写)时 verify 抓得到,审计如实记 verify_failed。
      $vr = Get-VerifyResult $t
      $applyOk = [bool]$vr.ok
      $resultLabel = if ($applyOk) { 'ok' } else { 'verify_failed' }
      Write-Audit $t @{ action='apply'; version=$m.version; result=$resultLabel; fileCount=$m.fileCount; backup=$backup; error=$(if ($applyOk) { '' } else { ($vr.mismatches -join ', ') }) }
      $applyResult = [ordered]@{ ok = $applyOk; version = $m.version; backup = $backup; fileCount = $m.fileCount; restartNeeded = $true; verify = $vr }
      if (-not $Json) {
        if ($applyOk) { Info "DONE. Restart with Start-Workbench.cmd, then check /health and the 体检 (Doctor) tab." }
        else { Warn "VERIFY FAILED after apply: $($vr.mismatches.Count) mismatch(es). Backup at $backup. Consider rollback." }
      }
    } catch {
      $err = [string]($_.Exception.Message)
      Write-Audit $t @{ action='apply'; version=$m.version; result='failed'; fileCount=$m.fileCount; backup=$backup; error=$err }
      $applyResult = [ordered]@{ ok = $false; failed = $true; error = $err; backup = $backup }
      if (-not $Json) { Fail "apply failed: $err (backup at $backup)" }
    }
  }
  if ($Json) { $applyResult | ConvertTo-Json -Depth 6 }
  else {
    if ($applyResult.ok -eq $false) {
      if ($applyResult.rejected) { Fail "precheck rejected: $(($applyResult.errors) -join '; ')" }
      elseif ($applyResult.idempotent) { Fail "idempotent: $(($applyResult.warnings) -join '; ') (use -Force to reapply)" }
      elseif ($applyResult.failed) { Fail "apply failed: $($applyResult.error)" }
    }
  }
}

function Do-Rollback($t) {
  Assert-Deployment $t
  $rbResult = $null
  # EC-B:rollback 默认拒(服务在跑别覆盖);-Force 跳过(API 路径自动带 -Force,因 API 本就跑在服务内,
  # 文件覆写后需 restart 才加载恢复的旧文件 -- 与 apply 同语义)。CLI 默认保留安全拒(向后兼容)。
  $portUp = (Port-Listening 8765) -or (Port-Listening 8799)
  if ($portUp -and -not $Force) {
    $rbResult = [ordered]@{ ok = $false; error = 'A workbench server is running. Stop it before rolling back, or use -Force.' }
    if (-not $Json) { Fail $rbResult.error }
  } else {
    if ($portUp) { Warn "A workbench server may be running; rolling back files anyway (-Force). Restart after to load restored files." }
    $root = Join-Path $t '.overlay-backups'
    if (-not (Test-Path $root)) {
      Write-Audit $t @{ action='rollback'; version=''; result='no_backups'; fileCount=0; backup=''; error='no .overlay-backups' }
      $rbResult = [ordered]@{ ok = $false; error = "No backups found under $root" }
      if (-not $Json) { Fail $rbResult.error }
    } else {
      $latest = Get-ChildItem $root -Directory | Sort-Object CreationTime -Descending | Select-Object -First 1
      if (-not $latest) {
        Write-Audit $t @{ action='rollback'; version=''; result='no_backups'; fileCount=0; backup=''; error='empty backups dir' }
        $rbResult = [ordered]@{ ok = $false; error = "No backups found." }
        if (-not $Json) { Fail $rbResult.error }
      } else {
        Info "Restoring backup $($latest.Name) -> $t"
        $restored = 0
        Get-ChildItem $latest.FullName -Recurse -File | ForEach-Object {
          $rel = $_.FullName.Substring($latest.FullName.Length).TrimStart('\')
          $dst = Join-Path $t $rel
          New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
          Copy-Item -LiteralPath $_.FullName -Destination $dst -Force
          # 对抗审查 BUG-1:$restored++ 是表达式,会向 pipeline 吐旧值(0,1,2...)破坏 -Json 单对象输出。
          # 改赋值式(无 pipeline 输出)。
          $restored = $restored + 1
        }
        if (-not (Test-Path (Join-Path $latest.FullName 'update-manifest.json'))) {
          Remove-Item -LiteralPath (Join-Path $t 'update-manifest.json') -Force -ErrorAction SilentlyContinue
          Remove-Item -LiteralPath (Join-Path $t '.overlay-applied.json') -Force -ErrorAction SilentlyContinue
        }
        Write-Audit $t @{ action='rollback'; version=$latest.Name; result='ok'; fileCount=$restored; backup=$latest.FullName; error='' }
        $rbResult = [ordered]@{ ok = $true; restored = $restored; backup = $latest.Name }
        if (-not $Json) { Info "Rollback complete ($restored files). (Note: files newly ADDED by the overlay are left in place; that is harmless.)" }
      }
    }
  }
  if ($Json) { $rbResult | ConvertTo-Json -Depth 5 }
}

function Do-List($t) {
  $root = Join-Path $t '.overlay-backups'
  $items = @()
  if (Test-Path $root) {
    $items = @(Get-ChildItem $root -Directory | Sort-Object Name -Descending | ForEach-Object {
      $n = (Get-ChildItem $_.FullName -Recurse -File | Measure-Object).Count
      [ordered]@{ name = $_.Name; fileCount = $n; createdAt = $_.CreationTime.ToString('o') }
    })
  }
  if ($Json) { [ordered]@{ ok = $true; backups = $items } | ConvertTo-Json -Depth 4 }
  else {
    if (-not $items.Count) { Info "No backups." }
    else { foreach ($i in $items) { Info "$($i.name)  ($($i.fileCount) files)" } }
  }
}

function Do-Verify($t) {
  $vr = Get-VerifyResult $t
  if ($Json) { $vr | ConvertTo-Json -Depth 4 }
  else {
    if ($vr.ok) { Info "VERIFY OK: all $($vr.fileCount) files match v$($vr.version)." }
    else { Write-Warning "VERIFY: $($vr.mismatches.Count) mismatch(es):`n  $([string]::Join("`n  ", $vr.mismatches))" }
  }
}

function Do-Audit($t) {
  $logPath = Join-Path $t '.overlay-audit.jsonl'
  $entries = @()
  if (Test-Path $logPath) {
    try {
      $all = @(Get-Content $logPath -ErrorAction Stop | Where-Object { $_.Trim() })
      $tail = $all | Select-Object -Last $Limit
      foreach ($line in $tail) { try { $entries += ($line | ConvertFrom-Json) } catch {} }
    } catch {}
  }
  if ($Json) { [ordered]@{ ok = $true; count = $entries.Count; entries = $entries } | ConvertTo-Json -Depth 5 }
  else {
    if (-not $entries.Count) { Info "No audit entries." }
    else { foreach ($e in $entries) { Info "#$($e.seq) $($e.ts) $($e.action) v$($e.version) -> $($e.result)$(if($e.error){' ('+$e.error+')'})" } }
  }
}

$t = Resolve-Target $Target
switch ($Action) {
  'precheck' { Invoke-Precheck $t }
  'apply'    { Do-Apply $t }
  'rollback' { Do-Rollback $t }
  'list'     { Do-List $t }
  'verify'   { Do-Verify $t }
  'audit'    { Do-Audit $t }
}
