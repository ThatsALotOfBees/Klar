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
$Global:KlarCaddyfile      = Join-Path $KlarRoot 'Caddyfile'
$Global:KlarCaddyLogFile   = Join-Path $KlarRoot 'klar.caddy.log'
$Global:KlarCaddyErrFile   = Join-Path $KlarRoot 'klar.caddy.err.log'
$Global:KlarCaddyPidFile   = Join-Path $KlarRoot '.klar.caddy.pid'

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
        ,@('tunnel [-Subdomain]', 'Open a public *.loca.lt URL (legacy localtunnel — flaky)')
        ,@('funnel [-Off]', 'Open Tailscale Funnel: stable *.ts.net URL')
        ,@('caddy-up',   'Start Caddy reverse proxy on 80/443 (needs admin) for the custom domain')
        ,@('caddy-down', 'Stop the Caddy reverse proxy')
        ,@('caddy-tail', 'Follow caddy live log (cert provisioning, requests)')
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
            # Don't auto-publish if the current server.json points at a
            # stable URL (Tailscale Funnel, custom domain) — otherwise `up`
            # would clobber the good URL with a flaky loca.lt URL on every
            # restart. Only publish if the existing URL is itself a loca.lt
            # URL or empty.
            $existing = ''
            if (Test-Path $Global:KlarConfigFile) {}
            $serverJson = Join-Path $KlarRoot 'client-releases\server.json'
            if (Test-Path $serverJson) {
                try { $existing = (Get-Content $serverJson -Raw | ConvertFrom-Json).serverUrl } catch {}
            }
            if (-not $existing -or $existing -match '\.loca\.lt') {
                Publish-KlarServerUrl -Url $url
            } else {
                Write-Host "  (skipping publish: current serverUrl is a stable URL: $existing)" -ForegroundColor DarkGray
            }
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

