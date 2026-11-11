/**
 * `npm run seed`: demo mağazasına 20 sahte sipariş yazar.
 *
 * Tarihler "bugünden N gün önce" diye hesaplanır; böylece "30 günü geçmiş teslimat"
 * gibi senaryolar seed ne zaman çalışırsa çalışsın doğru kalır.
 * Sadece `orders` silinip yeniden yazılır; sohbetlere ve trace'lere dokunulmaz.
 *
 * Demo senaryoları için öne çıkan siparişler:
 *   #1042  ayse@example.com    kargoda, takip linki var       → "siparişim nerede?"
 *   #1035  mehmet@example.com  45 gün önce teslim edildi      → iade süresi geçmiş
 *   #1038  zeynep@example.com  final sale ürün içeriyor       → iade edilemez
 *   #1044  can@example.com     hazırlanıyor
 *   #1046  elif@example.com    iptal edildi
 *   #1047  burak@example.com   3.649 TL, 5 gün önce teslim    → yüksek tutar, insan onayı
 */
import { collections, closeDb } from "../app/lib/db.server";
import type { Order, OrderItem, OrderStatus } from "../app/lib/types";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

const catalog = {
  tee: { sku: "TEE-BLK-M", name: "Basic T-shirt (black, M)", price: 349 },
  hoodie: { sku: "HOOD-GRY-L", name: "Hoodie (grey, L)", price: 899 },
  jeans: { sku: "JEAN-BLU-32", name: "Slim jeans (blue, 32)", price: 1199 },
  sneakers: { sku: "SNK-WHT-40", name: "Leather sneakers (white, 40)", price: 2299 },
  jacket: { sku: "JKT-OLV-M", name: "Field jacket (olive, M)", price: 2450 },
  socks: { sku: "SOCK-3PK", name: "Socks, 3-pack", price: 149 },
  cap: { sku: "CAP-NVY", name: "Cap (navy)", price: 299 },
  scarf: { sku: "SCARF-WOOL", name: "Wool scarf", price: 549 },
  bag: { sku: "BAG-CNV", name: "Canvas tote bag", price: 399 },
  sunglasses: { sku: "SUN-TRT", name: "Sunglasses (tortoise)", price: 1000 },
};

type Key = keyof typeof catalog;
const item = (key: Key, qty = 1, finalSale = false): OrderItem => ({ ...catalog[key], qty, finalSale });

interface Spec {
  n: number;
  email: string;
  name: string;
  status: OrderStatus;
  items: OrderItem[];
  createdDaysAgo: number;
  shippedDaysAgo?: number;
  deliveredDaysAgo?: number;
}

