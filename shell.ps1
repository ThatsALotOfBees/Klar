# Klar dev shell -- defines convenience commands for running and inspecting
# the server. Loaded by klar.cmd (or dot-source it yourself: `. .\shell.ps1`).

$KlarRoot       = $PSScriptRoot
$Global:KlarPort           = if ($env:PORT) { [int]$env:PORT } else { 3000 }
$Global:KlarLogFile        = Join-Path $KlarRoot 'klar.log'
$Global:KlarErrFile        = Join-Path $KlarRoot 'klar.err.log'
$Global:KlarPidFile        = Join-Path $KlarRoot '.klar.pid'
$Global:KlarDbFile         = Join-Path $KlarRoot 'klar.db'
$Global:KlarPkgFile        = Join-Path $KlarRoot 'package.json'
$Global:KlarTunnelLogFile  = Join-Path $KlarRoot 'klar.tunnel.log'
$Global:KlarTunnelErrFile  = Join-Path $KlarRoot 'klar.tunnel.err.log'
$Global:KlarTunnelPidFile  = Join-Path $KlarRoot '.klar.tunnel.pid'
$Global:KlarConfigFile     = Join-Path $KlarRoot 'client-config.json'

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

function Get-KlarTunnelPid {
    if (-not (Test-Path $Global:KlarTunnelPidFile)) { return $null }
    $raw = Get-Content $Global:KlarTunnelPidFile -ErrorAction SilentlyContinue
    if (-not $raw) { return $null }
    $procPid = 0
    if (-not [int]::TryParse($raw.Trim(), [ref]$procPid)) {
        Remove-Item $Global:KlarTunnelPidFile -Force -ErrorAction SilentlyContinue
        return $null
    }
    $proc = Get-Process -Id $procPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -match 'node') { return $procPid }
    Remove-Item $Global:KlarTunnelPidFile -Force -ErrorAction SilentlyContinue
    return $null
}

function Get-KlarTunnelSubdomain {
    if (-not (Test-Path $Global:KlarConfigFile)) { return $null }
    try {
        $cfg = Get-Content $Global:KlarConfigFile -Raw | ConvertFrom-Json
        return $cfg.tunnelSubdomain
    } catch { return $null }
}

function Get-KlarTunnelUrl {
    if (-not (Test-Path $Global:KlarTunnelLogFile)) { return $null }
    $line = Select-String -Path $Global:KlarTunnelLogFile -Pattern 'https?://[^\s]+' -List -ErrorAction SilentlyContinue
    if ($line -and $line.Matches[0]) { return $line.Matches[0].Value }
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
        ,@('up [-NoTunnel]', 'Start server + public tunnel in background')
        ,@('down',       'Stop the background server + tunnel')
        ,@('restart',    'Stop, then start in background')
        ,@('status',     'Show server + tunnel state, public URL, db size')
        ,@('logs [-n N]','Show last N lines of klar.log + tunnel log (default 50)')
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
    [CmdletBinding()]
    param([switch]$NoTunnel)

    if (-not (Test-KlarSetup)) { return }
    $existing = Get-KlarPid
    if ($existing) {
        Write-Host "Already running (pid $existing) on port $($Global:KlarPort)." -ForegroundColor Yellow
        return
    }

    # ---- spawn server.js ----
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
    Start-Sleep -Milliseconds 800
    if (-not (Get-KlarPid)) {
        Write-Host "Server crashed during startup. Last log lines:" -ForegroundColor Red
        if (Test-Path $Global:KlarErrFile) { Get-Content $Global:KlarErrFile -Tail 20 }
        if (Test-Path $Global:KlarLogFile) { Get-Content $Global:KlarLogFile -Tail 20 }
        return
    }
    Write-Host "Klar server started (pid $($proc.Id)) on http://localhost:$($Global:KlarPort)" -ForegroundColor Green

    # ---- spawn tunnel (unless -NoTunnel or no localtunnel installed) ----
    if ($NoTunnel) {
        Write-Host "Tunnel skipped (-NoTunnel)." -ForegroundColor DarkGray
        return
    }
    $ltJs = Join-Path $KlarRoot 'node_modules\localtunnel\bin\lt.js'
    if (-not (Test-Path $ltJs)) {
        Write-Host "Tunnel skipped (localtunnel not installed; run 'setup')." -ForegroundColor DarkGray
        return
    }
    $sub = Get-KlarTunnelSubdomain
    $ltArgs = @($ltJs, '--port', "$($Global:KlarPort)")
    if ($sub) { $ltArgs += @('--subdomain', $sub) }

    if (Test-Path $Global:KlarTunnelLogFile) { Remove-Item $Global:KlarTunnelLogFile -Force }
    if (Test-Path $Global:KlarTunnelErrFile) { Remove-Item $Global:KlarTunnelErrFile -Force }
    $tunnelProc = Start-Process node `
        -ArgumentList $ltArgs `
        -WorkingDirectory $KlarRoot `
        -RedirectStandardOutput $Global:KlarTunnelLogFile `
        -RedirectStandardError  $Global:KlarTunnelErrFile `
        -WindowStyle Hidden `
        -PassThru
    "$($tunnelProc.Id)" | Set-Content -Path $Global:KlarTunnelPidFile -Encoding ascii
    Start-Sleep -Milliseconds 2500
    if (Get-KlarTunnelPid) {
        $url = Get-KlarTunnelUrl
        if ($url) {
            Write-Host "Klar tunnel up:  $url" -ForegroundColor Cyan
            Publish-KlarServerUrl -Url $url
        } else {
            Write-Host "Klar tunnel started (pid $($tunnelProc.Id)) but no URL yet - check 'logs'." -ForegroundColor Yellow
        }
    } else {
        Write-Host "Tunnel failed to start. Tail of klar.tunnel.log:" -ForegroundColor Red
        if (Test-Path $Global:KlarTunnelLogFile) { Get-Content $Global:KlarTunnelLogFile -Tail 20 }
    }
    Write-Host "Logs: $Global:KlarLogFile  (use 'logs' or 'tail')" -ForegroundColor DarkGray
}
Set-Alias up Start-KlarBackground -Scope Global

