$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName Microsoft.VisualBasic
$memory = New-Object Microsoft.VisualBasic.Devices.ComputerInfo
# One PerfProc collection supplies every process counter at the same object timestamp.
# ElapsedTime is the raw start tick (FILETIME here); the formatted elapsed-seconds
# property would lose the identity needed to distinguish reused process IDs.
$properties = @('IDProcess', 'CreatingProcessID', 'Name', 'ElapsedTime', 'Timestamp_Object', 'Frequency_Object',
    'WorkingSet', 'PrivateBytes', 'PercentUserTime', 'PercentPrivilegedTime', 'ThreadCount')
$started = [DateTime]::UtcNow
$rows = @(Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property $properties)
$availableBytes = $memory.AvailablePhysicalMemory
$memoryTime = [DateTime]::UtcNow
$samples = foreach ($row in $rows) {
    if ($row.IDProcess -eq 0) { continue } # Idle and _Total are aggregate rows.
    [ordered]@{
        pid = $row.IDProcess
        parent = $row.CreatingProcessID
        name = $row.Name
        born = [string]$row.ElapsedTime
        tick = [string]$row.Timestamp_Object
        frequency = $row.Frequency_Object
        workingSetBytes = $row.WorkingSet
        privateCommitBytes = $row.PrivateBytes
        userTime100ns = $row.PercentUserTime
        kernelTime100ns = $row.PercentPrivilegedTime
        threads = $row.ThreadCount
    }
}
ConvertTo-Json -Depth 4 -Compress -InputObject ([ordered]@{
    startedUtc = $started.ToString('o')
    availablePhysicalBytes = $availableBytes
    memorySampledUtc = $memoryTime.ToString('o')
    rows = @($samples)
})
