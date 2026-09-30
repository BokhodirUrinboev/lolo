const test = require("node:test");
const assert = require("node:assert");
const { Queue } = require("../src/queue");

test("first in, first out", () => {
  const q = new Queue();
  q.enqueue(1);
  q.enqueue(2);
  assert.strictEqual(q.dequeue(), 1);
});
