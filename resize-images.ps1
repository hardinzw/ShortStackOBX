# Makes web-sized copies of the photos in images/ and saves them to images/web/.
# Full-size camera photos (8000+ px) look grainy when the browser shrinks them down,
# so the page should use these copies instead. Re-run after adding new photos:
#   powershell -File resize-images.ps1
param([int]$MaxWidth = 2048, [int]$Quality = 85)

Add-Type -AssemblyName System.Drawing
$src = Join-Path $PSScriptRoot "images"
$out = Join-Path $src "web"
New-Item -ItemType Directory -Force $out | Out-Null

$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq "image/jpeg"
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$Quality)

Get-ChildItem $src -File -Include *.jpg, *.jpeg, *.png -Recurse:$false -Path "$src\*" | ForEach-Object {
  $dest = Join-Path $out ($_.BaseName + ".jpg")
  if ((Test-Path $dest) -and (Get-Item $dest).LastWriteTime -ge $_.LastWriteTime) { return }

  $img = [System.Drawing.Image]::FromFile($_.FullName)
  # Respect the camera's EXIF orientation so portrait shots aren't sideways
  if ($img.PropertyIdList -contains 0x0112) {
    switch ($img.GetPropertyItem(0x0112).Value[0]) {
      3 { $img.RotateFlip("Rotate180FlipNone") }
      6 { $img.RotateFlip("Rotate90FlipNone") }
      8 { $img.RotateFlip("Rotate270FlipNone") }
    }
  }
  $w = [Math]::Min($MaxWidth, $img.Width)
  $h = [int]($img.Height * $w / $img.Width)

  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = "HighQualityBicubic"
  $g.SmoothingMode = "HighQuality"
  $g.PixelOffsetMode = "HighQuality"
  $g.DrawImage($img, 0, 0, $w, $h)
  $bmp.Save($dest, $codec, $params)

  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
  "{0} -> {1}x{2}" -f $_.Name, $w, $h
}
