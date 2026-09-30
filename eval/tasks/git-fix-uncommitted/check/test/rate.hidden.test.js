const test = require("node:test");
const assert = require("node:assert");
const { interest } = require("../src/rate");

test("interest rounded to cents", () => {
  assert.strictEqual(interest(200, 5), 10);
  assert.strictEqual(interest(10.555, 10), 1.06);
  assert.strictEqual(interest(0.1, 3), 0);
});
