const test = require("node:test");
const assert = require("node:assert");
const { computeTax } = require("../src/tax");
const { invoiceLines } = require("../src/invoice");
const { orderTotal } = require("../src/order");

test("computeTax is shared", () => {
  assert.strictEqual(computeTax(10), 1.2);
  assert.strictEqual(computeTax(0.99), 0.12);
  assert.deepStrictEqual(invoiceLines([100]), [{ net: 100, tax: 12, gross: 112 }]);
  assert.strictEqual(orderTotal([{ price: 5, qty: 1 }]), 5.6);
});
