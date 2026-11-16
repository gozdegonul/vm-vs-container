// Supply Chain API used for the VM vs. container comparison (SEN421, Topic 2).
//
// One file, zero external dependencies: the exact same file runs in the VM and in the
// container. All data is synthetic and generated at startup from a fixed seed, so every
// run starts from the same state (no real or personal data, no database).
//
// Domain: 20 warehouses in Turkish cities connected by a road network, 50 suppliers,
// 500 products with 90 days of demand history, ~5,000 inventory rows, customer orders
// with stock reservation, purchase orders, route planning, demand forecasting,
// replenishment planning (EOQ / safety stock / reorder point) and ABC analysis.
//
// Endpoints (all JSON):
//   GET   /health                                  liveness + process memory (used for startup timing)
//   GET   /api                                     list of endpoints
//   GET   /api/warehouses                          all warehouses
//   GET   /api/warehouses/:id                      one warehouse with road links and stock totals
//   GET   /api/warehouses/:id/inventory            stock rows (?lowStock=true&page=&limit=)
//   GET   /api/warehouses/:id/replenishment        reorder recommendations for the warehouse   [CPU]
//   GET   /api/suppliers                           suppliers (?page=&limit=)
//   GET   /api/suppliers/:id                       one supplier with its products
//   GET   /api/products                            products (?category=&supplierId=&q=&page=&limit=)
//   GET   /api/products/:sku                       one product with demand statistics
//   GET   /api/products/:sku/stock                 stock of one product in every warehouse
//   GET   /api/products/:sku/forecast              demand forecast (?days=1..60)                [CPU]
//   GET   /api/routes                              shortest road route (?from=WH-01&to=WH-12)
//   GET   /api/orders                              orders (?status=&page=&limit=)
//   POST  /api/orders                              create an order, reserve stock, plan delivery
//   GET   /api/orders/:id                          one order
//   PATCH /api/orders/:id/status                   move an order through its life cycle
//   GET   /api/purchase-orders                     purchase orders (?status=&page=&limit=)
//   POST  /api/purchase-orders                     order goods from the product's supplier
//   POST  /api/purchase-orders/:id/receive         receive goods into the warehouse
//   GET   /api/analytics/abc                       ABC classification of products               [CPU]
//   GET   /api/analytics/stock-value               stock value per warehouse
'use strict';

const http = require('http');
const os = require('os');

const PORT = parseInt(process.env.PORT || '8080', 10);
const SEED = parseInt(process.env.SEED || '421', 10);
const STARTED_AT = Date.now();
const MAX_BODY_BYTES = 100 * 1024;
const MAX_STORED_ORDERS = 20000; // keeps memory bounded during long load tests
const MAX_STORED_POS = 5000;

// ---------------------------------------------------------------------------
// Deterministic random numbers (mulberry32), so the data set is identical on every start.
// ---------------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const randInt = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const pad = (n, w) => String(n).padStart(w, '0');
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------
const CITIES = [
  ['Istanbul', 41.01, 28.98], ['Ankara', 39.93, 32.86], ['Izmir', 38.42, 27.14],
  ['Bursa', 40.19, 29.06], ['Antalya', 36.9, 30.7], ['Adana', 37.0, 35.32],
  ['Konya', 37.87, 32.48], ['Gaziantep', 37.07, 37.38], ['Kayseri', 38.73, 35.49],
  ['Samsun', 41.29, 36.33], ['Trabzon', 41.0, 39.72], ['Erzurum', 39.9, 41.27],
  ['Diyarbakir', 37.91, 40.23], ['Eskisehir', 39.78, 30.52], ['Mersin', 36.81, 34.64],
  ['Denizli', 37.78, 29.09], ['Sakarya', 40.78, 30.4], ['Van', 38.5, 43.38],
  ['Malatya', 38.35, 38.31], ['Tekirdag', 40.98, 27.51],
];

