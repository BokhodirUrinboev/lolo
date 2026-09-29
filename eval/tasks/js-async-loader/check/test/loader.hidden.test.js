const test = require("node:test");
const assert = require("node:assert");
const { loadAll } = require("../src/loader");

test("waits and keeps order", async () => {
  const load = (id) => new Promise((r) => setTimeout(() => r(id * 10), (4 - id) * 15));
  assert.deepStrictEqual(await loadAll([1, 2, 3], load), [10, 20, 30]);
});
