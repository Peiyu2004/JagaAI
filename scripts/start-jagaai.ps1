#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$SkipAI,
    [switch]$SetupOnly,
    [switch]$Empty,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$V3Root = Join-Path $RepoRoot 'v3'
$Runtime = Join-Path $RepoRoot '.runtime'
$SetupDir = Join-Path $Runtime 'setup'
$Python = Join-Path $V3Root '.venv\Scripts\python.exe'

function Invoke-Checked {
    param([string]$File, [string[]]$CommandArgs)
    & $File @CommandArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed (exit $LASTEXITCODE): $File $($CommandArgs -join ' ')"
    }
}

function Test-Port {
    param([int]$Port)
    $client = New-Object Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(300)) { return $false }
        $client.EndConnect($pending)
        return $true
    } catch { return $false } finally { $client.Dispose() }
}

function Get-VerifiedArchive {
    param([string]$Url, [string]$Name, [string]$Sha256, [string]$Destination)
    $archive = Join-Path $SetupDir $Name
    if (-not (Test-Path -LiteralPath $archive) -or
        (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $Sha256) {
        Write-Host "Downloading $Name ..."
        $partial = "$archive.partial"
        # curl ships with supported Windows 10/11; retry interrupted connections.
        Invoke-Checked 'curl.exe' @('--fail', '--location', '--retry', '3', '--connect-timeout', '30',
            '--output', $partial, $Url)
        if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $Sha256) {
            throw "SHA-256 verification failed for $Name. Run the launcher again to retry."
        }
        Move-Item -LiteralPath $partial -Destination $archive -Force
    }
    Write-Host "Extracting verified $Name ..."
    Expand-Archive -LiteralPath $archive -DestinationPath $Destination -Force
}

function Get-Node {
    $portable = Join-Path $Runtime 'node-v24.22.0-win-x64\node.exe'
    $system = Get-Command node.exe -ErrorAction SilentlyContinue
    foreach ($candidate in @($portable, $(if ($system) { $system.Source }))) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            $version = & $candidate -p 'process.versions.node'
            if ($LASTEXITCODE -eq 0 -and $version -match '^24\.(\d+)\.' -and [int]$Matches[1] -ge 11) {
                return $candidate
            }
        }
    }
    Get-VerifiedArchive 'https://nodejs.org/dist/v24.22.0/node-v24.22.0-win-x64.zip' `
        'node-v24.22.0-win-x64.zip' 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3' $Runtime
    return $portable
}

function Install-PythonEnvironment {
    $uv = Join-Path $Runtime 'uv\uv.exe'
    if (-not (Test-Path -LiteralPath $uv)) {
        Get-VerifiedArchive 'https://github.com/astral-sh/uv/releases/download/0.13.1/uv-x86_64-pc-windows-msvc.zip' `
            'uv-x86_64-pc-windows-msvc.zip' '3b2661a463a5baea7f5076ea2b25ab71d77f36a6c0d809e5350651792f80a672' (Split-Path -Parent $uv)
    }
    # uv supplies Python locally, including on machines with no Python installed.
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $Runtime 'python'
    $env:UV_CACHE_DIR = Join-Path $Runtime 'uv-cache'
    if (Test-Path -LiteralPath $Python) {
        & $Python -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) and sys.maxsize > 2**32 else 1)'
        if ($LASTEXITCODE -eq 0) { return }
        throw 'v3\.venv is not a working 64-bit Python 3.12 environment. Rename that folder and run again.'
    }
    if (Test-Path -LiteralPath (Join-Path $V3Root '.venv')) {
        throw 'v3\.venv is incomplete. Rename that folder and run again to create a fresh environment.'
    }
    Invoke-Checked $uv @('venv', '--python', '3.12', '--managed-python', (Join-Path $V3Root '.venv'))
}

