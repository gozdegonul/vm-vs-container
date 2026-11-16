# Runs the repeated measurements for one target (docker or vm) and appends them to
# results\measurements.csv. Run from the project root, e.g.:
#
#   powershell -ExecutionPolicy Bypass -File scripts\measure.ps1 -Target docker
#   powershell -ExecutionPolicy Bypass -File scripts\measure.ps1 -Target vm
#
# Per run it measures: start time, stop time, (VM only) resume-from-saved-state time,
# idle memory, memory under load, and a k6 load test (results\k6_<target>_run<N>.json).
# Disk footprint (image / virtual disk size) is recorded once per target.
param(
    [Parameter(Mandatory = $true)][ValidateSet("docker", "vm")][string]$Target,
    [int]$Runs = 3,
    [string]$VmName = "sen421-vm",
    [string]$Image = "sen421-api:1.0",
    [int]$Vus = 50,
    [string]$Duration = "2m",
    [int]$CooldownSec = 60,
    [switch]$SkipLoad
)
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$resultsDir = Join-Path $root "results"
New-Item -ItemType Directory -Force $resultsDir | Out-Null
$csv = Join-Path $resultsDir "measurements.csv"
if (-not (Test-Path $csv)) { "timestamp,target,run,metric,value,unit" | Out-File -Encoding ascii $csv }

$vbox = Join-Path $env:ProgramFiles "Oracle\VirtualBox\VBoxManage.exe"
$dockerBin = Join-Path $env:ProgramFiles "Docker\Docker\resources\bin"
if (-not (Get-Command docker -ErrorAction SilentlyContinue) -and (Test-Path $dockerBin)) { $env:Path = "$dockerBin;$env:Path" }

# Runs a native command and ignores its output and stderr (PowerShell 5.1 would otherwise
# turn stderr text into a terminating error while $ErrorActionPreference is "Stop").
function Quiet([scriptblock]$cmd) {
    $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { & $cmd 2>&1 | Out-Null } finally { $ErrorActionPreference = $old }
    return $LASTEXITCODE
}
$port = if ($Target -eq "docker") { 8080 } else { 8081 }
$baseUrl = "http://127.0.0.1:$port"
$container = "sen421-api"

function Record($run, $metric, $value, $unit) {
    $ts = (Get-Date).ToString("s")
    $v = [string]::Format([Globalization.CultureInfo]::InvariantCulture, "{0:0.###}", [double]$value)
    "$ts,$Target,$run,$metric,$v,$unit" | Out-File -Append -Encoding ascii $csv
    Write-Host ("  {0,-22} {1,10} {2}" -f $metric, $v, $unit)
}

function Get-Health {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 "$baseUrl/health"
        if ($r.StatusCode -eq 200) { return ($r.Content | ConvertFrom-Json) }
    } catch { }
    return $null
}

# Polls /health every 50 ms; returns elapsed ms since $sw was started.
function Wait-Healthy($sw, [int]$timeoutSec = 300) {
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
        if (Get-Health) { return $sw.Elapsed.TotalMilliseconds }
        Start-Sleep -Milliseconds 50
    }
    throw "Timed out waiting for $baseUrl/health"
}

function Get-VmState {
    $line = & $vbox showvminfo $VmName --machinereadable | Select-String '^VMState='
    return $line.ToString().Split('=', 2)[1].Trim('"')
}

function Wait-VmState($state, [int]$timeoutSec = 180) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ((Get-VmState) -ne $state) {
        if ($sw.Elapsed.TotalSeconds -gt $timeoutSec) { throw "VM did not reach state $state" }
        Start-Sleep -Milliseconds 100
    }
}

# Memory of the platform as seen from the host, in MB.
function Get-PlatformMemoryMB {
    if ($Target -eq "docker") {
        # Container memory as reported by Docker (cgroup), e.g. "11.2MiB / 2GiB".
        $u = (docker stats --no-stream --format "{{.MemUsage}}" $container).Split('/')[0].Trim()
        $num = [double]::Parse(($u -replace '[^0-9.]', ''), [Globalization.CultureInfo]::InvariantCulture)
        if ($u -match 'GiB') { $num *= 1024 } elseif ($u -match 'KiB') { $num /= 1024 }
        return $num
    } else {
        # Whole VM process on the host (guest OS + app + hypervisor process overhead).
        $p = Get-Process -Name "VirtualBoxVM" -ErrorAction SilentlyContinue
        return (($p | Measure-Object WorkingSet64 -Sum).Sum / 1MB)
    }
}

# Docker Desktop runs containers inside its own lightweight VM (WSL 2); record that cost too.
function Get-DockerBackendMemoryMB {
    $p = Get-Process -Name "vmmem", "vmmemWSL" -ErrorAction SilentlyContinue
    if ($p) { return (($p | Measure-Object WorkingSet64 -Sum).Sum / 1MB) }
    return $null
}