const CATEGORIES = {
  electronics: ['Sensor', 'Controller', 'Battery Pack', 'Cable Set', 'Display Panel'],
  food: ['Olive Oil', 'Hazelnut Pack', 'Dried Apricot', 'Pasta Box', 'Tea Crate'],
  textile: ['Cotton Roll', 'Denim Bolt', 'Towel Set', 'Uniform Kit', 'Wool Yarn'],
  automotive: ['Brake Pad', 'Oil Filter', 'Spark Plug', 'Wiper Blade', 'Headlamp'],
  chemicals: ['Detergent Drum', 'Paint Can', 'Adhesive Tube', 'Solvent Barrel', 'Resin Bag'],
  furniture: ['Office Chair', 'Desk Frame', 'Shelf Unit', 'Cabinet', 'Stool'],
  medical: ['Glove Box', 'Syringe Pack', 'Bandage Roll', 'Mask Box', 'Thermometer'],
  packaging: ['Carton Box', 'Pallet Wrap', 'Bubble Roll', 'Tape Pack', 'Crate'],
};
const CATEGORY_NAMES = Object.keys(CATEGORIES);
const SUPPLIER_PREFIX = ['Anadolu', 'Ege', 'Marmara', 'Karadeniz', 'Akdeniz', 'Toros', 'Kapadokya', 'Trakya', 'Bogazici', 'Delta'];
const SUPPLIER_SUFFIX = ['Trading', 'Logistics', 'Manufacturing', 'Industries', 'Supply'];

// Planning parameters
const SERVICE_LEVEL_Z = 1.645; // 95 % cycle service level
const ORDER_COST_USD = 50; // fixed cost per purchase order
const HOLDING_RATE = 0.25; // yearly holding cost as a share of unit cost
const SALES_MARKUP = 1.3;
const TRUCK_SPEED_KMH = 65;
const HANDLING_HOURS = 4;
const ROAD_FACTOR = 1.25; // road distance / straight-line distance
const HISTORY_DAYS = 90;

// ---------------------------------------------------------------------------
// Data generation
// ---------------------------------------------------------------------------
function haversineKm(a, b) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const warehouses = CITIES.map(([city, lat, lon], i) => ({
  id: `WH-${pad(i + 1, 2)}`,
  name: `${city} Distribution Center`,
  city,
  lat,
  lon,
  capacityUnits: randInt(200, 800) * 1000,
  skus: [], // SKUs stocked here
}));
const warehouseById = new Map(warehouses.map((w) => [w.id, w]));
const warehouseByCity = new Map(warehouses.map((w) => [w.city.toLowerCase(), w]));

// Road network: each warehouse is linked to its 3 nearest neighbours, then any separate
// groups are joined by their closest pair so that every warehouse is reachable.
const roads = new Map(warehouses.map((w) => [w.id, []]));
function addRoad(a, b) {
  if (a === b || roads.get(a.id).some((e) => e.to === b.id)) return;
  const km = round(haversineKm(a, b) * ROAD_FACTOR, 1);
  roads.get(a.id).push({ to: b.id, km });
  roads.get(b.id).push({ to: a.id, km });
}
for (const w of warehouses) {
  warehouses
    .filter((o) => o !== w)
    .sort((x, y) => haversineKm(w, x) - haversineKm(w, y))
    .slice(0, 3)
    .forEach((o) => addRoad(w, o));
}
function components() {
  const seen = new Set();
  const groups = [];
  for (const w of warehouses) {
    if (seen.has(w.id)) continue;
    const group = [];
    const stack = [w.id];
    seen.add(w.id);
    while (stack.length) {
      const id = stack.pop();
      group.push(warehouseById.get(id));
      for (const e of roads.get(id)) if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
    }
    groups.push(group);
  }
  return groups;
}
for (let groups = components(); groups.length > 1; groups = components()) {
  let best = null;
  for (const a of groups[0]) for (const g of groups.slice(1)) for (const b of g) {
    const d = haversineKm(a, b);
    if (!best || d < best.d) best = { a, b, d };
  }
  addRoad(best.a, best.b);
}

