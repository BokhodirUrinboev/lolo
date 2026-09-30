const test = require("node:test");
const assert = require("node:assert");
const { formatPrice } = require("../src/lib/format");

test("formats cents", () => {
  assert.strictEqual(formatPrice(1999), "$19.99");
});