# Locate the tailscale CLI. On Windows it's installed under Program Files but
# isn't always on PATH (the installer adds it but only after a new shell).
function Get-KlarTailscaleExe {
    $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($p in @(
        "$env:ProgramFiles\Tailscale\tailscale.exe",
        "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe"
    )) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Invoke-KlarFunnel {
    [CmdletBinding()]
    param(
        [switch]$Off,
        [switch]$NoStart
    )

    $ts = Get-KlarTailscaleExe
    if (-not $ts) {
        Write-Host ""
        Write-Host "  Tailscale isn't installed yet." -ForegroundColor Yellow
        Write-Host "  One-time setup (free for personal use, no domain required):" -ForegroundColor Gray
        Write-Host "    1. Install:  https://tailscale.com/download/windows" -ForegroundColor Cyan
        Write-Host "       (sign in with Google / GitHub / Microsoft when it asks)" -ForegroundColor DarkGray
        Write-Host "    2. Enable HTTPS + Funnel for your tailnet:" -ForegroundColor Cyan
        Write-Host "         https://login.tailscale.com/admin/dns         (turn on MagicDNS + HTTPS)" -ForegroundColor DarkGray
        Write-Host "         https://login.tailscale.com/admin/acls        (add a 'funnel' grant; default config below)" -ForegroundColor DarkGray
        Write-Host "    3. Re-run 'funnel' in this shell." -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  Minimum ACL grant for funnel (paste into the ACL editor):" -ForegroundColor DarkGray
        Write-Host '    "nodeAttrs": [ { "target": ["*"], "attr": ["funnel"] } ]' -ForegroundColor DarkGray
        Write-Host ""
        return
    }

    if ($Off) {
        Write-Host "Disabling Tailscale Funnel..." -ForegroundColor Cyan
        & $ts funnel reset
        if ($LASTEXITCODE -eq 0) { Write-Host "Funnel disabled." -ForegroundColor Green }
        return
    }

    # Make sure the local server is up first - otherwise the funnel URL would
    # 502 the same way localtunnel does when nothing is listening.
    if (-not $NoStart) {
        $serverPid = Get-KlarPid
        if (-not $serverPid) {
            Write-Host "No local server running on port $($Global:KlarPort). Starting (without localtunnel)..." -ForegroundColor Cyan
            Start-KlarBackground -NoTunnel
            Start-Sleep -Milliseconds 800
            if (-not (Get-KlarPid)) {
                Write-Host "Server didn't start cleanly. Check logs and retry." -ForegroundColor Red
                return
            }
        } else {
            Write-Host "Local server already running on port $($Global:KlarPort) (pid $serverPid)." -ForegroundColor DarkGray
        }
    }

    # Read the device's MagicDNS name. Self.DNSName is the canonical FQDN
    # (trailing dot included), e.g. "klar-host.tail-scale.ts.net."
    $statusRaw = & $ts status --json 2>&1
    if ($LASTEXITCODE -ne 0 -or -not $statusRaw) {
        Write-Host "tailscale status failed. Are you signed in? Try: tailscale login" -ForegroundColor Red
        if ($statusRaw) { Write-Host $statusRaw -ForegroundColor DarkGray }
        return
    }
    try {
        $status = ($statusRaw -join "`n") | ConvertFrom-Json
    } catch {
        Write-Host "Couldn't parse tailscale status output." -ForegroundColor Red
        return
    }
    $dnsName = ''
    if ($status.Self -and $status.Self.DNSName) { $dnsName = ([string]$status.Self.DNSName).TrimEnd('.') }
    if (-not $dnsName) {
        Write-Host "Couldn't read Self.DNSName from tailscale status. Make sure MagicDNS is enabled at https://login.tailscale.com/admin/dns" -ForegroundColor Yellow
        return
    }

    # Open the tunnel. --bg returns immediately and leaves the rule in place
    # so closing this shell doesn't take the URL down.
    Write-Host "Opening Tailscale Funnel  https://$dnsName  ->  localhost:$($Global:KlarPort) ..." -ForegroundColor Cyan
    $funnelOut = & $ts funnel --bg "$($Global:KlarPort)" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "tailscale funnel failed (exit $LASTEXITCODE). Output:" -ForegroundColor Red
        $funnelOut | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
        Write-Host "" -ForegroundColor Gray
        Write-Host "If the error mentions Funnel/HTTPS not being enabled, fix it here:" -ForegroundColor Yellow
        Write-Host "  https://login.tailscale.com/admin/dns                 (enable HTTPS Certificates)" -ForegroundColor DarkGray
        Write-Host "  https://login.tailscale.com/admin/acls                (grant funnel attr - see 'funnel' help)" -ForegroundColor DarkGray
        return
    }
    if ($funnelOut) { $funnelOut | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray } }

    $url = "https://$dnsName"
    Write-Host ""
    Write-Host "  Klar funnel up:  $url" -ForegroundColor Green
    Write-Host "  This URL is stable - it doesn't change between restarts." -ForegroundColor DarkGray
    Write-Host "  To take it down later:  funnel -Off" -ForegroundColor DarkGray
    Write-Host ""
    Publish-KlarServerUrl -Url $url
}
Set-Alias funnel Invoke-KlarFunnel -Scope Global

# ---- Caddy reverse proxy (HTTPS termination for the public domain) ------