const suppliers = Array.from({ length: 50 }, (_, i) => ({
  id: `SUP-${pad(i + 1, 3)}`,
  name: `${pick(SUPPLIER_PREFIX)} ${pick(SUPPLIER_SUFFIX)} ${pad(i + 1, 2)}`,
  city: pick(CITIES)[0],
  reliability: round(0.8 + rnd() * 0.19, 3), // share of deliveries on time
  leadTimeDays: randInt(2, 21),
  minOrderQty: pick([10, 25, 50, 100]),
}));
const supplierById = new Map(suppliers.map((s) => [s.id, s]));

const products = Array.from({ length: 500 }, (_, i) => {
  const category = CATEGORY_NAMES[i % CATEGORY_NAMES.length];
  const base = randInt(5, 60);
  const trend = (rnd() - 0.4) * 0.5; // relative change over the 90 days
  const weekly = rnd() * 0.3;
  const history = Array.from({ length: HISTORY_DAYS }, (_, t) => {
    const level = base * (1 + (trend * t) / HISTORY_DAYS);
    const season = 1 + weekly * Math.sin((2 * Math.PI * t) / 7);
    const noise = 1 + (rnd() - 0.5) * 0.4;
    return Math.max(0, Math.round(level * season * noise));
  });
  return {
    sku: `SKU-${pad(i + 1, 5)}`,
    name: `${pick(CATEGORIES[category])} ${String.fromCharCode(65 + randInt(0, 7))}${randInt(10, 99)}`,
    category,
    supplierId: suppliers[randInt(0, suppliers.length - 1)].id,
    unitCost: round(2 + rnd() * 398),
    unitWeightKg: round(0.1 + rnd() * 25, 1),
    history, // units sold per day, network-wide, oldest first
    stockedIn: 0,
  };
});
const productBySku = new Map(products.map((p) => [p.sku, p]));

