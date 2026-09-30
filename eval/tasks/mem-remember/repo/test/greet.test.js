const test = require('node:test');
const assert = require('node:assert');
const { greet } = require('../src/greet');

test('greets', () => {
  assert.strictEqual(greet('Ann'), 'Hello, Ann');
});
