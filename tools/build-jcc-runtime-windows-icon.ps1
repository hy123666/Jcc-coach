[CmdletBinding()]
param(
  [string]$PngPath,
  [string]$IcoPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $PngPath) { $PngPath = Join-Path $repoRoot 'ui\assets\jcc-runtime.png' }
if (-not $IcoPath) { $IcoPath = Join-Path $repoRoot 'ui\assets\jcc-runtime.ico' }

Add-Type -AssemblyName System.Drawing

function New-RoundedRectanglePath {
  param(
    [System.Drawing.RectangleF]$Rectangle,
    [float]$Radius
  )
  $diameter = $Radius * 2
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $path.AddArc($Rectangle.X, $Rectangle.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($Rectangle.Right - $diameter, $Rectangle.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($Rectangle.X, $Rectangle.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

foreach ($target in @($PngPath, $IcoPath)) {
  $parent = Split-Path -Parent $target
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
}

$bitmap = [System.Drawing.Bitmap]::new(256, 256, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)

$outer = New-RoundedRectanglePath ([System.Drawing.RectangleF]::new(10, 10, 236, 236)) 42
$outerBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#081018'))
$graphics.FillPath($outerBrush, $outer)
$outerPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#314252'), 6)
$graphics.DrawPath($outerPen, $outer)

$gridPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#20313D'), 4)
foreach ($coordinate in @(70, 112, 154, 196)) {
  $graphics.DrawLine($gridPen, $coordinate, 44, $coordinate, 212)
  $graphics.DrawLine($gridPen, 44, $coordinate, 212, $coordinate)
}

$accentBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#F4B860'))
$graphics.FillRectangle($accentBrush, 48, 48, 24, 24)

$mark = [System.Drawing.Drawing2D.GraphicsPath]::new()
$mark.StartFigure()
$mark.AddLine(92, 72, 176, 72)
$mark.AddLine(176, 72, 176, 148)
$mark.AddBezier(176, 148, 176, 195, 91, 211, 68, 158)
$markPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#31D7B7'), 22)
$markPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$markPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$markPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$graphics.DrawPath($markPen, $mark)

$bitmap.Save($PngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$pngBytes = [System.IO.File]::ReadAllBytes($PngPath)
$icoStream = [System.IO.File]::Open($IcoPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$writer = [System.IO.BinaryWriter]::new($icoStream)
try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]1)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]32)
  $writer.Write([uint32]$pngBytes.Length)
  $writer.Write([uint32]22)
  $writer.Write($pngBytes)
} finally {
  $writer.Dispose()
  $icoStream.Dispose()
}

$graphics.Dispose()
$bitmap.Dispose()
$outer.Dispose()
$outerBrush.Dispose()
$outerPen.Dispose()
$gridPen.Dispose()
$accentBrush.Dispose()
$mark.Dispose()
$markPen.Dispose()

[pscustomobject]@{
  ok = $true
  schema = 'jcc-runtime-windows-icon-build-v1'
  png = (Resolve-Path $PngPath).Path
  ico = (Resolve-Path $IcoPath).Path
  png_bytes = (Get-Item -LiteralPath $PngPath).Length
  ico_bytes = (Get-Item -LiteralPath $IcoPath).Length
} | ConvertTo-Json -Compress