function Publish-KlarServerUrl {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][string]$Url)

    # Auto-publishes the live tunnel URL to client-releases/server.json on
    # GitHub so installed clients can discover it. Only commits + pushes if
    # the URL has actually changed, to avoid spam commits per session.
    $serverJson = Join-Path $KlarRoot 'client-releases\server.json'
    if (-not (Test-Path $serverJson)) {
        Write-Host "  (skip publish: client-releases\server.json missing)" -ForegroundColor DarkGray
        return
    }
    try {
        $current = Get-Content $serverJson -Raw | ConvertFrom-Json
    } catch {
        Write-Host "  (skip publish: server.json unreadable)" -ForegroundColor DarkGray
        return
    }
    if ($current.serverUrl -eq $Url) {
        Write-Host "  serverUrl already current on GitHub ($Url) - no commit needed." -ForegroundColor DarkGray
        return
    }

    Write-Host "  Publishing new serverUrl to GitHub..." -ForegroundColor Cyan
    $current.serverUrl = $Url
    $current.updatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    # Write WITHOUT a UTF-8 BOM. Set-Content -Encoding utf8 in Windows
    # PowerShell 5.1 writes a BOM, which makes JSON.parse stricter parsers
    # error and makes the file diff noisy on every commit.
    $jsonText = ($current | ConvertTo-Json -Depth 10) + "`n"
    [System.IO.File]::WriteAllText($serverJson, $jsonText, [System.Text.UTF8Encoding]::new($false))

    # Quietly commit + push. Don't fail `up` on a git error - the local
    # server + tunnel are still useful even if publish fails.
    Push-Location $KlarRoot
    try {
        & git add 'client-releases/server.json' 2>&1 | Out-Null
        $msg = "auto: tunnel URL -> $Url"
        & git commit -m $msg 2>&1 | Out-Null
        & git push 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  Pushed: $Url (clients will discover within ~1 min)" -ForegroundColor Green
        } else {
            Write-Host "  git push failed (exit $LASTEXITCODE) - URL written locally but not pushed." -ForegroundColor Yellow
        }
    } finally {
        Pop-Location
    }
}

