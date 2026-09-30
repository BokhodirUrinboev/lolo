const test = require("node:test");
const assert = require("node:assert");
const { headers } = require("../src/client");

test("sends the key", () => {
  assert.strictEqual(headers("k1").Authorization, "Bearer k1");
});
