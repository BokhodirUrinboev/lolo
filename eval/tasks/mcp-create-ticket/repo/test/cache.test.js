const test = require("node:test");
const assert = require("node:assert");
const { Cache } = require("../src/cache");

test("stores values", () => {
  const c = new Cache();
  c.set("a", 1, 1000);
  assert.strictEqual(c.get("a"), 1);
});