function Stop-KlarBackground {
    $serverPid = Get-KlarPid
    $tunnelPid = Get-KlarTunnelPid
    if (-not $serverPid -and -not $tunnelPid) {
        Write-Host "Nothing running." -ForegroundColor DarkGray
        return
    }
    if ($tunnelPid) {
        try {
            Stop-Process -Id $tunnelPid -Force -ErrorAction Stop
            Write-Host "Stopped tunnel (pid $tunnelPid)." -ForegroundColor Green
        } catch {
            Write-Host "Failed to stop tunnel pid ${tunnelPid}: $($_.Exception.Message)" -ForegroundColor Red
        }
        Remove-Item $Global:KlarTunnelPidFile -Force -ErrorAction SilentlyContinue
    }
    if ($serverPid) {
        try {
            Stop-Process -Id $serverPid -Force -ErrorAction Stop
            Write-Host "Stopped server (pid $serverPid)." -ForegroundColor Green
        } catch {
            Write-Host "Failed to stop server pid ${serverPid}: $($_.Exception.Message)" -ForegroundColor Red
        }
        Remove-Item $Global:KlarPidFile -Force -ErrorAction SilentlyContinue
    }
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
    $tunnelPid = Get-KlarTunnelPid
    Write-Host ""
    Write-Host "  Klar status" -ForegroundColor Cyan
    Write-Host "  -----------" -ForegroundColor DarkGray
    if ($serverPid) {
        Write-Host ("  server   : ") -NoNewline -ForegroundColor DarkGray
        Write-Host "running (pid $serverPid)" -ForegroundColor Green
    } else {
        Write-Host ("  server   : ") -NoNewline -ForegroundColor DarkGray
        Write-Host "stopped" -ForegroundColor Yellow
    }
    Write-Host ("  port     : $($Global:KlarPort)") -ForegroundColor Gray
    Write-Host ("  url      : http://localhost:$($Global:KlarPort)") -ForegroundColor Gray
    if ($tunnelPid) {
        $tunnelUrl = Get-KlarTunnelUrl
        Write-Host ("  tunnel   : ") -NoNewline -ForegroundColor DarkGray
        Write-Host "running (pid $tunnelPid)" -ForegroundColor Green
        if ($tunnelUrl) {
            Write-Host ("  public   : ") -NoNewline -ForegroundColor DarkGray
            Write-Host $tunnelUrl -ForegroundColor Cyan
        }
    } else {
        Write-Host ("  tunnel   : ") -NoNewline -ForegroundColor DarkGray
        Write-Host "stopped" -ForegroundColor Yellow
    }
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
    Write-Host "--- klar.log (last $n lines) ---" -ForegroundColor Cyan
    Get-Content $Global:KlarLogFile -Tail $n
    if ((Test-Path $Global:KlarErrFile) -and (Get-Item $Global:KlarErrFile).Length -gt 0) {
        Write-Host "`n--- klar.err.log ---" -ForegroundColor Yellow
        Get-Content $Global:KlarErrFile -Tail $n
    }
    if (Test-Path $Global:KlarTunnelLogFile) {
        Write-Host "`n--- klar.tunnel.log ---" -ForegroundColor Cyan
        Get-Content $Global:KlarTunnelLogFile -Tail $n
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
        [switch]$Random,
        [switch]$NoStart
    )
    if (-not (Test-Path (Join-Path $KlarRoot 'node_modules\localtunnel'))) {
        Write-Host "localtunnel not installed. Run 'setup' first." -ForegroundColor Yellow
        return
    }

    # Resolve the subdomain. Priority:
    #   1. Explicit -Subdomain parameter
    #   2. -Random switch (force a random one)
    #   3. tunnelSubdomain field from client-config.json (the stable URL
    #      that's baked into the distributed EXE/MSI)
    #   4. Random (localtunnel default)
    if (-not $Subdomain -and -not $Random) {
        $cfgPath = Join-Path $KlarRoot 'client-config.json'
        if (Test-Path $cfgPath) {
            try {
                $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
                if ($cfg.tunnelSubdomain) { $Subdomain = $cfg.tunnelSubdomain }
            } catch {}
        }
    }

    # Make sure the local server is up before opening the tunnel - otherwise
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
    if ($Subdomain) {
        Write-Host "  Klar is going public on the stable URL:" -ForegroundColor Cyan
        Write-Host "    https://$Subdomain.loca.lt" -ForegroundColor Green
        Write-Host "  Friends running the distributed EXE/MSI will reach it" -ForegroundColor DarkGray
        Write-Host "  automatically - no env vars, no config on their side." -ForegroundColor DarkGray
    } else {
        Write-Host "  Opening tunnel to localhost:$($Global:KlarPort) (random URL)..." -ForegroundColor Cyan
    }
    Write-Host "  Ctrl+C to close the tunnel; the local server keeps running." -ForegroundColor DarkGray
    Write-Host "  ============================================================" -ForegroundColor DarkGray
    Write-Host ""

    $ltJs = Join-Path $KlarRoot 'node_modules\localtunnel\bin\lt.js'
    $cmdArgs = @($ltJs, '--port', "$($Global:KlarPort)")
    if ($Subdomain) { $cmdArgs += @('--subdomain', $Subdomain) }

    # Run lt foreground but parse each output line as it comes through.
    # The first matching *.loca.lt URL gets pushed via Publish-KlarServerUrl
    # so installed clients discover it via the GitHub-served server.json.
    # Without this, friends would still hit whatever URL was last published
    # (e.g. the pinned subdomain) even when the actual tunnel landed on a
    # different one (taken/random) — that's exactly the gap that produced
    # the recent "502 Bad Gateway" reports.
    $script:_klarTunnelPublished = $false
    & node @cmdArgs 2>&1 | ForEach-Object {
        $line = $_
        Write-Host $line
        if (-not $script:_klarTunnelPublished -and $line -match 'https?://[A-Za-z0-9-]+\.loca\.lt') {
            $url = $matches[0]
            $script:_klarTunnelPublished = $true
            try { Publish-KlarServerUrl -Url $url } catch { Write-Host "  publish failed: $($_.Exception.Message)" -ForegroundColor Yellow }
        }
    }
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
