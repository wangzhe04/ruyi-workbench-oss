param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
$resolved=[IO.Path]::GetFullPath($Root)
$temporary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
if(-not $resolved.StartsWith($temporary,[StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($resolved)).StartsWith('ruyi-m1-cli-')){throw 'not-owned-root'}
$result=@{}
foreach($relative in @('hardlink-source\marker.txt','projection\linked-secret.txt')){
  $target=[IO.Path]::Combine($resolved,$relative)
  $sddl=(Get-Acl -LiteralPath $target).Sddl.Replace([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'<host-user-sid>')
  $result[$relative]=[regex]::Replace($sddl,'S-1-5-21-(?:[0-9]+-){3}[0-9]+','<host-account-sid>')
}
$result | ConvertTo-Json -Compress
