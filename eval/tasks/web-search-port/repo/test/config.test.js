const test = require("node:test");
const assert = require("node:assert");
const { brokerUrl } = require("../src/config");

test("builds a url", () => {
  assert.strictEqual(brokerUrl("mq", 1), "zephyr://mq:1");
});