function Get-KlarCaddyExe {
    $cmd = Get-Command caddy -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    # winget installs Caddy under the per-user package dir on first install;
    # PATH only picks it up after a new shell launches.
    $globs = @(
        "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\CaddyServer.Caddy_*\caddy.exe",
        "$env:ProgramFiles\Caddy\caddy.exe",
        "${env:ProgramFiles(x86)}\Caddy\caddy.exe"
    )
    foreach ($g in $globs) {
        $hit = Get-ChildItem -Path $g -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

function Get-KlarCaddyPid {
    if (-not (Test-Path $Global:KlarCaddyPidFile)) { return $null }
    $raw = Get-Content $Global:KlarCaddyPidFile -ErrorAction SilentlyContinue
    if (-not $raw) { return $null }
    $procPid = 0
    if (-not [int]::TryParse($raw.Trim(), [ref]$procPid)) {
        Remove-Item $Global:KlarCaddyPidFile -Force -ErrorAction SilentlyContinue
        return $null
    }
    $proc = Get-Process -Id $procPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -match 'caddy') { return $procPid }
    Remove-Item $Global:KlarCaddyPidFile -Force -ErrorAction SilentlyContinue
    return $null
}

function Test-KlarIsAdmin {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $p = [System.Security.Principal.WindowsPrincipal]::new($id)
    return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-KlarCaddyUp {
    [CmdletBinding()]
    param([switch]$NoStart)

    $caddy = Get-KlarCaddyExe
    if (-not $caddy) {
        Write-Host "Caddy not installed. Run: winget install CaddyServer.Caddy" -ForegroundColor Yellow
        return
    }
    if (-not (Test-Path $Global:KlarCaddyfile)) {
        Write-Host "Caddyfile missing at $Global:KlarCaddyfile" -ForegroundColor Yellow
        return
    }
    if (Get-KlarCaddyPid) {
        Write-Host "Caddy already running. Use 'caddy-down' to stop." -ForegroundColor Yellow
        return
    }
    if (-not (Test-KlarIsAdmin)) {
        Write-Host ""
        Write-Host "  Caddy needs Administrator to bind ports 80 + 443." -ForegroundColor Yellow
        Write-Host "  Quick fix:" -ForegroundColor Gray
        Write-Host "    1. Open PowerShell as Administrator." -ForegroundColor DarkGray
        Write-Host "    2. cd $KlarRoot" -ForegroundColor DarkGray
        Write-Host "    3. . .\shell.ps1" -ForegroundColor DarkGray
        Write-Host "    4. caddy-up" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  Or run this one-liner from an elevated shell:" -ForegroundColor DarkGray
        Write-Host "    & '$caddy' run --config '$Global:KlarCaddyfile'" -ForegroundColor DarkGray
        Write-Host ""
        return
    }

    # Make sure the local server is up first (Caddy proxying to nothing
    # would 502 the same way localtunnel did).
    if (-not $NoStart) {
        if (-not (Get-KlarPid)) {
            Write-Host "Local server not running. Starting (without localtunnel)..." -ForegroundColor Cyan
            Start-KlarBackground -NoTunnel
            Start-Sleep -Milliseconds 800
            if (-not (Get-KlarPid)) { Write-Host "Server failed to start." -ForegroundColor Red; return }
        }
    }

    if (Test-Path $Global:KlarCaddyLogFile) { Remove-Item $Global:KlarCaddyLogFile -Force }
    if (Test-Path $Global:KlarCaddyErrFile) { Remove-Item $Global:KlarCaddyErrFile -Force }

    $proc = Start-Process $caddy `
        -ArgumentList @('run', '--config', $Global:KlarCaddyfile, '--adapter', 'caddyfile') `
        -WorkingDirectory $KlarRoot `
        -RedirectStandardOutput $Global:KlarCaddyLogFile `
        -RedirectStandardError  $Global:KlarCaddyErrFile `
        -WindowStyle Hidden `
        -PassThru
    "$($proc.Id)" | Set-Content -Path $Global:KlarCaddyPidFile -Encoding ascii
    Start-Sleep -Milliseconds 1500
    if (-not (Get-KlarCaddyPid)) {
        Write-Host "Caddy failed to start. Last error log:" -ForegroundColor Red
        if (Test-Path $Global:KlarCaddyErrFile) { Get-Content $Global:KlarCaddyErrFile -Tail 30 }
        if (Test-Path $Global:KlarCaddyLogFile) { Get-Content $Global:KlarCaddyLogFile -Tail 30 }
        return
    }
    Write-Host "Caddy started (pid $($proc.Id))." -ForegroundColor Green
    Write-Host "  Public URL: https://thatsalotofbees.online" -ForegroundColor Cyan
    Write-Host "  First-run cert provisioning takes ~30s. Watch with: caddy-tail" -ForegroundColor DarkGray
}
Set-Alias caddy-up Invoke-KlarCaddyUp -Scope Global

function Stop-KlarCaddy {
    $caddyPid = Get-KlarCaddyPid
    if (-not $caddyPid) {
        Write-Host "Caddy not running." -ForegroundColor DarkGray
        return
    }
    try {
        Stop-Process -Id $caddyPid -Force -ErrorAction Stop
        Write-Host "Stopped Caddy (pid $caddyPid)." -ForegroundColor Green
    } catch {
        Write-Host "Failed to stop Caddy: $($_.Exception.Message)" -ForegroundColor Red
    }
    Remove-Item $Global:KlarCaddyPidFile -Force -ErrorAction SilentlyContinue
}
Set-Alias caddy-down Stop-KlarCaddy -Scope Global

function Watch-KlarCaddyLog {
    if (-not (Test-Path $Global:KlarCaddyLogFile)) {
        Write-Host "No Caddy log yet - run 'caddy-up' first." -ForegroundColor DarkGray
        return
    }
    Write-Host "Following $Global:KlarCaddyLogFile  (Ctrl+C to stop)" -ForegroundColor Cyan
    Get-Content $Global:KlarCaddyLogFile -Wait -Tail 50
}
Set-Alias caddy-tail Watch-KlarCaddyLog -Scope Global

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
