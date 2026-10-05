param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$W,
  [Parameter(Mandatory = $true)][int]$H,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if ($W -le 0 -or $H -le 0) { throw "Rectangle is empty: $W x $H" }

# .NET отдаёт здесь перегрузку CopyFromScreen(int,int,int,int,Size): пятый
# аргумент это Size, а не CopyPixelOperation. PowerShell не угадывает.
$size = New-Object System.Drawing.Size($W, $H)
$bitmap = New-Object System.Drawing.Bitmap($W, $H)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($X, $Y, 0, 0, $size)
  $bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
}
finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
Write-Output "SAVED $Out"