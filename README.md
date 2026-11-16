# SEN421 Cloud project: VM vs. Docker container with a supply chain API

SEN421 Cloud Architecture and Services, Fall 2026. Topic 2 (Part A, local).

The same Node.js Supply Chain API (`app/server.js`, one file, no dependencies) runs two ways
with the same limits (2 vCPU, 2 GB memory):

| Alternative | Platform | How the API starts |
|---|---|---|
| VM | VirtualBox, Ubuntu Server 26.04 LTS, Node.js 22 | systemd service at boot |
| Container | Docker Desktop, `node:22-alpine` image | `docker run` |

Measured (each repeated 3 times): disk footprint, cold start time (start command until `/health`
answers), warm start / resume time, stop time, memory when idle and under load, and the
median / p95 response time, throughput and error rate under a k6 load test.

## The application

A supply chain back end with synthetic data generated at startup from a fixed seed
(same data on every start, no database, no personal data): 20 warehouses in Turkish cities
linked by a road network, 50 suppliers, 500 products with 90 days of demand history and
5,000 inventory rows.

| Area | Endpoints |
|---|---|
| Health | `GET /health`, `GET /api` |
| Warehouses | `GET /api/warehouses`, `/api/warehouses/:id`, `/:id/inventory?lowStock=true`, `/:id/replenishment` |
| Suppliers | `GET /api/suppliers`, `/api/suppliers/:id` |
| Products | `GET /api/products?category=&supplierId=&q=`, `/api/products/:sku`, `/:sku/stock`, `/:sku/forecast?days=` |
| Routing | `GET /api/routes?from=WH-01&to=WH-18` (Dijkstra shortest path) |
| Orders | `GET/POST /api/orders`, `GET /api/orders/:id`, `PATCH /api/orders/:id/status` |
| Purchase orders | `GET/POST /api/purchase-orders`, `POST /api/purchase-orders/:id/receive` |
| Analytics | `GET /api/analytics/abc`, `/api/analytics/stock-value` |

Business logic: all-or-nothing stock reservation on orders (409 when stock is short), order
life cycle CONFIRMED → PICKED → SHIPPED → DELIVERED (or CANCELLED), delivery route and cost,
demand forecasting with Holt's linear exponential smoothing (49 × 49 grid search, CPU-heavy),
replenishment planning with safety stock, reorder point and economic order quantity (EOQ), and
ABC classification. Lists support `page` and `limit` (max 100).

Example:

```bash
curl -X POST http://127.0.0.1:8080/api/orders -H "Content-Type: application/json" \
  -d '{"customer":"Test Ltd","warehouseId":"WH-02","destinationCity":"Trabzon","items":[{"sku":"SKU-00263","qty":5}]}'
```

The k6 test (`loadtest/load_test.js`) runs one user session per iteration: browse products,
check stock, open an inventory page, place an order, request a forecast, plan a route, and in
about 1 of 10 iterations run replenishment planning. A 409 (not enough stock) counts as a
valid answer.

## Layout

```
app/        server.js, Dockerfile            the application (identical in both)
vm/         create_vm.ps1, setup.sh, api.service
loadtest/   load_test.js                     k6 script
scripts/    measure.ps1                      repeated measurements -> results/
            summarize.js                     mean ± sd -> results/summary.md + LaTeX table
results/    raw CSV and k6 JSON              (created by the scripts)
report/     main.tex                         IEEE report
```

## 1. Install the tools (Windows host)

- Docker Desktop (needs WSL 2): https://docs.docker.com/desktop/setup/install/windows-install/
- VirtualBox 7.x: https://www.virtualbox.org/wiki/Downloads
- k6: `winget install k6 --source winget`
- Ubuntu Server 24.04 LTS ISO: https://ubuntu.com/download/server

Write down every version (`docker version`, `VBoxManage --version`, `k6 version`) for the report.

> This host has Hyper-V active (Docker Desktop/WSL 2 needs it). VirtualBox then runs on top of
> the Windows Hypervisor Platform instead of its own engine, which can make the VM slower.
> Report this as a limitation. It is also part of the answer: on Windows, Docker itself runs
> inside a small VM.

## 2. Build the container

```powershell
docker build -t sen421-api:1.0 app
```

## 3. Create and prepare the VM

```powershell
powershell -ExecutionPolicy Bypass -File vm\create_vm.ps1 -IsoPath "C:\path\to\ubuntu-24.04-live-server-amd64.iso"
& "$env:ProgramFiles\Oracle\VirtualBox\VBoxManage.exe" startvm sen421-vm
```

Install Ubuntu Server (minimal is fine, tick **Install OpenSSH server**). After the reboot, from
the host:

```powershell
scp -P 2222 app\server.js vm\setup.sh vm\api.service <user>@127.0.0.1:~
ssh -p 2222 <user>@127.0.0.1 "sudo bash setup.sh"
```

After changing `server.js` later, copy it again and restart the service:

```powershell
scp -P 2222 app\server.js <user>@127.0.0.1:~
ssh -t -p 2222 <user>@127.0.0.1 "sudo cp server.js /opt/api/server.js && sudo systemctl restart api"
```

Check `curl http://127.0.0.1:8081/health` from the host, then shut the VM down
(`sudo poweroff`) and remove the installer ISO from the virtual DVD drive.

## 4. Measure

Close other heavy programs, plug in the laptop, and use the same power mode for every run.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\measure.ps1 -Target docker
powershell -ExecutionPolicy Bypass -File scripts\measure.ps1 -Target vm
node scripts\summarize.js
```

Defaults: 3 runs, 50 virtual users, 2 minutes per load test, 60 s cooldown. Change them with
`-Runs`, `-Vus`, `-Duration`, `-CooldownSec`. Only one platform runs at a time.

Metric notes:
- `platform_mem_*`: for the VM this is the whole `VirtualBoxVM` process on the host (guest OS +
  app). For Docker it is the container's cgroup memory. `docker_backend_mem_idle` is the
  memory of Docker Desktop's own WSL 2 VM (`vmmem`), which is shared by all containers.
- `app_rss_*`: memory of the Node.js process itself, reported by the API. It is about the same in
  both, so the difference is the platform overhead.

## 5. Clean up

```powershell
docker rm -f sen421-api; docker rmi sen421-api:1.0
& "$env:ProgramFiles\Oracle\VirtualBox\VBoxManage.exe" unregistervm sen421-vm --delete
```

No cloud resources are used, so the actual cost is 0 USD. No secrets are stored in this repository.
