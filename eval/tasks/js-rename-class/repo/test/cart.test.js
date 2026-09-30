const test = require("node:test");
const assert = require("node:assert");
const { ShoppingCart } = require("../src/cart");
const { quickCart, describe } = require("../src/checkout");

test("carts", () => {
  assert.strictEqual(new ShoppingCart("ann").add("a", 2).add("b", 3).total(), 5);
  assert.strictEqual(describe(quickCart("bo", [1, 2])), "bo: 2 items, 3");
});
