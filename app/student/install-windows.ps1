param([switch]$NodeOnly)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '../..')
$root = (Get-Location).Path
$runtime = Join-Path $root 'runtime/windows-x64'
$node = Join-Path $runtime 'node.exe'
$lock = Join-Path $root 'runtime/.install-lock'
$temp = $null
$locked = $false
try {
    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') {
        throw '本入口适用 Windows 10/11 x64，暂不支持这台电脑的处理器。'
    }
    if (Test-Path $node) {
        $ready = $false
        try {
            if ($NodeOnly) { & $node --version *> $null } else { & $node 'app/student/start.mjs' --check *> $null }
            $ready = $LASTEXITCODE -eq 0
        } catch { $ready = $false }
        if ($ready) {
            if ($NodeOnly) { exit 0 }
            Write-Host '依赖已经齐全，无需再次下载。现在可以双击「启动-Windows.cmd」。'
            exit 0
        }
    }
    New-Item -ItemType Directory -Force (Join-Path $root 'runtime') | Out-Null
    try { New-Item -ItemType Directory $lock -ErrorAction Stop | Out-Null }
    catch { throw '已有下载窗口正在运行，请回到原窗口等待完成。' }
    $locked = $true
    $temp = Join-Path $root ('runtime/.download-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory $temp | Out-Null
    $filename = 'node-v24.21.0-win-x64.zip'
    $runtimeReady = $false
    if ((Test-Path $node) -and (Test-Path (Join-Path $runtime 'node_modules/npm/bin/npm-cli.js'))) {
        try {
            & $node --version *> $null
            $runtimeReady = $LASTEXITCODE -eq 0
        } catch { $runtimeReady = $false }
    }
    if (-not $runtimeReady) {
        Write-Host '[1/3] 下载这台 Windows 电脑的运行环境，请保持联网……'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $archive = Join-Path $temp $filename
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 900 -Uri ('https://nodejs.org/dist/v24.21.0/' + $filename) -OutFile $archive
        Write-Host '[2/3] 校验并解压运行环境……'
        $line = @(Get-Content -Encoding UTF8 (Join-Path $root '依赖校验.sha256') | Where-Object { ($_ -split '\s+')[1] -eq $filename })
        if ($line.Count -ne 1) { throw '依赖校验文件不完整，请重新解压 ZIP。' }
        $expected = ($line[0] -split '\s+')[0]
        if ((Get-FileHash -Algorithm SHA256 $archive).Hash -ne $expected) { throw '下载文件校验失败，请重新点击下载依赖。' }
        Expand-Archive -LiteralPath $archive -DestinationPath $temp
        if (Test-Path $runtime) { Remove-Item -Recurse -Force $runtime }
        Move-Item -LiteralPath (Join-Path $temp 'node-v24.21.0-win-x64') -Destination $runtime
    }
    if ($NodeOnly) {
        Write-Host '运行环境准备完成，正在打开 szu-uooc 控制台……'
        exit 0
    }
    Write-Host '[3/3] 下载浏览器连接组件……'
    $env:PATH = $runtime + ';' + $env:PATH
    $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
    Push-Location (Join-Path $root 'app')
    try {
        & $node (Join-Path $runtime 'node_modules/npm/bin/npm-cli.js') ci --ignore-scripts --omit=optional --no-audit --no-fund --registry=https://registry.npmjs.org --cache (Join-Path $root 'runtime/npm-cache')
        if ($LASTEXITCODE -ne 0) { throw '组件下载失败，请检查网络后重新点击下载依赖。' }
    } finally { Pop-Location }
    & $node 'app/student/start.mjs' --check
    if ($LASTEXITCODE -ne 0) { throw '依赖自检失败，请重新点击下载依赖。' }
    Write-Host '下载完成。现在可以双击「启动-Windows.cmd」；以后无需重复下载。'
} catch {
    Write-Host ('下载未完成：' + $_.Exception.Message)
    Write-Host '检查网络后，重新双击「下载依赖-Windows.cmd」重试。'
    exit 1
} finally {
    if ($temp -and (Test-Path $temp)) { Remove-Item -Recurse -Force $temp }
    if ($locked) { Remove-Item -Force $lock }
}
