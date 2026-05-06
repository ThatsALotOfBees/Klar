# Klar dev shell -- defines convenience commands for running and inspecting
# the server. Loaded by klar.cmd (or dot-source it yourself: `. .\shell.ps1`).

$KlarRoot       = $PSScriptRoot
$Global:KlarPort     = if ($env:PORT) { [int]$env:PORT } else { 3000 }
$Global:KlarLogFile  = Join-Path $KlarRoot 'klar.log'
$Global:KlarErrFile  = Join-Path $KlarRoot 'klar.err.log'
$Global:KlarPidFile  = Join-Path $KlarRoot '.klar.pid'
$Global:KlarDbFile   = Join-Path $KlarRoot 'klar.db'
$Global:KlarPkgFile  = Join-Path $KlarRoot 'package.json'

Set-Location $KlarRoot

function Get-KlarPid {
    if (-not (Test-Path $Global:KlarPidFile)) { return $null }
    $raw = Get-Content $Global:KlarPidFile -ErrorAction SilentlyContinue
    if (-not $raw) { return $null }
    $procPid = 0
    if (-not [int]::TryParse($raw.Trim(), [ref]$procPid)) {
        Remove-Item $Global:KlarPidFile -Force -ErrorAction SilentlyContinue
        return $null
    }
    $proc = Get-Process -Id $procPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -match 'node') { return $procPid }
    Remove-Item $Global:KlarPidFile -Force -ErrorAction SilentlyContinue
    return $null
}

function Test-KlarSetup {
    if (-not (Test-Path (Join-Path $KlarRoot 'node_modules'))) {
        Write-Host "node_modules missing - run 'setup' first." -ForegroundColor Yellow
        return $false
    }
    return $true
}

function Klar-Help {
    Write-Host ""
    Write-Host "  Klar dev shell" -ForegroundColor Cyan
    Write-Host "  --------------" -ForegroundColor DarkGray
    $rows = @(
        ,@('help',       'Show this help')
        ,@('serve',      'Run server in foreground (Ctrl+C to stop)')
        ,@('up',         'Start server in background, log to klar.log')
        ,@('down',       'Stop the background server')
        ,@('restart',    'Stop, then start in background')
        ,@('status',     'Show running state, port, pid, db size')
        ,@('logs [-n N]','Show last N lines of klar.log (default 50)')
        ,@('tail',       'Follow klar.log live (Ctrl+C to stop)')
        ,@('open-app',   'Open http://localhost:<port> in default browser')
        ,@('port [n]',   'Show or set the server port')
        ,@('reset-db',   'Delete the SQLite database (prompts)')
        ,@('setup',      'Run npm install')
        ,@('clean',      'Remove node_modules, db, logs (prompts)')
        ,@('home',       'cd back to the project root')
        ,@('app',        'Launch the Electron desktop app (frameless window)')
        ,@('dist',       'Build a portable .exe of the desktop app (slow first time)')
        ,@('release-client [v]', 'Snapshot public/ as a new entry in client-releases/')
        ,@('tunnel [-Subdomain]', 'Open a public *.loca.lt URL pointing at the local server (for cross-network testing)')
    )
    foreach ($r in $rows) {
        Write-Host ("  {0,-22}" -f $r[0]) -NoNewline -ForegroundColor Green
        Write-Host $r[1] -ForegroundColor Gray
    }
    Write-Host ""
}
Set-Alias help Klar-Help -Force -Scope Global -Option AllScope -ErrorAction SilentlyContinue

function Invoke-KlarServe {
    if (-not (Test-KlarSetup)) { return }
    if (Get-KlarPid) {
        Write-Host "A background server is already running. Run 'down' first or 'logs' to inspect." -ForegroundColor Yellow
        return
    }
    Write-Host "Starting Klar on http://localhost:$($Global:KlarPort) - Ctrl+C to stop." -ForegroundColor Cyan
    $env:PORT = "$($Global:KlarPort)"
    & node --disable-warning=ExperimentalWarning (Join-Path $KlarRoot 'server.js')
}
Set-Alias serve Invoke-KlarServe -Scope Global