function Get-InputFingerprint {
    param([string[]]$Paths, [string]$Variant)
    $parts = @($Variant)
    foreach ($path in $Paths) { $parts += (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
    return $parts -join ':'
}

function Install-NpmDependencies {
    param([string]$Directory, [string]$Name, [string]$Npm)
    $fingerprint = Get-InputFingerprint @((Join-Path $Directory 'package.json'), (Join-Path $Directory 'package-lock.json')) 'node24-dev'
    $stamp = Join-Path $SetupDir "$Name.txt"
    $needed = @('node_modules\@types\node\package.json', 'node_modules\vite\bin\vite.js')
    if ($Name -eq 'root-npm') {
        $needed += @('node_modules\ffmpeg-static\ffmpeg.exe', 'node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe')
    }
    $ready = @($needed | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Directory $_)) }).Count -eq 0
    if ($ready -and (Test-Path -LiteralPath $stamp) -and (Get-Content -LiteralPath $stamp -Raw).Trim() -eq $fingerprint) {
        Write-Host "$Name dependencies are ready."
        return
    }
    Push-Location -LiteralPath $Directory
    try { Invoke-Checked $Npm @('ci', '--include=dev', '--no-audit', '--no-fund') }
    finally { Pop-Location }
    Set-Content -LiteralPath $stamp -Value $fingerprint -Encoding ASCII
}

function Install-BackendDependencies {
    $uv = Join-Path $Runtime 'uv\uv.exe'
    $mode = (& $Python -c "from backend.app.gpu import selected_gpu; print('cuda' if selected_gpu() else 'cpu')")
    if ($LASTEXITCODE -ne 0) { throw 'Could not detect the AI device.' }
    $requirements = Join-Path $V3Root ('backend\requirements-' + $(if ($mode -eq 'cuda') { 'vision' } else { 'cpu' }) + '.txt')
    $paths = @('requirements.txt', 'requirements-vision-common.txt', 'requirements-vision.txt', 'requirements-cpu.txt') |
        ForEach-Object { Join-Path $V3Root "backend\$_" }
    $fingerprint = Get-InputFingerprint $paths $mode
    $stamp = Join-Path $SetupDir 'backend.txt'
    if ((Test-Path -LiteralPath $stamp) -and (Get-Content -LiteralPath $stamp -Raw).Trim() -eq $fingerprint) {
        & $Python -c 'import fastapi, uvicorn, sqlmodel, multipart, httpx, PIL, numpy, cv2, onnxruntime, supervision, tzdata'
        if ($LASTEXITCODE -eq 0) { Write-Host "Backend dependencies are ready ($mode)."; return }
    }
    Write-Host "Installing Python dependencies ($mode) ..."
    # CPU and GPU wheels share the same module; remove the other distribution before switching.
    $other = if ($mode -eq 'cuda') { 'onnxruntime' } else { 'onnxruntime-gpu' }
    Invoke-Checked $uv @('pip', 'uninstall', '--python', $Python, $other)
    Invoke-Checked $uv @('pip', 'install', '--python', $Python, '-r', $requirements)
    Invoke-Checked $uv @('pip', 'check', '--python', $Python)
    Invoke-Checked $Python @('-c', 'import fastapi, uvicorn, sqlmodel, multipart, httpx, PIL, numpy, cv2, onnxruntime, supervision, tzdata')
    Set-Content -LiteralPath $stamp -Value $fingerprint -Encoding ASCII
}

function Get-OllamaModels {
    # Never send a loopback request through a system proxy. Allow GPU discovery at startup.
    $request = [Net.WebRequest]::Create('http://127.0.0.1:11435/api/tags')
    $request.Proxy = $null
    $request.Timeout = 30000
    $response = $request.GetResponse()
    try {
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        try { return ($reader.ReadToEnd() | ConvertFrom-Json).models.name }
        finally { $reader.Dispose() }
    } finally { $response.Dispose() }
}

