const test = require("node:test");
const assert = require("node:assert");
const { DEFAULT_PORT, brokerUrl } = require("../src/config");

test("default port from the docs", () => {
  assert.strictEqual(DEFAULT_PORT, 7443);
  assert.strictEqual(brokerUrl(), "zephyr://localhost:7443");
});