// Inventory: every warehouse stocks 250 different products.
const inventory = new Map(); // key "WH-01|SKU-00001"
const invKey = (wid, sku) => `${wid}|${sku}`;
for (const w of warehouses) {
  const idx = products.map((_, i) => i);
  for (let i = 0; i < 250; i++) {
    const j = i + Math.floor(rnd() * (idx.length - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
    const p = products[idx[i]];
    inventory.set(invKey(w.id, p.sku), { warehouseId: w.id, sku: p.sku, onHand: randInt(10, 400), reserved: 0 });
    w.skus.push(p.sku);
    p.stockedIn++;
  }
}

const orders = new Map();
const purchaseOrders = new Map();
let orderSeq = 0;
let poSeq = 0;

// ---------------------------------------------------------------------------
// Domain logic
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function stockView(row) {
  return { warehouseId: row.warehouseId, sku: row.sku, onHand: row.onHand, reserved: row.reserved, available: row.onHand - row.reserved };
}

function demandStats(series) {
  const n = series.length;
  const mean = series.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(series.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  return { mean, sd };
}

// Dijkstra's shortest path on the road network.
function shortestRoute(fromId, toId) {
  const dist = new Map(warehouses.map((w) => [w.id, Infinity]));
  const prev = new Map();
  const done = new Set();
  dist.set(fromId, 0);
  while (done.size < warehouses.length) {
    let u = null;
    for (const [id, d] of dist) if (!done.has(id) && (u === null || d < dist.get(u))) u = id;
    if (u === null || dist.get(u) === Infinity || u === toId) break;
    done.add(u);
    for (const e of roads.get(u)) {
      const alt = dist.get(u) + e.km;
      if (alt < dist.get(e.to)) { dist.set(e.to, alt); prev.set(e.to, u); }
    }
  }
  const path = [toId];
  while (path[0] !== fromId) path.unshift(prev.get(path[0]));
  const km = round(dist.get(toId), 1);
  return {
    from: fromId,
    to: toId,
    path: path.map((id) => ({ id, city: warehouseById.get(id).city })),
    distanceKm: km,
    etaHours: round(km / TRUCK_SPEED_KMH + HANDLING_HOURS, 1),
  };
}

// Inventory policy for one stock row: safety stock, reorder point and economic order quantity.
function planRow(row) {
  const p = productBySku.get(row.sku);
  const s = supplierById.get(p.supplierId);
  const share = 1 / Math.max(p.stockedIn, 1); // this warehouse's share of network demand
  const { mean, sd } = demandStats(p.history);
  const daily = mean * share;
  const dailySd = sd * share;
  const L = s.leadTimeDays;
  const safetyStock = SERVICE_LEVEL_Z * dailySd * Math.sqrt(L);
  const reorderPoint = daily * L + safetyStock;
  const yearly = daily * 365;
  const holding = HOLDING_RATE * p.unitCost;
  const eoq = yearly > 0 && holding > 0 ? Math.sqrt((2 * yearly * ORDER_COST_USD) / holding) : 0;
  const available = row.onHand - row.reserved;
  return {
    sku: p.sku,
    name: p.name,
    supplierId: s.id,
    available,
    avgDailyDemand: round(daily),
    leadTimeDays: L,
    safetyStock: Math.ceil(safetyStock),
    reorderPoint: Math.ceil(reorderPoint),
    economicOrderQty: Math.max(Math.ceil(eoq), s.minOrderQty),
    daysOfCover: daily > 0 ? round(available / daily, 1) : null,
    needsReorder: available <= reorderPoint,
  };
}

// Holt's linear exponential smoothing; alpha and beta chosen by grid search (lowest squared error).
function holt(series, alpha, beta) {
  let level = series[0];
  let trend = series[1] - series[0];
  let sse = 0;
  for (let t = 1; t < series.length; t++) {
    const err = series[t] - (level + trend);
    sse += err * err;
    const prevLevel = level;
    level = alpha * series[t] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }
  return { level, trend, sse };
}
const FORECAST_GRID = 50; // alpha and beta tried in steps of 1/50 -> 49 x 49 model fits per request
function forecastDemand(series, days) {
  let best = null;
  for (let a = 1; a < FORECAST_GRID; a++) {
    for (let b = 1; b < FORECAST_GRID; b++) {
      const r = holt(series, a / FORECAST_GRID, b / FORECAST_GRID);
      if (!best || r.sse < best.sse) best = { ...r, alpha: a / FORECAST_GRID, beta: b / FORECAST_GRID };
    }
  }
  const values = Array.from({ length: days }, (_, h) => Math.max(0, round(best.level + best.trend * (h + 1), 1)));
  return {
    method: 'Holt linear exponential smoothing',
    alpha: best.alpha,
    beta: best.beta,
    rmse: round(Math.sqrt(best.sse / (series.length - 1))),
    forecast: values,
    total: round(values.reduce((s, x) => s + x, 0), 1),
  };
}

function abcAnalysis() {
  const rows = products
    .map((p) => ({ sku: p.sku, name: p.name, category: p.category, yearlyValue: demandStats(p.history).mean * 365 * p.unitCost }))
    .sort((a, b) => b.yearlyValue - a.yearlyValue);
  const total = rows.reduce((s, r) => s + r.yearlyValue, 0);
  let cum = 0;
  const summary = { A: { count: 0, valueShare: 0 }, B: { count: 0, valueShare: 0 }, C: { count: 0, valueShare: 0 } };
  for (const r of rows) {
    cum += r.yearlyValue;
    const share = cum / total;
    r.class = share <= 0.8 ? 'A' : share <= 0.95 ? 'B' : 'C';
    r.cumulativeShare = round(share, 4);
    summary[r.class].count++;
    summary[r.class].valueShare += r.yearlyValue / total;
    r.yearlyValue = round(r.yearlyValue);
  }
  for (const k of Object.keys(summary)) summary[k].valueShare = round(summary[k].valueShare, 4);
  return { totalYearlyValueUsd: round(total), summary, rows };
}

const ORDER_TRANSITIONS = {
  CONFIRMED: ['PICKED', 'CANCELLED'],
  PICKED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

function evictOldest(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

// ---------------------------------------------------------------------------
// Validation and HTTP helpers
// ---------------------------------------------------------------------------
function clampInt(value, def, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}

function paginate(items, q) {
  const limit = clampInt(q.get('limit'), 20, 1, 100);
  const page = clampInt(q.get('page'), 1, 1, 1e6);
  const start = (page - 1) * limit;
  return { page, limit, total: items.length, pages: Math.ceil(items.length / limit), data: items.slice(start, start + limit) };
}

function requireWarehouse(id) {
  const w = warehouseById.get(id);
  if (!w) throw new HttpError(404, `warehouse ${id} not found`);
  return w;
}
function requireProduct(sku) {
  const p = productBySku.get(sku);
  if (!p) throw new HttpError(404, `product ${sku} not found`);
  return p;
}
function isPositiveInt(x, max) {
  return Number.isInteger(x) && x >= 1 && x <= max;
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'request body too large'));
      if (!chunks.length) return resolve({});
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch {
        reject(new HttpError(400, 'body must be a JSON object'));
      }
    });
    req.on('error', reject);
  });
}

