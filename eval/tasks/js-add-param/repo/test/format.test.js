const test = require("node:test");
const assert = require("node:assert");
const { formatPrice } = require("../src/format");

test("dollars", () => {
  assert.strictEqual(formatPrice(1250), "$12.50");
});
