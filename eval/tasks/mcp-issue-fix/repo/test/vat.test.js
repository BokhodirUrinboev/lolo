const test = require("node:test");
const assert = require("node:assert");
const { priceWithVat } = require("../src/vat");

test("zero stays zero", () => {
  assert.strictEqual(priceWithVat(0), 0);
});