// Tiny router: "/api/orders/:id" -> regular expression with named parameters.
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, pattern, re, keys, handler });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
route('GET', '/health', () => ({
  status: 'ok',
  host: os.hostname(),
  uptimeMs: Date.now() - STARTED_AT,
  rssMB: round(process.memoryUsage().rss / 1048576, 1),
}));

route('GET', '/api', () => ({
  name: 'SEN421 Supply Chain API',
  data: { warehouses: warehouses.length, suppliers: suppliers.length, products: products.length, inventoryRows: inventory.size },
  endpoints: routes.map((r) => `${r.method} ${r.pattern}`),
}));

// Warehouses
route('GET', '/api/warehouses', () =>
  warehouses.map(({ skus, ...w }) => ({ ...w, skuCount: skus.length })));

route('GET', '/api/warehouses/:id', ({ params }) => {
  const { skus, ...w } = requireWarehouse(params.id);
  let units = 0;
  let value = 0;
  for (const sku of skus) {
    const row = inventory.get(invKey(w.id, sku));
    units += row.onHand;
    value += row.onHand * productBySku.get(sku).unitCost;
  }
  return {
    ...w,
    skuCount: skus.length,
    unitsOnHand: units,
    utilization: round(units / w.capacityUnits, 4),
    stockValueUsd: round(value),
    roads: roads.get(w.id).map((e) => ({ to: e.to, city: warehouseById.get(e.to).city, km: e.km })),
  };
});

route('GET', '/api/warehouses/:id/inventory', ({ params, query }) => {
  const w = requireWarehouse(params.id);
  let rows = w.skus.map((sku) => inventory.get(invKey(w.id, sku)));
  if (query.get('lowStock') === 'true') rows = rows.filter((r) => planRow(r).needsReorder);
  const page = paginate(rows, query);
  page.data = page.data.map((r) => ({ ...stockView(r), name: productBySku.get(r.sku).name }));
  return page;
});

route('GET', '/api/warehouses/:id/replenishment', ({ params, query }) => {
  const w = requireWarehouse(params.id);
  const plans = w.skus.map((sku) => planRow(inventory.get(invKey(w.id, sku))));
  const toOrder = plans.filter((p) => p.needsReorder).sort((a, b) => (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity));
  const cost = toOrder.reduce((s, p) => s + p.economicOrderQty * productBySku.get(p.sku).unitCost, 0);
  return {
    warehouseId: w.id,
    serviceLevel: 0.95,
    checked: plans.length,
    reorderCount: toOrder.length,
    estimatedPurchaseCostUsd: round(cost),
    ...paginate(toOrder, query),
  };
});

// Suppliers
route('GET', '/api/suppliers', ({ query }) => paginate(suppliers, query));

