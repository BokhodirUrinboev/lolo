const test = require("node:test");
const assert = require("node:assert");
const { Stack } = require("../src/stack");

test("stack order and empty stack", () => {
  const s = new Stack();
  assert.strictEqual(s.pop(), undefined);
  assert.strictEqual(s.peek(), undefined);
  ["a", "b"].forEach((x) => s.push(x));
  assert.strictEqual(s.peek(), "b");
  assert.strictEqual(s.pop(), "b");
  assert.strictEqual(s.pop(), "a");
  assert.strictEqual(s.size, 0);
});
