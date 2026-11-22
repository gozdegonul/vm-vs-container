# Measurement log (22 November 2026)

Host: Intel Core i5-12450H, 16 GB RAM, Windows 11 Home, on AC power.
Docker Engine 29.9.3 (Docker Desktop, WSL 2 backend), VirtualBox 7.2.22, Ubuntu Server 26.04.1 LTS, k6.
Both alternatives limited to 2 vCPU and 2 GB memory. 3 runs each, 50 virtual users, 2 minutes per load test.

## Order of events

1. **Docker, runs 1-3** (22:22-22:32): completed without problems.
2. **VM, first attempt** (22:32-22:38): stopped by script errors (VM process name `VBoxHeadless`
   not recognised, `/health` timeout too short right after boot, VirtualBox briefly refusing
   `showvminfo` during a state change). Data discarded, script fixed.
3. **VM, second attempt** (22:39-22:46): the VM ignored the ACPI shutdown request for 3 minutes.
   Inside the VM, `systemd-inhibit --list` showed "Unattended Upgrades Shutdown" holding a
   shutdown delay lock. Data discarded.
4. **Change to the VM:** automatic updates disabled
   (`apt-daily.timer`, `apt-daily-upgrade.timer`, `unattended-upgrades.service`, `motd-news.timer`).
   After this, ACPI shutdown took 8.6 s and 13.1 s in two checks.
5. **VM, runs 1-2** (22:50-23:01): completed, except that after run 2 the VM booted but its
   NAT port forwarding passed no traffic (ports 8081 and 2222 accepted TCP connections but
   returned nothing; 40 CLOSE_WAIT sockets left on the host from the load test). A hard restart
   fixed it. Run 2 resume time was measured separately afterwards (`-ResumeOnly`).
6. **VM, run 3** (23:11-23:16): completed; the resume test needed three attempts because of the
   same NAT problem (one attempt failed outright, two recovered after a hard restart).

## Observations useful for the report

- NAT hangs: about 4 times during the VM experiments, never with Docker.
- k6 against the VM logged a few "connection refused" errors at the start of runs 2 and 3
  (0.06 % and 0.01 % of requests; run 1 had none); none against Docker.
- VM throughput varied strongly between runs (625, 240, 238 req/s); Docker stayed within 5 %
  (2130, 2142, 2250 req/s). Run 1 of the VM is the outlier; runs 2 and 3 are almost identical.
- Docker run 1 cold start (880 ms) was slower than runs 2-3 (411 ms, 365 ms), a warm-up effect.
- Application memory (Node.js RSS) is about the same on both platforms (58-61 MB idle), so the
  memory difference comes from the platform: VM process about 845 MB, container about 12 MB,
  but Docker Desktop's WSL 2 VM about 1.1-1.4 GB (shared by all containers).
- Hyper-V is active on the host, so VirtualBox runs through the Windows Hypervisor Platform.
- The load generator (k6) ran on the same laptop, sharing CPU with the system under test.
