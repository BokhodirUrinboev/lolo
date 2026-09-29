const test = require("node:test");
const assert = require("node:assert");
const { Queue } = require("../src/queue");

test("peek and size", () => {
  const q = new Queue();
  assert.strictEqual(q.peek(), undefined);
  assert.strictEqual(q.size, 0);
  q.enqueue("a");
  q.enqueue("b");
  assert.strictEqual(q.peek(), "a");
  assert.strictEqual(q.size, 2);
  q.dequeue();
  assert.strictEqual(q.peek(), "b");
});
