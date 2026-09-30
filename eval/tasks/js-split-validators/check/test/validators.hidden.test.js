const test = require("node:test");
const assert = require("node:assert");
const { validateEmail, validatePhone } = require("../src/validators");
const { createUser } = require("../src/users");
const { inviteAdmin } = require("../src/admin");

test("validators live in src/validators.js", () => {
  assert.strictEqual(validateEmail("a@b.co"), true);
  assert.strictEqual(validateEmail("a@b"), false);
  assert.strictEqual(validatePhone("+1 555 123 4567"), true);
  assert.strictEqual(validatePhone("12"), false);
  assert.throws(() => createUser("Ann", "a@b.co", "12"), /invalid phone/);
  assert.deepStrictEqual(inviteAdmin("x"), { ok: false, reason: "invalid email" });
});
