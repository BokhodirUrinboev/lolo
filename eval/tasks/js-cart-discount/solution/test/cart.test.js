const test = require("node:test");
const assert = require("node:assert");
const { Cart } = require("../src/cart");

test("total respects quantity", () => {
  const c = new Cart();
  c.add("apple", 2, 3);
  c.add("pear", 5);
  assert.strictEqual(c.total(), 11);
});

test("applyDiscount", () => {
  const c = new Cart();
  c.add("apple", 10);
  assert.strictEqual(c.applyDiscount(10), 9);
});
