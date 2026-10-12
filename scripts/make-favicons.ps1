# §80 分頁圖示：用左上角頭像（像素臉部特寫 avatar_24.png）以 nearest-neighbor 縮放，輸出 favicon-16、favicon-32 與 apple-touch-icon（180）。
# 用法（Windows PowerShell）：powershell -NoProfile -File scripts/make-favicons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'studio/src/assets/alice-pixel/avatar_24.png'
$out = Join-Path $root 'studio/public'
New-Item -ItemType Directory -Force $out | Out-Null
$image = [System.Drawing.Image]::FromFile($source)

function Save-Icon([int]$canvas, [int]$size, [string]$name, [string]$background) {
  $bitmap = New-Object System.Drawing.Bitmap $canvas, $canvas
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
  if ($background -ne '') { $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml($background)) } else { $graphics.Clear([System.Drawing.Color]::Transparent) }
  $offset = [int](($canvas - $size) / 2)
  $graphics.DrawImage($image, (New-Object System.Drawing.Rectangle $offset, $offset, $size, $size))
  $graphics.Dispose()
  $bitmap.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
}

Save-Icon 16 16 'favicon-16.png' ''
Save-Icon 32 32 'favicon-32.png' ''
# 180：放大整數 7 倍（168）置中，背景用 Studio 深色底，iOS 不支援透明背景。
Save-Icon 180 168 'apple-touch-icon.png' '#1a1c2c'
$image.Dispose()
Get-ChildItem $out -Filter '*.png' | ForEach-Object { "$($_.Name) $($_.Length) bytes" }
