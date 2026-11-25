param(
    [Parameter(Mandatory = $true)][int]$OwnerPid,
    [Parameter(Mandatory = $true)][string]$Created,
    [Parameter(Mandatory = $true)][string]$Image,
    [string]$CloseWindow
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$owner = Get-Process -Id $OwnerPid
try {
    $held = $owner.Handle
    if ($held -eq [IntPtr]::Zero -or $owner.StartTime.ToFileTimeUtc().ToString() -ne $Created -or $owner.MainModule.FileName -ne $Image) {
        throw 'Desktop process identity changed'
    }
    $owner.Refresh()
    $hwnd = $owner.MainWindowHandle
    if ($CloseWindow) {
        if ($hwnd -eq [IntPtr]::Zero -or $hwnd.ToString() -ne $CloseWindow -or !$owner.CloseMainWindow()) {
            throw 'Cannot close the observed desktop window'
        }
        return
    }
    $documents = @()
    if ($hwnd -ne [IntPtr]::Zero) {
        Add-Type -AssemblyName UIAutomationClient
        $window = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
        if ($window.Current.ProcessId -ne $OwnerPid) { throw 'Window owner changed' }
        $type = [Windows.Automation.AutomationElement]::ControlTypeProperty
        $condition = [Windows.Automation.PropertyCondition]::new($type, [Windows.Automation.ControlType]::Document)
        foreach ($doc in $window.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) {
            $pattern = $null
            if (!$doc.Current.IsOffscreen -and $doc.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
                $uri = $null
                if ([uri]::TryCreate($pattern.Current.Value, [UriKind]::Absolute, [ref]$uri)) {
                    $documents += @{ name = $doc.Current.Name; origin = $uri.GetLeftPart([UriPartial]::Authority) }
                }
            }
        }
    }
    ConvertTo-Json -Compress -InputObject @{ hwnd = $hwnd.ToString(); title = $owner.MainWindowTitle; documents = $documents }
} finally {
    $owner.Dispose()
}