route('GET', '/api/suppliers/:id', ({ params }) => {
  const s = supplierById.get(params.id);
  if (!s) throw new HttpError(404, `supplier ${params.id} not found`);
  const items = products.filter((p) => p.supplierId === s.id).map((p) => ({ sku: p.sku, name: p.name, unitCost: p.unitCost }));
  return { ...s, productCount: items.length, products: items };
});

// Products
const productSummary = (p) => ({ sku: p.sku, name: p.name, category: p.category, supplierId: p.supplierId, unitCost: p.unitCost, unitWeightKg: p.unitWeightKg });

route('GET', '/api/products', ({ query }) => {
  const category = query.get('category');
  const supplierId = query.get('supplierId');
  const q = (query.get('q') || '').toLowerCase();
  if (category && !CATEGORIES[category]) throw new HttpError(400, `unknown category; use one of: ${CATEGORY_NAMES.join(', ')}`);
  const rows = products.filter((p) =>
    (!category || p.category === category) &&
    (!supplierId || p.supplierId === supplierId) &&
    (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)));
  return paginate(rows.map(productSummary), query);
});

route('GET', '/api/products/:sku', ({ params }) => {
  const p = requireProduct(params.sku);
  const { mean, sd } = demandStats(p.history);
  return {
    ...productSummary(p),
    supplier: supplierById.get(p.supplierId),
    stockedIn: p.stockedIn,
    demand: { days: HISTORY_DAYS, avgDaily: round(mean), sdDaily: round(sd), last14Days: p.history.slice(-14) },
  };
});

route('GET', '/api/products/:sku/stock', ({ params }) => {
  const p = requireProduct(params.sku);
  const rows = warehouses.map((w) => inventory.get(invKey(w.id, p.sku))).filter(Boolean).map(stockView);
  const totals = rows.reduce((t, r) => ({ onHand: t.onHand + r.onHand, reserved: t.reserved + r.reserved, available: t.available + r.available }), { onHand: 0, reserved: 0, available: 0 });
  return { sku: p.sku, name: p.name, totals, warehouses: rows };
});

route('GET', '/api/products/:sku/forecast', ({ params, query }) => {
  const p = requireProduct(params.sku);
  const days = clampInt(query.get('days'), 14, 1, 60);
  return { sku: p.sku, days, basedOnDays: HISTORY_DAYS, ...forecastDemand(p.history, days) };
});

// Routes
route('GET', '/api/routes', ({ query }) => {
  const from = requireWarehouse(query.get('from') || '');
  const to = requireWarehouse(query.get('to') || '');
  return shortestRoute(from.id, to.id);
});

// Customer orders
route('GET', '/api/orders', ({ query }) => {
  const status = query.get('status');
  let rows = [...orders.values()];
  if (status) rows = rows.filter((o) => o.status === status);
  return paginate(rows.reverse(), query); // newest first
});

