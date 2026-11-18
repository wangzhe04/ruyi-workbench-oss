function ConvertTo-ValidatorArgument([string]$Value) {
  $builder = [Text.StringBuilder]::new(); [void]$builder.Append('"'); $slashes = 0
  foreach ($ch in $Value.ToCharArray()) {
    if ($ch -eq '\') { $slashes++; continue }
    if ($ch -eq '"') { [void]$builder.Append(('\' * (2 * $slashes + 1))); [void]$builder.Append('"') }
    else { if ($slashes) { [void]$builder.Append(('\' * $slashes)) }; [void]$builder.Append($ch) }
    $slashes = 0
  }
  if ($slashes) { [void]$builder.Append(('\' * (2 * $slashes))) }
  [void]$builder.Append('"'); return $builder.ToString()
}
function Invoke-SupplementValidator([string]$Python, [string[]]$Arguments) {
  if (-not [IO.Path]::IsPathRooted($Python) -or -not [IO.File]::Exists($Python) -or [IO.Path]::GetExtension($Python) -ine '.exe') { throw 'BuildPython must be an absolute existing executable.' }
  $info = [Diagnostics.ProcessStartInfo]::new(); $info.FileName = $Python; $info.Arguments = (($Arguments | ForEach-Object { ConvertTo-ValidatorArgument $_ }) -join ' ')
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new(); $process.StartInfo = $info
  try {
    if (-not $process.Start()) { throw 'Supplement validator did not start.' }
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit(); $outText = $stdout.GetAwaiter().GetResult(); $errText = $stderr.GetAwaiter().GetResult(); $code = $process.ExitCode
    if ($outText) { [Console]::Out.Write($outText) }; if ($errText) { [Console]::Error.Write($errText) }
    if ($code -ne 0) { throw "OpenH264 supplement validation failed (exit $code)." }
  } finally { $process.Dispose() }
}
