const test = require("node:test");
const assert = require("node:assert");
const { loadAll } = require("../src/loader");

test("empty list", async () => {
  assert.deepStrictEqual(await loadAll([], async (x) => x), []);
});