route('POST', '/api/orders', async ({ req }) => {
  const body = await readJson(req);
  const errors = [];
  if (typeof body.customer !== 'string' || !body.customer.trim() || body.customer.length > 100) errors.push('customer: 1-100 characters');
  if (typeof body.warehouseId !== 'string') errors.push('warehouseId: required');
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) errors.push('items: 1-50 lines');
  else body.items.forEach((it, i) => {
    if (!it || typeof it.sku !== 'string') errors.push(`items[${i}].sku: required`);
    if (!it || !isPositiveInt(it.qty, 1000)) errors.push(`items[${i}].qty: integer 1-1000`);
  });
  if (body.destinationCity !== undefined && typeof body.destinationCity !== 'string') errors.push('destinationCity: string');
  if (errors.length) throw new HttpError(400, 'validation failed', errors);

  const w = warehouseById.get(body.warehouseId);
  if (!w) throw new HttpError(422, `unknown warehouseId ${body.warehouseId}`);
  let dest = null;
  if (body.destinationCity) {
    dest = warehouseByCity.get(body.destinationCity.toLowerCase());
    if (!dest) throw new HttpError(422, `no delivery to ${body.destinationCity}; use a warehouse city`);
  }

  // Merge duplicate lines, then check every line before reserving anything (all or nothing).
  const wanted = new Map();
  for (const it of body.items) {
    if (!productBySku.has(it.sku)) throw new HttpError(422, `unknown sku ${it.sku}`);
    wanted.set(it.sku, (wanted.get(it.sku) || 0) + it.qty);
  }
  const shortages = [];
  for (const [sku, qty] of wanted) {
    const row = inventory.get(invKey(w.id, sku));
    const available = row ? row.onHand - row.reserved : 0;
    if (available < qty) shortages.push({ sku, requested: qty, available });
  }
  if (shortages.length) throw new HttpError(409, 'insufficient stock', shortages);

  let subtotal = 0;
  let weightKg = 0;
  const lines = [];
  for (const [sku, qty] of wanted) {
    inventory.get(invKey(w.id, sku)).reserved += qty;
    const p = productBySku.get(sku);
    const unitPrice = round(p.unitCost * SALES_MARKUP);
    subtotal += unitPrice * qty;
    weightKg += p.unitWeightKg * qty;
    lines.push({ sku, name: p.name, qty, unitPrice, lineTotal: round(unitPrice * qty) });
  }
  const delivery = dest ? shortestRoute(w.id, dest.id) : null;
  const shipping = delivery ? round(20 + delivery.distanceKm * 0.05 + weightKg * 0.1) : 0;

  const id = `ORD-${pad(++orderSeq, 7)}`;
  const at = nowIso();
  const order = {
    id,
    customer: body.customer.trim(),
    warehouseId: w.id,
    destinationCity: dest ? dest.city : null,
    status: 'CONFIRMED',
    items: lines,
    weightKg: round(weightKg, 1),
    subtotal: round(subtotal),
    shipping,
    total: round(subtotal + shipping),
    delivery,
    createdAt: at,
    history: [{ status: 'CONFIRMED', at }],
  };
  orders.set(id, order);
  evictOldest(orders, MAX_STORED_ORDERS);
  return [201, order];
});

route('GET', '/api/orders/:id', ({ params }) => {
  const o = orders.get(params.id);
  if (!o) throw new HttpError(404, `order ${params.id} not found`);
  return o;
});

route('PATCH', '/api/orders/:id/status', async ({ req, params }) => {
  const body = await readJson(req);
  const o = orders.get(params.id);
  if (!o) throw new HttpError(404, `order ${params.id} not found`);
  const next = body.status;
  if (!ORDER_TRANSITIONS[o.status].includes(next)) {
    throw new HttpError(409, `cannot change status from ${o.status} to ${next}`, { allowed: ORDER_TRANSITIONS[o.status] });
  }
  for (const line of o.items) {
    const row = inventory.get(invKey(o.warehouseId, line.sku));
    if (next === 'CANCELLED') row.reserved -= line.qty; // release the reservation
    if (next === 'SHIPPED') { row.reserved -= line.qty; row.onHand -= line.qty; } // goods leave the warehouse
  }
  o.status = next;
  o.history.push({ status: next, at: nowIso() });
  return o;
});

// Purchase orders (replenishment from suppliers)
route('GET', '/api/purchase-orders', ({ query }) => {
  const status = query.get('status');
  let rows = [...purchaseOrders.values()];
  if (status) rows = rows.filter((p) => p.status === status);
  return paginate(rows.reverse(), query);
});

