const test = require("node:test");
const assert = require("node:assert");
const { API_VERSION, headers } = require("../src/client");

test("latest API version", () => {
  assert.strictEqual(API_VERSION, "2026-08-14");
  assert.strictEqual(headers("k")["Paynest-Version"], "2026-08-14");
});
