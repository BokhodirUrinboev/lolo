const test = require("node:test");
const assert = require("node:assert");
const { interest } = require("../src/rate");

test("5% of 200", () => {
  assert.strictEqual(interest(200, 5), 10);
});
