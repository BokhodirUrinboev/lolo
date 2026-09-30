const test = require("node:test");
const assert = require("node:assert");
const { priceWithVat } = require("../src/vat");

test("15% VAT, rounded to cents", () => {
  assert.strictEqual(priceWithVat(100), 115);
  assert.strictEqual(priceWithVat(9.99), 11.49);
});
