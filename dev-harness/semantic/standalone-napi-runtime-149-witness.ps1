param([string]$Run,[int]$TargetId,[string]$Node,[string]$Case)
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id $TargetId -ErrorAction Stop
try {
    # Retain the same native handle through the before/after observations.
    $handle = $process.Handle
    if ($handle -eq [IntPtr]::Zero -or $process.HasExited -or $process.Path -ne $Node) {
        throw 'Unexpected descendant identity'
    }
    $birth = [string]($process.StartTime.ToFileTimeUtc())
    [IO.File]::WriteAllText((Join-Path $Run "$Case.witness-ready"), "$TargetId,$birth")
    if ($Case -eq 'unarmed') {
        $deadline = [Diagnostics.Stopwatch]::StartNew()
        while (!(Test-Path -LiteralPath (Join-Path $Run "$Case.check"))) {
            if ($deadline.ElapsedMilliseconds -gt 8000) { throw 'Controller did not commit unarmed check' }
            Start-Sleep -Milliseconds 20
        }
        if ($process.HasExited) { throw 'Unarmed descendant did not outlive its parent' }
        [IO.File]::WriteAllText((Join-Path $Run "$Case.stop"), 'stop')
    }
    if (!$process.WaitForExit(8000)) { throw 'Descendant did not exit' }
    if ($process.Handle -ne $handle) { throw 'Descendant handle changed' }
    [Console]::WriteLine((@{pid = $TargetId; creationFileTime = $birth; exitCode = $process.ExitCode; exited = $true} | ConvertTo-Json -Compress))
} finally {
    $process.Dispose()
}
