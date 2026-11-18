$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$PSModuleAutoLoadingPreference='None'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$a=[Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35');$j=[Activator]::CreateInstance($a.GetType('System.Web.Script.Serialization.JavaScriptSerializer'));$j.MaxJsonLength=65536;$j.RecursionLimit=12
$r=$j.DeserializeObject([Console]::In.ReadToEnd());$self=[Diagnostics.Process]::GetCurrentProcess();$user=[Security.Principal.WindowsIdentity]::GetCurrent();$sid=$user.User;$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
try {
 if($r.mode -eq 'readonly'){
  $owned=[IO.Path]::GetFullPath([string]$r.owned);$root=[IO.Path]::GetFullPath([string]$r.root)
  if($root -ne [IO.Path]::Combine($owned,'安装 中文') -or ![IO.File]::Exists([IO.Path]::Combine($owned,'OWNER.json'))){throw 'readonly namespace'}
  $items=[Collections.Generic.List[string]]::new();$items.Add($root);$at=0
  while($at -lt $items.Count){if($items.Count -gt 256){throw 'readonly inventory bound'};$p=$items[$at];$at++;$attrs=[IO.File]::GetAttributes($p);if(($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'readonly reparse'};if(($attrs -band [IO.FileAttributes]::Directory) -ne 0){foreach($q in [IO.Directory]::GetFileSystemEntries($p)){$items.Add($q)}}}
  # Inspect the complete owned namespace before changing any ACL. No recursion
  # ever crosses the exact controller-created installation directory.
  foreach($p in $items){$isDir=([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::Directory) -ne 0;$old=if($isDir){[IO.Directory]::GetAccessControl($p)}else{[IO.File]::GetAccessControl($p)};if(!$old.GetOwner([Security.Principal.SecurityIdentifier]).Equals($sid)){throw 'readonly owner'}}
  # Protect descendants before reducing access on any parent. The existing
  # owner was checked above. Persist only the access rules, never the owner.
  for($i=$items.Count-1;$i -ge 0;$i--){
   $p=$items[$i];$isDir=([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::Directory) -ne 0
   $d=if($isDir){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
   $d.SetAccessRuleProtection($true,$false)
   $inherit=if($isDir){[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit}else{[Security.AccessControl.InheritanceFlags]::None}
   $userRule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::ReadAndExecute,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
   $systemRule=[Security.AccessControl.FileSystemAccessRule]::new($system,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
   $d.AddAccessRule($userRule);$d.AddAccessRule($systemRule)
   if($isDir){[IO.Directory]::SetAccessControl($p,$d)}else{[IO.File]::SetAccessControl($p,$d)}
   $actual=if($isDir){[IO.Directory]::GetAccessControl($p)}else{[IO.File]::GetAccessControl($p)}
   $rules=@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
   if(!$actual.GetOwner([Security.Principal.SecurityIdentifier]).Equals($sid) -or !$actual.AreAccessRulesProtected -or $rules.Count -ne 2){throw 'readonly ACL owner/protection'}
   foreach($expected in @($userRule,$systemRule)){
    $match=@($rules | Where-Object {$_.IdentityReference.Equals($expected.IdentityReference)})
    if($match.Count -ne 1 -or $match[0].IsInherited -or $match[0].AccessControlType -ne $expected.AccessControlType -or $match[0].FileSystemRights -ne $expected.FileSystemRights -or $match[0].InheritanceFlags -ne $expected.InheritanceFlags -or $match[0].PropagationFlags -ne $expected.PropagationFlags){throw 'readonly ACL rights'}
   }
  }
  $v=[ordered]@{mode='readonly';changed=$items.Count;root=$root}
 }elseif($r.mode -in @('home-acl','home-absent')){
  $root=[IO.Path]::GetFullPath([string]$r.root);$leaf=[IO.Path]::GetFileName($root);$container=[IO.Directory]::GetParent($root).FullName
  if($leaf -notmatch '^r-[a-f0-9]{64}$' -or [IO.Path]::GetFileName($container) -ne ('Ruyi-semantic-'+$sid.Value)){throw 'home leaf scope'}
  $known=@([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData),[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData))
  if([IO.Directory]::GetParent($container).FullName -notin $known){throw 'home known folder'}
  if($r.mode -eq 'home-absent'){
   $gone=$false;try{$null=[IO.File]::GetAttributes($root)}catch{$e=$_.Exception;if($e.InnerException){$e=$e.InnerException};if($e -is [IO.FileNotFoundException] -or $e -is [IO.DirectoryNotFoundException]){$gone=$true}else{throw}}
   if(!$gone){throw 'home still exists'};$v=[ordered]@{mode='home-absent';root=$root;absent=$true;notPermissionFailure=$true}
  }else{
  $rows=[Collections.Generic.List[object]]::new()
  foreach($p in @($container,$root,[IO.Path]::Combine($root,'tmp'),[IO.Path]::Combine($root,'local'),[IO.Path]::Combine($root,'roaming'),[IO.Path]::Combine($root,'cache'))){$attrs=[IO.File]::GetAttributes($p);if(($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'home reparse'};$d=[IO.Directory]::GetAccessControl($p);$owner=$d.GetOwner([Security.Principal.SecurityIdentifier]);$rules=@($d.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));if(!$owner.Equals($sid) -or !$d.AreAccessRulesProtected -or $rules.Count -ne 2){throw 'home ACL owner/protection'};$seen=@{};foreach($rule in $rules){$id=$rule.IdentityReference.Value;if($id -notin @($sid.Value,$system.Value) -or $seen.ContainsKey($id) -or $rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or [int]$rule.FileSystemRights -ne [int][Security.AccessControl.FileSystemRights]::FullControl){throw 'home ACL rights'};$seen[$id]=$true};$rows.Add([ordered]@{path=$p;owner=$owner.Value;protected=$d.AreAccessRulesProtected;rules=$rules.Count;exclusiveCurrentUserAndSystem=$true})}
  $v=[ordered]@{mode='home-acl';root=$root;rows=$rows.ToArray();valid=$true}
  }
 }else{throw 'filesystem mode'}
 [Console]::Out.WriteLine($j.Serialize([ordered]@{observer=[ordered]@{pid=$self.Id;creationFileTime=[string]$self.StartTime.ToUniversalTime().ToFileTimeUtc();image=$self.MainModule.FileName};value=$v}))
}finally{$user.Dispose();$self.Dispose()}
