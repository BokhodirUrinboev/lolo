const test = require("node:test");
const assert = require("node:assert");
const { orderTotal } = require("../src/order");

test("order total includes tax", () => {
  assert.strictEqual(orderTotal([{ price: 10, qty: 2 }]), 22.4);
});