function Start-KlarBackground {
    if (-not (Test-KlarSetup)) { return }
    $existing = Get-KlarPid
    if ($existing) {
        Write-Host "Already running (pid $existing) on port $($Global:KlarPort)." -ForegroundColor Yellow
        return
    }
    if (Test-Path $Global:KlarLogFile) { Remove-Item $Global:KlarLogFile -Force }
    if (Test-Path $Global:KlarErrFile) { Remove-Item $Global:KlarErrFile -Force }
    $env:PORT = "$($Global:KlarPort)"
    $proc = Start-Process node `
        -ArgumentList '--disable-warning=ExperimentalWarning', (Join-Path $KlarRoot 'server.js') `
        -WorkingDirectory $KlarRoot `
        -RedirectStandardOutput $Global:KlarLogFile `
        -RedirectStandardError  $Global:KlarErrFile `
        -WindowStyle Hidden `
        -PassThru
    "$($proc.Id)" | Set-Content -Path $Global:KlarPidFile -Encoding ascii
    Start-Sleep -Milliseconds 600
    if (Get-KlarPid) {
        Write-Host "Klar started (pid $($proc.Id)) on http://localhost:$($Global:KlarPort)" -ForegroundColor Green
        Write-Host "Logs: $Global:KlarLogFile  (use 'logs' or 'tail')" -ForegroundColor DarkGray
    } else {
        Write-Host "Server crashed during startup. Last log lines:" -ForegroundColor Red
        if (Test-Path $Global:KlarErrFile) { Get-Content $Global:KlarErrFile -Tail 20 }
        if (Test-Path $Global:KlarLogFile) { Get-Content $Global:KlarLogFile -Tail 20 }
    }
}
Set-Alias up Start-KlarBackground -Scope Global

function Stop-KlarBackground {
    $serverPid = Get-KlarPid
    if (-not $serverPid) {
        Write-Host "No background server running." -ForegroundColor DarkGray
        return
    }
    try {
        Stop-Process -Id $serverPid -Force -ErrorAction Stop
        Write-Host "Stopped pid $serverPid." -ForegroundColor Green
    } catch {
        Write-Host "Failed to stop pid ${serverPid}: $($_.Exception.Message)" -ForegroundColor Red
    }
    Remove-Item $Global:KlarPidFile -Force -ErrorAction SilentlyContinue
}
Set-Alias down Stop-KlarBackground -Scope Global

function Restart-KlarBackground {
    Stop-KlarBackground
    Start-Sleep -Milliseconds 300
    Start-KlarBackground
}
Set-Alias restart Restart-KlarBackground -Scope Global

function Get-KlarStatus {
    $serverPid = Get-KlarPid
    Write-Host ""
    Write-Host "  Klar status" -ForegroundColor Cyan
    Write-Host "  -----------" -ForegroundColor DarkGray
    if ($serverPid) {
        Write-Host ("  state    : ") -NoNewline -ForegroundColor DarkGray
        Write-Host "running" -ForegroundColor Green
        Write-Host ("  pid      : $serverPid") -ForegroundColor Gray
    } else {
        Write-Host ("  state    : ") -NoNewline -ForegroundColor DarkGray
        Write-Host "stopped" -ForegroundColor Yellow
    }
    Write-Host ("  port     : $($Global:KlarPort)") -ForegroundColor Gray
    Write-Host ("  url      : http://localhost:$($Global:KlarPort)") -ForegroundColor Gray
    if (Test-Path $Global:KlarDbFile) {
        $size = (Get-Item $Global:KlarDbFile).Length
        Write-Host ("  database : $('{0:N0}' -f $size) bytes  ($Global:KlarDbFile)") -ForegroundColor Gray
    } else {
        Write-Host ("  database : (none yet)") -ForegroundColor DarkGray
    }
    if (Test-Path $Global:KlarLogFile) {
        $logSize = (Get-Item $Global:KlarLogFile).Length
        Write-Host ("  log      : $('{0:N0}' -f $logSize) bytes  ($Global:KlarLogFile)") -ForegroundColor Gray
    }
    Write-Host ""
}
Set-Alias status Get-KlarStatus -Scope Global

function Show-KlarLogs {
    [CmdletBinding()]
    param([int]$n = 50)
    if (-not (Test-Path $Global:KlarLogFile)) {
        Write-Host "No log file yet - run 'up' first." -ForegroundColor DarkGray
        return
    }
    Get-Content $Global:KlarLogFile -Tail $n
    if ((Test-Path $Global:KlarErrFile) -and (Get-Item $Global:KlarErrFile).Length -gt 0) {
        Write-Host "--- stderr ---" -ForegroundColor Yellow
        Get-Content $Global:KlarErrFile -Tail $n
    }
}
Set-Alias logs Show-KlarLogs -Scope Global

function Watch-KlarLogs {
    if (-not (Test-Path $Global:KlarLogFile)) {
        Write-Host "No log file yet - run 'up' first." -ForegroundColor DarkGray
        return
    }
    Write-Host "Following $Global:KlarLogFile  (Ctrl+C to stop)" -ForegroundColor Cyan
    Get-Content $Global:KlarLogFile -Wait -Tail 30
}
Set-Alias tail Watch-KlarLogs -Scope Global