const specs: Spec[] = [
  { n: 1030, email: "ayse@example.com", name: "Ayşe Yılmaz", status: "delivered", items: [item("tee", 2)], createdDaysAgo: 60, shippedDaysAgo: 58, deliveredDaysAgo: 55 },
  { n: 1031, email: "john@example.com", name: "John Carter", status: "delivered", items: [item("hoodie")], createdDaysAgo: 40, shippedDaysAgo: 38, deliveredDaysAgo: 36 },
  { n: 1032, email: "selin@example.com", name: "Selin Kaya", status: "delivered", items: [item("jeans"), item("socks")], createdDaysAgo: 25, shippedDaysAgo: 23, deliveredDaysAgo: 21 },
  { n: 1033, email: "emma@example.com", name: "Emma Brown", status: "delivered", items: [item("cap")], createdDaysAgo: 20, shippedDaysAgo: 18, deliveredDaysAgo: 16 },
  { n: 1034, email: "ali@example.com", name: "Ali Demir", status: "shipped", items: [item("bag")], createdDaysAgo: 4, shippedDaysAgo: 2 },
  // 30 günlük iade süresi geçmiş
  { n: 1035, email: "mehmet@example.com", name: "Mehmet Şahin", status: "delivered", items: [item("sneakers")], createdDaysAgo: 50, shippedDaysAgo: 48, deliveredDaysAgo: 45 },
  { n: 1036, email: "lucas@example.com", name: "Lucas Martin", status: "delivered", items: [item("scarf"), item("cap")], createdDaysAgo: 14, shippedDaysAgo: 12, deliveredDaysAgo: 10 },
  { n: 1037, email: "deniz@example.com", name: "Deniz Arslan", status: "processing", items: [item("tee"), item("socks", 2)], createdDaysAgo: 1 },
  // final sale ürün (iade edilemez) + normal ürün
  { n: 1038, email: "zeynep@example.com", name: "Zeynep Çelik", status: "delivered", items: [item("jacket", 1, true), item("socks")], createdDaysAgo: 14, shippedDaysAgo: 12, deliveredDaysAgo: 10 },
  { n: 1039, email: "olivia@example.com", name: "Olivia Smith", status: "shipped", items: [item("hoodie"), item("tee")], createdDaysAgo: 5, shippedDaysAgo: 3 },
  { n: 1040, email: "emre@example.com", name: "Emre Koç", status: "delivered", items: [item("sunglasses")], createdDaysAgo: 9, shippedDaysAgo: 7, deliveredDaysAgo: 5 },
  { n: 1041, email: "noah@example.com", name: "Noah Wilson", status: "cancelled", items: [item("jeans")], createdDaysAgo: 12 },
  // ana demo: kargoda
  { n: 1042, email: "ayse@example.com", name: "Ayşe Yılmaz", status: "shipped", items: [item("hoodie"), item("cap")], createdDaysAgo: 3, shippedDaysAgo: 1 },
  { n: 1043, email: "sophia@example.com", name: "Sophia Davis", status: "delivered", items: [item("bag"), item("scarf")], createdDaysAgo: 30, shippedDaysAgo: 28, deliveredDaysAgo: 27 },
  { n: 1044, email: "can@example.com", name: "Can Öztürk", status: "processing", items: [item("sneakers")], createdDaysAgo: 0 },
  { n: 1045, email: "mia@example.com", name: "Mia Johnson", status: "delivered", items: [item("tee", 3, true)], createdDaysAgo: 8, shippedDaysAgo: 6, deliveredDaysAgo: 4 },
  { n: 1046, email: "elif@example.com", name: "Elif Aydın", status: "cancelled", items: [item("jacket")], createdDaysAgo: 6 },
  // yüksek tutar (≥ 3.000 TL), iade süresi içinde
  { n: 1047, email: "burak@example.com", name: "Burak Yıldız", status: "delivered", items: [item("jacket"), item("jeans")], createdDaysAgo: 9, shippedDaysAgo: 7, deliveredDaysAgo: 5 },
  { n: 1048, email: "james@example.com", name: "James Taylor", status: "shipped", items: [item("sneakers"), item("socks")], createdDaysAgo: 3, shippedDaysAgo: 1 },
  { n: 1049, email: "ece@example.com", name: "Ece Polat", status: "delivered", items: [item("scarf")], createdDaysAgo: 33, shippedDaysAgo: 31, deliveredDaysAgo: 29 },
];

const orders: Order[] = specs.map((s) => {
  const orderNumber = `#${s.n}`;
  const hasTracking = s.shippedDaysAgo !== undefined;
  return {
    orderNumber,
    email: s.email.toLowerCase(),
    customerName: s.name,
    status: s.status,
    items: s.items,
    total: s.items.reduce((sum, i) => sum + i.price * i.qty, 0),
    currency: "TRY",
    createdAt: daysAgo(s.createdDaysAgo),
    ...(s.shippedDaysAgo !== undefined && { shippedAt: daysAgo(s.shippedDaysAgo) }),
    ...(s.deliveredDaysAgo !== undefined && { deliveredAt: daysAgo(s.deliveredDaysAgo) }),
    ...(hasTracking && { trackingUrl: `https://track.example.com/TR${s.n}SD` }),
  };
});

try {
  const col = collections.orders();
  await col.deleteMany({});
  await col.insertMany(orders);
  // Index'ler: PostgreSQL'deki UNIQUE / INDEX ile aynı fikir.
  await col.createIndex({ orderNumber: 1 }, { unique: true });
  await collections.conversations().createIndex({ updatedAt: -1 });
  await collections.traces().createIndex({ runId: 1 }, { unique: true });
  await collections.traces().createIndex({ conversationId: 1, startedAt: -1 });

  console.log(`✅ ${orders.length} sipariş yazıldı.`);
  for (const o of orders) {
    const flags = [
      o.items.some((i) => i.finalSale) && "final sale",
      o.total >= 3000 && "yüksek tutar",
      o.deliveredAt && Date.now() - o.deliveredAt.getTime() > 30 * DAY && ">30 gün",
    ].filter(Boolean);
    console.log(`   ${o.orderNumber}  ${o.status.padEnd(10)} ${String(o.total).padStart(5)} TRY  ${o.email}${flags.length ? "  [" + flags.join(", ") + "]" : ""}`);
  }
} finally {
  await closeDb();
}
