const test = require("node:test");
const assert = require("node:assert");
const { formatPrice } = require("../src/format");
const { euPriceTag } = require("../src/eu");
const { usPriceTag } = require("../src/us");

test("currencies", () => {
  assert.strictEqual(formatPrice(1250, "EUR"), "€12.50");
  assert.strictEqual(formatPrice(1250, "USD"), "$12.50");
  assert.strictEqual(formatPrice(5), "$0.05");
  assert.strictEqual(euPriceTag({ name: "tea", cents: 300 }), "tea €3.00");
  assert.strictEqual(usPriceTag({ name: "tea", cents: 300 }), "tea $3.00");
});
