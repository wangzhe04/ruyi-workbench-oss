# Build desktop/ruyi.ico by drawing the minimal cloud mark (zero dependency: System.Drawing).
# The geometry MUST stay in sync with TitlePanel.DrawLogo (RuyiDesktop.cs) and the
# loading-page inline SVG, so window/taskbar/tray/titlebar/loading all show ONE icon.
# Produces a PNG-compressed multi-size ICO (16..256) usable as /win32icon and form icon.
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$desktopDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dst = Join-Path $desktopDir 'ruyi.ico'

function New-LogoBitmap([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # Feather cloud on a 24-unit grid (path M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z + gold dot),
  # same geometry as TitlePanel.DrawLogo and the sidebar brand SVG in index.html.
  $k = [single]$s / 24
  $qh = [System.Drawing.Color]::FromArgb(107, 143, 242)  # --brand-qh (dark)
  $au = [System.Drawing.Color]::FromArgb(242, 193, 78)   # --brand-au (dark)

  # rounded tile: faint brand tint fill, no stroke (no surrounding padding)
  $d = [int]($s * 3 / 10) * 2
  $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tile.AddArc(0, 0, $d, $d, 180, 90)
  $tile.AddArc($s - $d, 0, $d, $d, 270, 90)
  $tile.AddArc($s - $d, $s - $d, $d, $d, 0, 90)
  $tile.AddArc(0, $s - $d, $d, $d, 90, 90)
  $tile.CloseFigure()
  $fill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30, $qh))
  $g.FillPath($fill, $tile)
  $fill.Dispose(); $tile.Dispose()

  # cloud outline via arc conversion of the Feather path
  $cloud = New-Object System.Drawing.Drawing2D.GraphicsPath
  $cloud.AddLine([single](18 * $k), [single](10 * $k), [single](16.74 * $k), [single](10 * $k))
  $cloud.AddArc([single](1 * $k), [single](4 * $k), [single](16 * $k), [single](16 * $k), [single](-14.5), [single](-255.5))
  $cloud.AddLine([single](9 * $k), [single](20 * $k), [single](18 * $k), [single](20 * $k))
  $cloud.AddArc([single](13 * $k), [single](10 * $k), [single](10 * $k), [single](10 * $k), [single]90, [single](-180))
  $cloud.CloseFigure()
  $pen = New-Object System.Drawing.Pen($qh, [single](1.5 * $k))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawPath($pen, $cloud)
  $pen.Dispose(); $cloud.Dispose()

  # gold dot (19.4, 3.4, r1.5)
  $dot = New-Object System.Drawing.SolidBrush($au)
  $g.FillEllipse($dot, [single](17.9 * $k), [single](1.9 * $k), [single](3 * $k), [single](3 * $k))
  $dot.Dispose()

  $g.Dispose()
  return $bmp
}

$sizes = @(16, 20, 24, 32, 40, 48, 64, 256)
$pngs = @()
foreach ($s in $sizes) {
  $bmp = New-LogoBitmap $s
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += ,($ms.ToArray())
  $ms.Dispose()
  $bmp.Dispose()
}

$fs = [System.IO.File]::Create($dst)
$w = New-Object System.IO.BinaryWriter($fs)
# ICONDIR
$w.Write([uint16]0)      # reserved
$w.Write([uint16]1)      # type = icon
$w.Write([uint16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
for ($i = 0; $i -lt $pngs.Count; $i++) {
  $s = $sizes[$i]
  $data = $pngs[$i]
  $w.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))   # width
  $w.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))   # height
  $w.Write([byte]0)     # palette
  $w.Write([byte]0)     # reserved
  $w.Write([uint16]1)   # planes
  $w.Write([uint16]32)  # bpp
  $w.Write([uint32]$data.Length)
  $w.Write([uint32]$offset)
  $offset += $data.Length
}
foreach ($data in $pngs) { $w.Write($data) }
$w.Flush()
$w.Dispose()
$fs.Dispose()
Write-Host "[Ruyi] Icon built: $dst ($([System.IO.File]::ReadAllBytes($dst).Length) bytes, $($pngs.Count) sizes)"
