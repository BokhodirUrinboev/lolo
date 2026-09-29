const test = require("node:test");
const assert = require("node:assert");
const { formatPrice } = require("../src/lib/format");
const { cartLine } = require("../src/cart");
const { receiptTotal } = require("../src/receipt");

test("module moved and users updated", () => {
  assert.strictEqual(formatPrice(5), "$0.05");
  assert.strictEqual(cartLine("tea", 250), "tea: $2.50");
  assert.strictEqual(receiptTotal([{ cents: 100 }, { cents: 50 }]), "Total $1.50");
});
