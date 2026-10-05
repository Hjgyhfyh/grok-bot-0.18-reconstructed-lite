Add-Type -AssemblyName System.Drawing
$methods = [System.Drawing.Graphics].GetMethods() | Where-Object { $_.Name -eq 'CopyFromScreen' }
foreach ($m in $methods) { Write-Output $m.ToString() }