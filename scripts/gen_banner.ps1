Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconPath = Join-Path $root "android\app\src\main\res\mipmap-xxxhdpi\ic_launcher.png"
$outPath = Join-Path $root "android\app\src\main\res\drawable\tv_banner.png"

$width = 320
$height = 180

$bmp = New-Object System.Drawing.Bitmap($width, $height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

$rect = New-Object System.Drawing.Rectangle(0, 0, $width, $height)
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 8, 13, 24),
    [System.Drawing.Color]::FromArgb(255, 20, 33, 56),
    30
)
$g.FillRectangle($bg, $rect)

# 右侧柔和光晕
$glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowPath.AddEllipse(150, -50, 260, 280)
$glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
$glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(60, 34, 211, 238)
$glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 34, 211, 238))
$g.FillPath($glowBrush, $glowPath)

$icon = [System.Drawing.Image]::FromFile($iconPath)
$g.DrawImage($icon, 30, 44, 92, 92)

$titleFont = New-Object System.Drawing.Font("Segoe UI", 38, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$titleBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 233, 238, 251))
$g.DrawString("VCall", $titleFont, $titleBrush, 132, 52)

$subFont = New-Object System.Drawing.Font("Segoe UI", 12, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$subBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 139, 155, 184))
$g.DrawString("VIDEO CALL", $subFont, $subBrush, 136, 102)

$lineBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(210, 34, 211, 238))
$g.FillRectangle($lineBrush, 136, 122, 42, 3)

$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)

$g.Dispose()
$bmp.Dispose()
$icon.Dispose()
$bg.Dispose()
$glowBrush.Dispose()
$titleFont.Dispose()
$titleBrush.Dispose()
$subFont.Dispose()
$subBrush.Dispose()
$lineBrush.Dispose()
$glowPath.Dispose()

Write-Output "banner written: $outPath"