function Start-Target {
    if ($Target -eq "docker") {
        Quiet { docker rm -f $container } | Out-Null
        $sw = [Diagnostics.Stopwatch]::StartNew()
        docker run -d --name $container --cpus 2 --memory 2g -p "127.0.0.1:8080:8080" $Image | Out-Null
    } else {
        if ((Get-VmState) -ne "poweroff") { throw "VM must be powered off before a cold-boot run." }
        $sw = [Diagnostics.Stopwatch]::StartNew()
        & $vbox startvm $VmName --type headless | Out-Null
    }
    return (Wait-Healthy $sw)
}

function Stop-Target {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    if ($Target -eq "docker") {
        docker stop $container | Out-Null
    } else {
        & $vbox controlvm $VmName acpipowerbutton | Out-Null
        Wait-VmState "poweroff"
    }
    return $sw.Elapsed.TotalMilliseconds
}

# ---------- preparation ----------
if ($Target -eq "docker") {
    if ((Quiet { docker image inspect $Image }) -ne 0) { Quiet { docker build -t $Image (Join-Path $root "app") } | Out-Null }
} else {
    if (-not (Test-Path $vbox)) { throw "VBoxManage not found." }
    $s = Get-VmState
    if ($s -eq "saved") { & $vbox discardstate $VmName | Out-Null }
    elseif ($s -ne "poweroff") { & $vbox controlvm $VmName poweroff | Out-Null; Wait-VmState "poweroff" }
}
$k6 = Get-Command k6 -ErrorAction SilentlyContinue
if (-not $SkipLoad -and -not $k6) { throw "k6 not found. Install it or use -SkipLoad." }

Write-Host "== Disk footprint ($Target)"
if ($Target -eq "docker") {
    $bytes = [double](docker image inspect -f "{{.Size}}" $Image)
} else {
    $cfg = (& $vbox showvminfo $VmName --machinereadable | Select-String '^CfgFile=').ToString().Split('=', 2)[1].Trim('"')
    $bytes = (Get-ChildItem (Split-Path $cfg) -Recurse -Include *.vdi | Measure-Object Length -Sum).Sum
}
Record 0 "disk_size" ($bytes / 1MB) "MB"

# ---------- repeated runs ----------
for ($run = 1; $run -le $Runs; $run++) {
    Write-Host "== $Target run $run of $Runs"

    Record $run "start_time" (Start-Target) "ms"

    Start-Sleep -Seconds 30   # let the system settle before reading idle memory
    $h = Get-Health
    Record $run "app_rss_idle" $h.rssMB "MB"
    Record $run "platform_mem_idle" (Get-PlatformMemoryMB) "MB"
    if ($Target -eq "docker") {
        $b = Get-DockerBackendMemoryMB
        if ($b) { Record $run "docker_backend_mem_idle" $b "MB" }
    }

    if (-not $SkipLoad) {
        $out = Join-Path $resultsDir "k6_${Target}_run$run.json"
        $k6Args = @("run", "--quiet", "--vus", "$Vus", "--duration", $Duration,
            "--env", "BASE_URL=$baseUrl", "--summary-export", $out,
            (Join-Path $root "loadtest\load_test.js"))
        $proc = Start-Process -FilePath $k6.Source -ArgumentList $k6Args -NoNewWindow -PassThru
        # Sample memory in the middle of the test.
        if ($Duration -match '^(\d+)m$') { $secs = [int]$Matches[1] * 60 }
        elseif ($Duration -match '^(\d+)s$') { $secs = [int]$Matches[1] }
        else { throw "Use a duration like 2m or 90s" }
        $half = [int]($secs / 2)
        Start-Sleep -Seconds ([Math]::Max($half, 5))
        Record $run "platform_mem_load" (Get-PlatformMemoryMB) "MB"
        $h = Get-Health
        if ($h) { Record $run "app_rss_load" $h.rssMB "MB" }
        $proc.WaitForExit()
    }

    Record $run "stop_time" (Stop-Target) "ms"

    if ($Target -eq "vm") {
        # Extra VM data point: resume from a saved state (closest VM equivalent to a "warm" start).
        & $vbox startvm $VmName --type headless | Out-Null
        Wait-Healthy ([Diagnostics.Stopwatch]::StartNew()) | Out-Null
        Start-Sleep -Seconds 10
        & $vbox controlvm $VmName savestate | Out-Null
        Wait-VmState "saved"
        $sw = [Diagnostics.Stopwatch]::StartNew()
        & $vbox startvm $VmName --type headless | Out-Null
        Record $run "resume_time" (Wait-Healthy $sw) "ms"
        Stop-Target | Out-Null
    } else {
        # Warm start: start the existing (stopped) container again.
        $sw = [Diagnostics.Stopwatch]::StartNew()
        docker start $container | Out-Null
        Record $run "resume_time" (Wait-Healthy $sw) "ms"
        Stop-Target | Out-Null
    }

    if ($run -lt $Runs) { Write-Host "  cooldown $CooldownSec s"; Start-Sleep -Seconds $CooldownSec }
}

if ($Target -eq "docker") { docker rm -f $container | Out-Null }
Write-Host "Done. Results appended to $csv"