function Install-LocalAI {
    $ollama = Join-Path $Runtime 'ollama\ollama.exe'
    $installed = Get-Command ollama.exe -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $ollama)) {
        if ($installed) { $ollama = $installed.Source }
        else {
            Write-Host 'The portable Ollama download is about 1.5 GB; models require additional space.'
            Get-VerifiedArchive 'https://github.com/ollama/ollama/releases/download/v0.40.6/ollama-windows-amd64.zip' `
                'ollama-windows-amd64.zip' 'e359637575302f288d76c0007c408a4be9c7376d59c4f28684d63b232a44b427' (Split-Path -Parent $ollama)
        }
    }
    # Match run.py's model-store selection exactly, even if another Ollama server is running.
    $env:OLLAMA_HOST = '127.0.0.1:11435'
    $env:OLLAMA_NO_CLOUD = '1'
    if ($ollama -eq (Join-Path $Runtime 'ollama\ollama.exe')) {
        $env:OLLAMA_MODELS = Join-Path $Runtime 'models'
    }
    if (Test-Port 11435) { throw 'Port 11435 is in use. Close the existing JagaAI session before installing AI.' }
    $server = Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $SetupDir 'ollama-setup.log') `
        -RedirectStandardError (Join-Path $SetupDir 'ollama-setup-error.log')
    try {
        $ready = $false
        for ($attempt = 0; $attempt -lt 120; $attempt++) {
            if ($server.HasExited) { throw 'Ollama stopped during setup. See .runtime\setup\ollama-setup-error.log.' }
            if (Test-Port 11435) { $ready = $true; break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $ready) { throw 'Ollama did not start within 60 seconds.' }
        $available = @(Get-OllamaModels)
        foreach ($model in @('qwen3-embedding:0.6b', 'qwen3-vl:2b-instruct')) {
            if ($model -notin $available) { Invoke-Checked $ollama @('pull', $model) }
            else { Write-Host "$model is already installed." }
        }
        $models = @(Get-OllamaModels)
        foreach ($model in @('qwen3-embedding:0.6b', 'qwen3-vl:2b-instruct')) {
            if ($model -notin $models) { throw "Ollama did not install $model." }
        }
    } finally {
        # Stop only this setup's server, never an existing system-wide Ollama.
        if (-not $server.HasExited) {
            & taskkill.exe /PID $server.Id /T /F | Out-Null
            $server.WaitForExit(10000) | Out-Null
        }
        $server.Dispose()
    }
}

function Start-JagaAI {
    if (-not [Environment]::Is64BitOperatingSystem -or
        $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
        throw 'This one-click launcher supports Windows 10/11 x64. See v3/README.md for manual setup.'
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    New-Item -ItemType Directory -Path $SetupDir -Force | Out-Null
    Start-Transcript -Path (Join-Path $SetupDir 'setup.log') -Append | Out-Null
    Push-Location -LiteralPath $V3Root
    try {
        Write-Host 'JagaAI v3: automatic setup and launch'
        if (-not $SetupOnly) {
            $busy = @(5174, 8766, 11435 | Where-Object { Test-Port $_ })
            if ($busy.Count) { throw "Ports already in use: $($busy -join ', '). Close the existing JagaAI session and try again." }
        }
        $node = Get-Node
        $env:PATH = (Split-Path -Parent $node) + ';' + $env:PATH
        $env:npm_config_cache = Join-Path $Runtime 'npm-cache'
        $npm = Join-Path (Split-Path -Parent $node) 'npm.cmd'
        Write-Host "Node.js: $(& $node --version)"
        Install-PythonEnvironment
        Install-BackendDependencies
        Install-NpmDependencies $RepoRoot 'root-npm' $npm
        Install-NpmDependencies (Join-Path $V3Root 'frontend') 'v3-npm' $npm
        $tools = Join-Path $V3Root 'tools'
        New-Item -ItemType Directory -Path $tools -Force | Out-Null
        foreach ($tool in @(
            @('node_modules\ffmpeg-static\ffmpeg.exe', 'ffmpeg.exe'),
            @('node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe', 'ffprobe.exe')
        )) {
            $target = Join-Path $tools $tool[1]
            if (-not (Test-Path -LiteralPath $target)) {
                Copy-Item -LiteralPath (Join-Path $RepoRoot $tool[0]) -Destination $target
            }
            Invoke-Checked $target @('-version') | Out-Null
        }
        if (-not (Test-Path -LiteralPath (Join-Path $V3Root 'models\yolox_s.onnx'))) {
            throw 'The detector model is missing. Pull the complete repository, including v3/models/yolox_s.onnx.'
        }
        if ($SkipAI) { Write-Host 'Skipping Ollama/model downloads. Existing local AI can still be used.' }
        else { Install-LocalAI }
        Write-Host 'Setup complete. Local data and accounts have been preserved.'
        if (-not $SetupOnly) {
            $launch = @((Join-Path $V3Root 'run.py'))
            if (-not $Empty) { $launch += '--demo' }
            if ($NoBrowser) { $launch += '--no-browser' }
            Invoke-Checked $Python $launch
        }
    } finally {
        Pop-Location
        Stop-Transcript | Out-Null
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Start-JagaAI } catch {
        $message = "ERROR: $($_.Exception.Message)"
        if (Test-Path -LiteralPath $SetupDir) {
            Add-Content -LiteralPath (Join-Path $SetupDir 'setup.log') -Value $message
        }
        Write-Host "`n$message" -ForegroundColor Red
        exit 1
    }
}
