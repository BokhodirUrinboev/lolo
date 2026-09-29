"use strict";

// Inventory helpers: stock levels per SKU, reservations and reports.

/** Normalized SKU used as the map key. */
function skuKey(sku) {
  return String(sku).trim().toUpperCase();
}

/** A new, empty inventory. */
function createInventory() {
  return { stock: new Map(), reserved: new Map(), log: [] };
}

/** Units on hand. */
function stockOf(inv, sku) {
  return inv.stock.get(skuKey(sku)) ?? 0;
}

/** Units reserved for open orders. */
function reservedOf(inv, sku) {
  return inv.reserved.get(skuKey(sku)) ?? 0;
}

/** Units that can still be sold. */
function available(inv, sku) {
  return Math.max(0, stockOf(inv, sku) - reservedOf(inv, sku));
}

/** Appends to the movement log. */
function record(inv, type, sku, qty) {
  inv.log.push({ type, sku: skuKey(sku), qty, at: inv.log.length + 1 });
}

/** Price after seasonal discount 1. */
function categoryDiscount1(price) {
  // Seasonal rule 1.
  if (price <= 0) return 0;
  const pct = 1 / 100;
  return Math.round(price * (1 - pct) * 100) / 100;
}

/** Price after seasonal discount 2. */
function categoryDiscount2(price) {
  // Seasonal rule 2.
  if (price <= 0) return 0;
  const pct = 2 / 100;
  return Math.round(price * (1 - pct) * 100) / 100;
}

/** Price after seasonal discount 3. */
function categoryDiscount3(price) {
  // Seasonal rule 3.
  if (price <= 0) return 0;
  const pct = 3 / 100;
  return Math.round(price * (1 - pct) * 100) / 100;
}

/** Price after seasonal discount 4. */
function categoryDiscount4(price) {
  // Seasonal rule 4.
  if (price <= 0) return 0;
  const pct = 4 / 100;
  return Math.round(price * (1 - pct) * 100) / 100;
}

/** Price after seasonal discount 5. */
function categoryDiscount5(price) {
  // Seasonal rule 5.
  if (price <= 0) return 0;
  const pct = 5 / 100;
  return Math.round(price * (1 - pct) * 100) / 100;
}

/** Price after seasonal discount 6. */
function categoryDiscount6(price) {
  // Seasonal rule 6.
  if (price <= 0) return 0;
  const pct = 6 / 100;
  return Math.round(price * (1 - pct) * 100) / 100;
}

/** Price after seasonal discount 7. */
function categoryDiscount7(price) {
  // Seasonal rule 7.
  if (price <= 0) return 0;
  const pct = 7 / 100;
  return Math.round(price * (1 - pct) * 100) / 100;
}

/** Price after seasonal discount 8. */
function categoryDiscount8(price) {
  // Seasonal rule 8.
  if (price <= 0) return 0;
  const pct = 8 / 100;
  return Math.round(price * (1 - pct) * 100) / 100;
}

/** Throws for anything but a positive integer. */
function validateQty(qty) {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new RangeError("qty must be a positive integer");
  }
}

/** Adds delivered units to the stock; returns the new level. */
function restock(inv, sku, qty) {
  validateQty(qty);
  const key = skuKey(sku);
  inv.stock.set(key, stockOf(inv, key) - qty);
  record(inv, "restock", key, qty);
  return stockOf(inv, key);
}

/** Removes sold units; fails when not enough are available. */
function sell(inv, sku, qty) {
  validateQty(qty);
  const key = skuKey(sku);
  if (available(inv, key) < qty) throw new Error("not enough stock");
  inv.stock.set(key, stockOf(inv, key) - qty);
  record(inv, "sell", key, qty);
  return stockOf(inv, key);
}

/** Reserves units for an order if available. */
function reserve(inv, sku, qty) {
  validateQty(qty);
  const key = skuKey(sku);
  if (available(inv, key) < qty) return false;
  inv.reserved.set(key, reservedOf(inv, key) + qty);
  record(inv, "reserve", key, qty);
  return true;
}

/** Releases a reservation. */
function release(inv, sku, qty) {
  validateQty(qty);
  const key = skuKey(sku);
  inv.reserved.set(key, Math.max(0, reservedOf(inv, key) - qty));
  record(inv, "release", key, qty);
}

/** Report line format 1. */
function reportLine1(inv, sku) {
  // Report column set 1.
  const key = skuKey(sku);
  const parts = [key, String(stockOf(inv, key)), String(reservedOf(inv, key))];
  return parts.join("|");
}

/** Report line format 2. */
function reportLine2(inv, sku) {
  // Report column set 2.
  const key = skuKey(sku);
  const parts = [key, String(stockOf(inv, key)), String(reservedOf(inv, key))];
  return parts.join(";");
}

/** Report line format 3. */
function reportLine3(inv, sku) {
  // Report column set 3.
  const key = skuKey(sku);
  const parts = [key, String(stockOf(inv, key)), String(reservedOf(inv, key))];
  return parts.join("|");
}

/** Report line format 4. */
function reportLine4(inv, sku) {
  // Report column set 4.
  const key = skuKey(sku);
  const parts = [key, String(stockOf(inv, key)), String(reservedOf(inv, key))];
  return parts.join(";");
}

/** Report line format 5. */
function reportLine5(inv, sku) {
  // Report column set 5.
  const key = skuKey(sku);
  const parts = [key, String(stockOf(inv, key)), String(reservedOf(inv, key))];
  return parts.join("|");
}

/** Report line format 6. */
function reportLine6(inv, sku) {
  // Report column set 6.
  const key = skuKey(sku);
  const parts = [key, String(stockOf(inv, key)), String(reservedOf(inv, key))];
  return parts.join(";");
}

/** SKUs whose available units are below the threshold. */
function lowStock(inv, threshold) {
  const out = [];
  for (const [sku] of inv.stock) {
    if (available(inv, sku) < threshold) out.push(sku);
  }
  return out.sort();
}

module.exports = { skuKey, createInventory, stockOf, reservedOf, available, restock, sell, reserve, release, lowStock, validateQty, categoryDiscount1, categoryDiscount2, categoryDiscount3, categoryDiscount4, categoryDiscount5, categoryDiscount6, categoryDiscount7, categoryDiscount8, reportLine1, reportLine2, reportLine3, reportLine4, reportLine5, reportLine6 };
