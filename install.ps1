$ErrorActionPreference = "Stop"

$Repository = if ($env:AI_REMOTE_REPOSITORY) { $env:AI_REMOTE_REPOSITORY.TrimEnd("/") } else { "https://github.com/lteu/agent" }
$Revision = if ($env:AI_REMOTE_REVISION) { $env:AI_REMOTE_REVISION } else { "main" }
$InstallRoot = if ($env:AI_REMOTE_INSTALL_DIR) { $env:AI_REMOTE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "ai-remote" }
$BinDir = Join-Path $InstallRoot "bin"
$AppDir = Join-Path $InstallRoot "app"
$ArchiveUrl = if ($env:AI_REMOTE_ARCHIVE_URL) { $env:AI_REMOTE_ARCHIVE_URL } else { "$Repository/archive/refs/heads/$Revision.zip" }

foreach ($Command in @("node", "npm.cmd")) {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "缺少 $Command。请先安装 Node.js 20 或更高版本（包含 npm）。"
    }
}

$NodeMajor = [int]((& node -p "Number(process.versions.node.split('.')[0])").Trim())
if ($NodeMajor -lt 20) {
    throw "需要 Node.js 20 或更高版本，当前版本为 $(& node --version)。"
}

$WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ai-remote-install-" + [guid]::NewGuid().ToString("N"))
$ArchivePath = Join-Path $WorkDir "source.zip"
$ExtractPath = Join-Path $WorkDir "extract"

try {
    New-Item -ItemType Directory -Path $ExtractPath -Force | Out-Null
    Write-Host "正在下载 ai-remote ($Revision)..."
    Invoke-WebRequest -Uri $ArchiveUrl -OutFile $ArchivePath -UseBasicParsing
    Expand-Archive -Path $ArchivePath -DestinationPath $ExtractPath -Force

    $SourceDir = Get-ChildItem -Path $ExtractPath -Directory | Select-Object -First 1
    if (-not $SourceDir) {
        throw "下载的压缩包中没有源码目录。"
    }

    Push-Location $SourceDir.FullName
    try {
        Write-Host "正在安装依赖并构建..."
        & npm.cmd ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci 失败。" }
        & npm.cmd run build:remote
        if ($LASTEXITCODE -ne 0) { throw "构建失败。" }
        & npm.cmd prune --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "清理开发依赖失败。" }
    }
    finally {
        Pop-Location
    }

    New-Item -ItemType Directory -Path $InstallRoot, $BinDir -Force | Out-Null
    $NewAppDir = Join-Path $InstallRoot "app.new"
    $PreviousAppDir = Join-Path $InstallRoot "app.previous"
    Remove-Item $NewAppDir -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item $SourceDir.FullName $NewAppDir
    if (Test-Path $AppDir) {
        Remove-Item $PreviousAppDir -Recurse -Force -ErrorAction SilentlyContinue
        Move-Item $AppDir $PreviousAppDir
    }
    Move-Item $NewAppDir $AppDir

    $Launcher = Join-Path $BinDir "ai-remote.cmd"
    "@echo off`r`nnode `"$AppDir\dist\remote.js`" %*`r`n" | Set-Content -Path $Launcher -Encoding Ascii

    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $PathEntries = @($UserPath -split ";" | Where-Object { $_ })
    if ($PathEntries -notcontains $BinDir) {
        $NewPath = (@($PathEntries) + $BinDir) -join ";"
        [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
        Write-Host "已将 $BinDir 加入用户 PATH；请重新打开终端。"
    }

    Write-Host ""
    Write-Host "✓ ai-remote 已安装到 $AppDir"
    Write-Host "当前服务默认通过 SSH 访问。首次运行前请确认 SSH 目标可登录，"
    Write-Host "或设置 AI_REMOTE_SSH_HOST；启用公网 HTTPS 后可设置 AI_REMOTE_URL。"
    Write-Host "验证：ai-remote usage"
}
finally {
    Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
}
