const test = require("node:test");
const assert = require("node:assert");
const { Stack } = require("../src/stack");

test("last in, first out", () => {
  const s = new Stack();
  s.push(1);
  s.push(2);
  s.push(3);
  assert.strictEqual(s.pop(), 3);
  assert.strictEqual(s.peek(), 2);
  assert.strictEqual(s.size, 2);
});
