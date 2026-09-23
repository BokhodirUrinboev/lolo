const test = require("node:test");
const assert = require("node:assert");
const { computeTotal } = require("../src/pricing");
const { orderSummary } = require("../src/order");
const { invoiceTotal } = require("../src/invoice");

test("renamed and still working", () => {
  const lines = [{ price: 2, qty: 3 }, { price: 1, qty: 1 }];
  assert.strictEqual(computeTotal(lines), 7);
  assert.strictEqual(orderSummary({ id: "A1", lines }), "A1: 7");
  assert.strictEqual(invoiceTotal({ lines, taxRate: 0.1 }), 7.7);
});
