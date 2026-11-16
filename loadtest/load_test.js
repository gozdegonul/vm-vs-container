// k6 load test for the Supply Chain API: closed loop, constant virtual users, no think time,
// so requests per second shows the capacity of each platform.
// Usage: k6 run --vus 50 --duration 2m --env BASE_URL=http://127.0.0.1:8080 load_test.js
//
// Each iteration is one realistic "user session":
//   browse the catalogue -> check stock -> open a warehouse inventory page -> place an order
//   -> look at a demand forecast -> plan a route; about 1 in 10 also runs replenishment planning.
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:8080';

// 409 (not enough stock) is a valid business answer, not a server failure.
http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

const WAREHOUSES = Array.from({ length: 20 }, (_, i) => `WH-${String(i + 1).padStart(2, '0')}`);
const CITIES = ['Istanbul', 'Ankara', 'Izmir', 'Bursa', 'Antalya', 'Adana', 'Konya', 'Gaziantep', 'Kayseri', 'Samsun',
  'Trabzon', 'Erzurum', 'Diyarbakir', 'Eskisehir', 'Mersin', 'Denizli', 'Sakarya', 'Van', 'Malatya', 'Tekirdag'];
const CATEGORIES = ['electronics', 'food', 'textile', 'automotive', 'chemicals', 'furniture', 'medical', 'packaging'];

const any = (arr) => arr[Math.floor(Math.random() * arr.length)];
const between = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const ok = (res, name) => check(res, { [`${name} ok`]: (r) => r.status >= 200 && r.status < 300 });

export default function () {
  const wh = any(WAREHOUSES);
  const sku = `SKU-${String(between(1, 500)).padStart(5, '0')}`;

  ok(http.get(`${BASE_URL}/api/products?category=${any(CATEGORIES)}&page=${between(1, 3)}`,
    { tags: { name: 'products_list' } }), 'products_list');

  ok(http.get(`${BASE_URL}/api/products/${sku}/stock`, { tags: { name: 'product_stock' } }), 'product_stock');

  const inv = http.get(`${BASE_URL}/api/warehouses/${wh}/inventory?page=${between(1, 12)}&limit=20`,
    { tags: { name: 'inventory' } });
  ok(inv, 'inventory');

  let rows = [];
  try { rows = inv.json('data') || []; } catch (e) { rows = []; }
  if (rows.length) {
    const items = [any(rows), any(rows)].map((r) => ({ sku: r.sku, qty: between(1, 3) }));
    const order = http.post(`${BASE_URL}/api/orders`,
      JSON.stringify({ customer: `load-test-vu-${__VU}`, warehouseId: wh, destinationCity: any(CITIES), items }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'create_order' } });
    check(order, { 'create_order 201 or 409': (r) => r.status === 201 || r.status === 409 });
  }

  ok(http.get(`${BASE_URL}/api/products/${sku}/forecast?days=14`, { tags: { name: 'forecast' } }), 'forecast');

  ok(http.get(`${BASE_URL}/api/routes?from=${wh}&to=${any(WAREHOUSES)}`, { tags: { name: 'route' } }), 'route');

  if (Math.random() < 0.1) {
    ok(http.get(`${BASE_URL}/api/warehouses/${wh}/replenishment?limit=10`, { tags: { name: 'replenishment' } }), 'replenishment');
  }
}
