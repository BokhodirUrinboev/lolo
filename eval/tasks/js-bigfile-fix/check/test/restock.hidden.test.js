const test = require("node:test");
const assert = require("node:assert");
const inv = require("../src/inventory");

test("restock raises stock and logs", () => {
  const i = inv.createInventory();
  assert.strictEqual(inv.restock(i, "b2", 5), 5);
  assert.strictEqual(inv.restock(i, "B2", 3), 8);
  assert.strictEqual(inv.sell(i, "b2", 2), 6);
  assert.deepStrictEqual(i.log.map((e) => e.type), ["restock", "restock", "sell"]);
  assert.throws(() => inv.restock(i, "b2", 0), RangeError);
});
