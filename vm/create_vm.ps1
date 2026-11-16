# Creates the VirtualBox VM used in the experiment (run once, on the Windows host).
# Same resource limits as the container: 2 vCPU, 2048 MB memory.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File vm\create_vm.ps1 -IsoPath "C:\Users\<you>\Downloads\ubuntu-24.04.3-live-server-amd64.iso"
#
# After it finishes, start the VM with a window, install Ubuntu Server
# (tick "Install OpenSSH server"), then follow README step 3.
param(
    [Parameter(Mandatory = $true)][string]$IsoPath,
    [string]$VmName = "sen421-vm",
    [int]$Cpus = 2,
    [int]$MemoryMB = 2048,
    [int]$DiskMB = 20480
)
$ErrorActionPreference = "Stop"

$vbox = Join-Path $env:ProgramFiles "Oracle\VirtualBox\VBoxManage.exe"
if (-not (Test-Path $vbox)) { throw "VBoxManage not found at $vbox. Install VirtualBox first." }
if (-not (Test-Path $IsoPath)) { throw "ISO not found: $IsoPath" }

& $vbox createvm --name $VmName --ostype Ubuntu_64 --register
& $vbox modifyvm $VmName --cpus $Cpus --memory $MemoryMB --vram 16 `
    --nic1 nat --audio-enabled off --usb off --boot1 disk --boot2 dvd --boot3 none --boot4 none

# Port forwarding: host 8081 -> guest 8080 (API), host 2222 -> guest 22 (SSH/SCP).
& $vbox modifyvm $VmName --natpf1 "api,tcp,127.0.0.1,8081,,8080"
& $vbox modifyvm $VmName --natpf1 "ssh,tcp,127.0.0.1,2222,,22"

$cfg = (& $vbox showvminfo $VmName --machinereadable | Select-String '^CfgFile=').ToString().Split('=', 2)[1].Trim('"')
$disk = Join-Path (Split-Path $cfg) "$VmName.vdi"
& $vbox createmedium disk --filename $disk --size $DiskMB --format VDI --variant Standard

& $vbox storagectl $VmName --name "SATA" --add sata --controller IntelAhci --portcount 2
& $vbox storageattach $VmName --storagectl "SATA" --port 0 --device 0 --type hdd --medium $disk
& $vbox storageattach $VmName --storagectl "SATA" --port 1 --device 0 --type dvddrive --medium $IsoPath

Write-Host "VM '$VmName' created. Disk: $disk"
Write-Host "Next: & '$vbox' startvm $VmName   (install Ubuntu Server, enable OpenSSH)"