function Open-KlarApp {
    $url = "http://localhost:$($Global:KlarPort)"
    Write-Host "Opening $url" -ForegroundColor Cyan
    Start-Process $url
}
Set-Alias open-app Open-KlarApp -Scope Global

function Set-KlarPort {
    [CmdletBinding()]
    param([int]$n = 0)
    if ($n -le 0) {
        Write-Host "Current port: $($Global:KlarPort)" -ForegroundColor Gray
        return
    }
    if ($n -lt 1 -or $n -gt 65535) {
        Write-Host "Port must be between 1 and 65535." -ForegroundColor Red
        return
    }
    $Global:KlarPort = $n
    $env:PORT = "$n"
    Write-Host "Port set to $n. Restart the server for it to take effect." -ForegroundColor Green
}
Set-Alias port Set-KlarPort -Scope Global

function Reset-KlarDb {
    if (Get-KlarPid) {
        Write-Host "Stop the server first ('down') before resetting the database." -ForegroundColor Yellow
        return
    }
    $files = @($Global:KlarDbFile, "$($Global:KlarDbFile)-wal", "$($Global:KlarDbFile)-shm", "$($Global:KlarDbFile)-journal") |
             Where-Object { Test-Path $_ }
    if (-not $files) {
        Write-Host "No database files to remove." -ForegroundColor DarkGray
        return
    }
    Write-Host "About to delete:" -ForegroundColor Yellow
    foreach ($f in $files) { Write-Host "  $f" -ForegroundColor Gray }
    $ans = Read-Host "Type 'yes' to confirm"
    if ($ans -ne 'yes') {
        Write-Host "Cancelled." -ForegroundColor DarkGray
        return
    }
    foreach ($f in $files) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
    Write-Host "Database reset." -ForegroundColor Green
}
Set-Alias reset-db Reset-KlarDb -Scope Global

function Install-KlarDeps {
    Write-Host "npm install" -ForegroundColor Cyan
    & npm install --no-audit --no-fund
}
Set-Alias setup Install-KlarDeps -Scope Global

function Clean-Klar {
    if (Get-KlarPid) {
        Write-Host "Stop the server first ('down') before cleaning." -ForegroundColor Yellow
        return
    }
    Write-Host "Will remove: node_modules, klar.db (and SQLite sidecars), klar.log, klar.err.log, .klar.pid" -ForegroundColor Yellow
    $ans = Read-Host "Type 'yes' to confirm"
    if ($ans -ne 'yes') {
        Write-Host "Cancelled." -ForegroundColor DarkGray
        return
    }
    $targets = @(
        (Join-Path $KlarRoot 'node_modules'),
        $Global:KlarDbFile,
        "$($Global:KlarDbFile)-wal",
        "$($Global:KlarDbFile)-shm",
        "$($Global:KlarDbFile)-journal",
        $Global:KlarLogFile,
        $Global:KlarErrFile,
        $Global:KlarPidFile
    )
    foreach ($t in $targets) {
        if (Test-Path $t) {
            Remove-Item $t -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "  removed $t" -ForegroundColor DarkGray
        }
    }
    Write-Host "Clean." -ForegroundColor Green
}
Set-Alias clean Clean-Klar -Scope Global

function Goto-KlarHome { Set-Location $KlarRoot }
Set-Alias home Goto-KlarHome -Scope Global

