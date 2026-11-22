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
    [switch]$SkipLoad,
    # Continue an interrupted series: e.g. -FirstRun 3 -Runs 3 runs only run 3.
    [int]$FirstRun = 1,
    # Only repeat the warm start / resume measurement for the selected runs.
    [switch]$ResumeOnly
)
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$resultsDir = Join-Path $root "results"
New-Item -ItemType Directory -Force $resultsDir | Out-Null
$csv = Join-Path $resultsDir "measurements.csv"
if (-not (Test-Path $csv)) { "timestamp,target,run,metric,value,unit" | Out-File -Encoding ascii $csv }

$vbox = Join-Path $env:ProgramFiles "Oracle\VirtualBox\VBoxManage.exe"
# Docker Desktop can be installed for all users (Program Files) or per user (LocalAppData).
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    foreach ($dockerBin in @((Join-Path $env:ProgramFiles "Docker\Docker\resources\bin"),
                             (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin"))) {
        if (Test-Path $dockerBin) { $env:Path = "$dockerBin;$env:Path"; break }
    }
}

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

function Get-Health([int]$timeoutSec = 1) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec $timeoutSec "$baseUrl/health"
        if ($r.StatusCode -eq 200) { return ($r.Content | ConvertFrom-Json) }
    } catch { }
    return $null
}

# For memory readings: a freshly booted VM can be busy for a moment, so retry patiently.
function Get-HealthPatient {
    for ($i = 0; $i -lt 10; $i++) {
        $h = Get-Health 5
        if ($h) { return $h }
        Start-Sleep -Seconds 1
    }
    throw "/health did not answer for the memory reading"
}

# Polls /health every 50 ms; returns elapsed ms since $sw was started.
function Wait-Healthy($sw, [int]$timeoutSec = 300) {
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
        if (Get-Health) { return $sw.Elapsed.TotalMilliseconds }
        Start-Sleep -Milliseconds 50
    }
    throw "Timed out waiting for $baseUrl/health"
}

# VirtualBox briefly refuses "showvminfo" while a VM changes state; retry instead of failing.
function Get-VmState {
    for ($i = 0; $i -lt 20; $i++) {
        $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        $line = & $vbox showvminfo $VmName --machinereadable 2>$null | Select-String '^VMState='
        $ErrorActionPreference = $old
        if ($line) { return $line.ToString().Split('=', 2)[1].Trim('"') }
        Start-Sleep -Milliseconds 250
    }
    throw "Could not read the state of VM $VmName"
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
        # The process is "VBoxHeadless" for headless starts and "VirtualBoxVM" with a window.
        $p = Get-Process -Name "VBoxHeadless", "VirtualBoxVM" -ErrorAction SilentlyContinue
        if (-not $p) { throw "VirtualBox VM process not found for the memory reading" }
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
        try { return (Wait-Healthy $sw 180) }
        catch {
            # VirtualBox NAT occasionally does not pass traffic after a heavy run; a fresh boot fixes it.
            Write-Host "  VM API unreachable after boot (NAT hang); hard restart and measure again"
            Record $run "start_retry" 1 "count"
            Reset-Vm
            $sw = [Diagnostics.Stopwatch]::StartNew()
            & $vbox startvm $VmName --type headless | Out-Null
            return (Wait-Healthy $sw 180)
        }
    }
    return (Wait-Healthy $sw)
}

function Reset-Vm {
    Quiet { & $vbox controlvm $VmName poweroff } | Out-Null   # prints progress to stderr
    Wait-VmState "poweroff"
    Start-Sleep -Seconds 3
}

# Boots the VM without measuring (used before the saved-state test), with one retry.
function Start-VmHealthy {
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        & $vbox startvm $VmName --type headless | Out-Null
        try { Wait-Healthy ([Diagnostics.Stopwatch]::StartNew()) 180 | Out-Null; return }
        catch { Write-Host "  VM API unreachable after boot (NAT hang); hard restart"; Reset-Vm }
    }
    throw "VM API did not come up after two boots"
}

function Stop-Target {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    if ($Target -eq "docker") {
        docker stop $container | Out-Null
    } else {
        # ACPI shutdown, like pressing the power button. If the guest ignores it, press it again;
        # as a last resort switch the VM off hard and report the stop time as missing.
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            Quiet { & $vbox controlvm $VmName acpipowerbutton } | Out-Null
            try { Wait-VmState "poweroff" 60; return $sw.Elapsed.TotalMilliseconds } catch { Write-Host "  VM ignored shutdown request $attempt" }
        }
        Quiet { & $vbox controlvm $VmName poweroff } | Out-Null
        Wait-VmState "poweroff"
        Write-Host "  VM was switched off hard; stop time not recorded"
        return $null
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

if ($FirstRun -eq 1 -and -not $ResumeOnly) {
    Write-Host "== Disk footprint ($Target)"
    if ($Target -eq "docker") {
        $bytes = [double](docker image inspect -f "{{.Size}}" $Image)
    } else {
        $cfg = (& $vbox showvminfo $VmName --machinereadable | Select-String '^CfgFile=').ToString().Split('=', 2)[1].Trim('"')
        $bytes = (Get-ChildItem (Split-Path $cfg) -Recurse -Include *.vdi | Measure-Object Length -Sum).Sum
    }
    Record 0 "disk_size" ($bytes / 1MB) "MB"
}

# ---------- repeated runs ----------
for ($run = $FirstRun; $run -le $Runs; $run++) {
    Write-Host "== $Target run $run of $Runs$(if ($ResumeOnly) { ' (resume only)' })"

  if (-not $ResumeOnly) {
    Record $run "start_time" (Start-Target) "ms"

    Start-Sleep -Seconds 30   # let the system settle before reading idle memory
    $h = Get-HealthPatient
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
        $h = Get-Health 5   # under load: one try with a longer timeout, skip if it is too busy
        if ($h) { Record $run "app_rss_load" $h.rssMB "MB" }
        $proc.WaitForExit()
    }

    $stop = Stop-Target
    if ($null -ne $stop) { Record $run "stop_time" $stop "ms" }
  }

    if ($Target -eq "vm") {
        # Extra VM data point: resume from a saved state (closest VM equivalent to a "warm" start).
        Start-VmHealthy
        Start-Sleep -Seconds 10
        & $vbox controlvm $VmName savestate | Out-Null
        Wait-VmState "saved"
        $sw = [Diagnostics.Stopwatch]::StartNew()
        & $vbox startvm $VmName --type headless | Out-Null
        Record $run "resume_time" (Wait-Healthy $sw 180) "ms"
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
