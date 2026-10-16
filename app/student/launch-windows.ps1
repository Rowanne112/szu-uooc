$ErrorActionPreference = 'Stop'
try {
    $root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
    $node = Join-Path $root 'runtime/windows-x64/node.exe'
    $script = Join-Path $root 'app/student/start.mjs'
    $id = [guid]::NewGuid().ToString('N')
    $ready = Join-Path $root ('runtime/launch-' + $id + '.json')
    $output = Join-Path $root ('runtime/launch-' + $id + '.log')
    $errors = Join-Path $root ('runtime/launch-' + $id + '-error.log')
    $arguments = '"{0}" --ready-file "{1}"' -f $script, $ready
    $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $output -RedirectStandardError $errors -PassThru
    for ($i = 0; $i -lt 40; $i++) {
        if (Test-Path $ready) { Remove-Item -Force $ready; Write-Host 'szu-uooc 控制台已打开，可以关闭这个窗口。'; exit 0 }
        if ($process.HasExited) { throw '控制台没有成功打开，请查看下面的原因后重新启动。' }
        Start-Sleep -Milliseconds 250
        $process.Refresh()
    }
    throw '控制台启动超时，请检查电脑和网络后重新启动。'
} catch {
    Write-Host ('启动未完成：' + $_.Exception.Message)
    if ($errors -and (Test-Path $errors)) { Get-Content -Encoding UTF8 $errors | Select-Object -Last 5 | Write-Host }
    exit 1
}