function Invoke-KlarTunnel {
    [CmdletBinding()]
    param(
        [string]$Subdomain = '',
        [switch]$NoStart
    )
    if (-not (Test-Path (Join-Path $KlarRoot 'node_modules\localtunnel'))) {
        Write-Host "localtunnel not installed. Run 'setup' first." -ForegroundColor Yellow
        return
    }

    # Make sure the local server is up before opening the tunnel — otherwise
    # localtunnel's URL would point at nothing.
    if (-not $NoStart) {
        $serverPid = Get-KlarPid
        if (-not $serverPid) {
            Write-Host "No local server running on port $($Global:KlarPort). Starting..." -ForegroundColor Cyan
            Start-KlarBackground
            Start-Sleep -Milliseconds 800
            if (-not (Get-KlarPid)) {
                Write-Host "Server didn't start cleanly. Check logs and retry." -ForegroundColor Red
                return
            }
        } else {
            Write-Host "Local server already running on port $($Global:KlarPort) (pid $serverPid)." -ForegroundColor DarkGray
        }
    }

    Write-Host ""
    Write-Host "  ============================================================" -ForegroundColor DarkGray
    Write-Host "  Opening public tunnel to localhost:$($Global:KlarPort)..." -ForegroundColor Cyan
    Write-Host "  Anyone with the printed URL can reach your local server." -ForegroundColor DarkGray
    Write-Host "  Ctrl+C to close the tunnel; the local server keeps running." -ForegroundColor DarkGray
    Write-Host "  ============================================================" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Tester instructions (copy-paste this for them):" -ForegroundColor Yellow
    Write-Host "    1. Install Klar from your dist\Klar-<v>.msi" -ForegroundColor Gray
    Write-Host "    2. Open cmd.exe and run:" -ForegroundColor Gray
    Write-Host "         set KLAR_SERVER_URL=<URL printed below>" -ForegroundColor Gray
    Write-Host "         start " -NoNewline -ForegroundColor Gray
    Write-Host '"' -NoNewline -ForegroundColor Gray
    Write-Host '"' -NoNewline -ForegroundColor Gray
    Write-Host " " -NoNewline -ForegroundColor Gray
    Write-Host '"%LOCALAPPDATA%\Programs\Klar\Klar.exe"' -ForegroundColor Gray
    Write-Host ""

    $ltJs = Join-Path $KlarRoot 'node_modules\localtunnel\bin\lt.js'
    $cmdArgs = @($ltJs, '--port', "$($Global:KlarPort)")
    if ($Subdomain) { $cmdArgs += @('--subdomain', $Subdomain) }
    & node @cmdArgs
}
Set-Alias tunnel Invoke-KlarTunnel -Scope Global

function Invoke-KlarReleaseClient {
    [CmdletBinding()]
    param([string]$Version = '')
    Write-Host "Snapshotting public/ into client-releases/..." -ForegroundColor Cyan
    if ($Version) { & npm run release-client -- $Version } else { & npm run release-client }
}
Set-Alias release-client Invoke-KlarReleaseClient -Scope Global

function Invoke-KlarDist {
    if (-not (Test-Path (Join-Path $KlarRoot 'node_modules\electron-builder'))) {
        Write-Host "electron-builder not installed. Run 'setup' first." -ForegroundColor Yellow
        return
    }
    Write-Host "Building Klar portable EXE (this takes a few minutes the first time)..." -ForegroundColor Cyan
    & npm run dist
    if ($LASTEXITCODE -eq 0) {
        $exe = Get-ChildItem (Join-Path $KlarRoot 'dist') -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($exe) { Write-Host "  built: $($exe.FullName)  ($('{0:N0}' -f $exe.Length) bytes)" -ForegroundColor Green }
    }
}
Set-Alias dist Invoke-KlarDist -Scope Global

function Invoke-KlarApp {
    if (-not (Test-Path (Join-Path $KlarRoot 'node_modules\electron'))) {
        Write-Host "Electron not installed. Run 'setup' first." -ForegroundColor Yellow
        return
    }
    if (Get-KlarPid) {
        Write-Host "A background server is running on port $($Global:KlarPort). The desktop app will spawn its own server on the same port and likely fail." -ForegroundColor Yellow
        Write-Host "Run 'down' first if you want the app to host its own server." -ForegroundColor Yellow
        return
    }
    Write-Host "Launching Klar desktop app..." -ForegroundColor Cyan
    # The launcher (desktop/launch.cjs) clears ELECTRON_RUN_AS_NODE before spawning
    # Electron, so this works even when the env var is set globally.
    & npm run app
}
Set-Alias app Invoke-KlarApp -Scope Global

function prompt {
    $serverPid = Get-KlarPid
    if ($serverPid) {
        Write-Host "klar " -NoNewline -ForegroundColor Cyan
        Write-Host "* " -NoNewline -ForegroundColor Green
        Write-Host ":$($Global:KlarPort) " -NoNewline -ForegroundColor DarkGreen
    } else {
        Write-Host "klar " -NoNewline -ForegroundColor Cyan
        Write-Host "o " -NoNewline -ForegroundColor DarkGray
    }
    $rel = (Get-Location).Path.Replace($KlarRoot, '~')
    if (-not $rel) { $rel = '~' }
    Write-Host "$rel " -NoNewline -ForegroundColor DarkGray
    return "$([char]0x25B8) "
}

# Banner on load
Write-Host ""
Write-Host "  Klar dev shell ready" -ForegroundColor Cyan
$pkgVer = '?'
try {
    if (Test-Path $Global:KlarPkgFile) {
        $pkgVer = (Get-Content $Global:KlarPkgFile -Raw | ConvertFrom-Json).version
    }
} catch {}
Write-Host "  v$pkgVer  |  port $($Global:KlarPort)  |  type 'help' for commands" -ForegroundColor DarkGray
Write-Host ""
