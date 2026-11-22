# Results summary (mean ± sample standard deviation)

Runs: VM = 3, Docker = 3

| Metric | Unit | VM | Docker | VM / Docker |
|---|---|---|---|---|
| Disk footprint | MB | 6138 | 228 | 26.9× |
| Start time (cold) | ms | 70736 ± 5081 | 552 ± 285 | 128.2× |
| Start time (warm / resume) | ms | 15387 ± 1459 | 320 ± 26.5 | 48.1× |
| Stop time | ms | 10184 ± 1134 | 432 ± 28.8 | 23.6× |
| App process memory, idle | MB | 58.1 ± 0.1 | 60.8 ± 0.3 | 1.0× |
| Platform memory, idle | MB | 844 ± 16.9 | 12.4 ± 0.9 | 67.8× |
| Platform memory, under load | MB | 858 ± 15.3 | 58.4 ± 1.8 | 14.7× |
| Docker backend VM memory, idle | MB | -- | 1290 ± 160 | -- |
| Response time, median | ms | 176 ± 87.9 | 21.3 ± 0.6 | 8.3× |
| Response time, p95 | ms | 253 ± 104 | 39.6 ± 1.3 | 6.4× |
| Throughput | req/s | 368 ± 223 | 2174 ± 66.0 | 0.2× |
| Failed requests | % | 0.03 ± 0.03 | 0.00 ± 0.00 | -- |
