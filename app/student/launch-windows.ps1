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
    if ($output) { try { Add-Content -Encoding UTF8 $output $_.Exception.Message } catch {} }
    Write-Host '程序启动失败。请把日志文件直接发给帮你安装的人，不用打开或拍照。'
    Write-Host '在日志文件夹里，找到 start-error（可能显示为 start-error.log），以及 launch 开头的所有日志文件，把它们一起发送；找不到 start-error 时，先发送 launch 开头的日志文件。'
    if ($root) {
        $logs = Join-Path $root 'runtime'
        Write-Host ('日志文件夹：' + $logs)
        try { Start-Process -FilePath 'explorer.exe' -ArgumentList ('"{0}"' -f $logs) | Out-Null } catch {}
    }
    Write-Host '如果文件夹没有自动打开，请回到程序文件夹，双击 runtime 文件夹。不要删除已有设置和费用记录。'
    exit 1
}
