const test = require("node:test");
const assert = require("node:assert");
const inv = require("../src/inventory");

test("reserve respects availability", () => {
  const i = inv.createInventory();
  i.stock.set("A1", 3);
  assert.strictEqual(inv.reserve(i, "a1", 2), true);
  assert.strictEqual(inv.available(i, "A1"), 1);
  assert.strictEqual(inv.reserve(i, "A1", 2), false);
});
