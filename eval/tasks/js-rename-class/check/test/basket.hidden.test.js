const test = require("node:test");
const assert = require("node:assert");
const { Basket } = require("../src/cart");
const { quickCart, describe } = require("../src/checkout");

test("Basket", () => {
  assert.ok(quickCart("x", [4]) instanceof Basket);
  assert.strictEqual(describe(new Basket("cy").add("z", 7)), "cy: 1 items, 7");
  assert.throws(() => describe({}), /not a cart/);
});