route('POST', '/api/purchase-orders', async ({ req }) => {
  const body = await readJson(req);
  const w = warehouseById.get(body.warehouseId);
  if (!w) throw new HttpError(422, `unknown warehouseId ${body.warehouseId}`);
  const p = productBySku.get(body.sku);
  if (!p) throw new HttpError(422, `unknown sku ${body.sku}`);
  const s = supplierById.get(p.supplierId);
  let qty = body.qty;
  if (qty === undefined) {
    const row = inventory.get(invKey(w.id, p.sku)) || { warehouseId: w.id, sku: p.sku, onHand: 0, reserved: 0 };
    qty = planRow(row).economicOrderQty; // default: economic order quantity
  }
  if (!isPositiveInt(qty, 100000)) throw new HttpError(400, 'qty: integer 1-100000');
  if (qty < s.minOrderQty) throw new HttpError(422, `supplier ${s.id} minimum order is ${s.minOrderQty}`);
  const created = new Date();
  const po = {
    id: `PO-${pad(++poSeq, 6)}`,
    supplierId: s.id,
    warehouseId: w.id,
    sku: p.sku,
    qty,
    unitCost: p.unitCost,
    total: round(qty * p.unitCost),
    status: 'OPEN',
    createdAt: created.toISOString(),
    expectedAt: new Date(created.getTime() + s.leadTimeDays * 86400000).toISOString(),
  };
  purchaseOrders.set(po.id, po);
  evictOldest(purchaseOrders, MAX_STORED_POS);
  return [201, po];
});

route('POST', '/api/purchase-orders/:id/receive', ({ params }) => {
  const po = purchaseOrders.get(params.id);
  if (!po) throw new HttpError(404, `purchase order ${params.id} not found`);
  if (po.status !== 'OPEN') throw new HttpError(409, `purchase order is already ${po.status}`);
  const key = invKey(po.warehouseId, po.sku);
  if (!inventory.has(key)) {
    inventory.set(key, { warehouseId: po.warehouseId, sku: po.sku, onHand: 0, reserved: 0 });
    warehouseById.get(po.warehouseId).skus.push(po.sku);
    productBySku.get(po.sku).stockedIn++;
  }
  inventory.get(key).onHand += po.qty;
  po.status = 'RECEIVED';
  po.receivedAt = nowIso();
  return { ...po, stock: stockView(inventory.get(key)) };
});

// Analytics
route('GET', '/api/analytics/abc', ({ query }) => {
  const { rows, ...rest } = abcAnalysis();
  const cls = query.get('class');
  return { ...rest, ...paginate(cls ? rows.filter((r) => r.class === cls) : rows, query) };
});

route('GET', '/api/analytics/stock-value', () => {
  const perWarehouse = warehouses.map((w) => {
    let units = 0;
    let value = 0;
    for (const sku of w.skus) {
      const row = inventory.get(invKey(w.id, sku));
      units += row.onHand;
      value += row.onHand * productBySku.get(sku).unitCost;
    }
    return { warehouseId: w.id, city: w.city, units, valueUsd: round(value) };
  });
  return {
    totalUnits: perWarehouse.reduce((s, w) => s + w.units, 0),
    totalValueUsd: round(perWarehouse.reduce((s, w) => s + w.valueUsd, 0)),
    warehouses: perWarehouse.sort((a, b) => b.valueUsd - a.valueUsd),
  };
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    const matching = routes.filter((r) => r.re.test(path));
    if (!matching.length) throw new HttpError(404, 'not found');
    const r = matching.find((m) => m.method === req.method);
    if (!r) {
      res.setHeader('Allow', matching.map((m) => m.method).join(', '));
      throw new HttpError(405, 'method not allowed');
    }
    const values = path.match(r.re).slice(1);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, values[i]]));
    const result = await r.handler({ req, params, query: url.searchParams });
    if (Array.isArray(result) && typeof result[0] === 'number' && result.length === 2) send(res, result[0], result[1]);
    else send(res, 200, result);
  } catch (err) {
    if (err instanceof HttpError) {
      send(res, err.status, err.details ? { error: err.message, details: err.details } : { error: err.message });
    } else if (err instanceof URIError) {
      send(res, 400, { error: 'malformed URL' });
    } else {
      console.error(err);
      send(res, 500, { error: 'internal server error' });
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `READY port=${PORT} pid=${process.pid} node=${process.version} ` +
    `warehouses=${warehouses.length} suppliers=${suppliers.length} products=${products.length} ` +
    `inventoryRows=${inventory.size} startupMs=${Date.now() - STARTED_AT}`
  );
});

// Graceful shutdown so `docker stop` and `systemctl stop` return quickly.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref(); // do not wait for idle keep-alive connections
  });
}
