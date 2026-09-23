const test = require("node:test");
const assert = require("node:assert");
const { Cart } = require("../src/cart");

test("applyDiscount", () => {
  const c = new Cart();
  c.add("a", 10, 2);
  assert.strictEqual(c.applyDiscount(10), 18);
  assert.strictEqual(c.applyDiscount(0), 20);
  assert.strictEqual(c.total(), 20, "total() must not change");
});
