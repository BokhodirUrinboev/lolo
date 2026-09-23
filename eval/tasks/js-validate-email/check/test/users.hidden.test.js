const test = require("node:test");
const assert = require("node:assert");
const { createUser } = require("../src/users");

test("valid user", () => {
  const u = createUser(" Ann ", "Ann@Example.com");
  assert.strictEqual(u.name, "Ann");
  assert.strictEqual(u.email, "ann@example.com");
});
test("invalid email", () => {
  for (const e of ["", "ann", "ann@", "@x.io", "ann@x"]) assert.throws(() => createUser("Ann", e), /invalid email/, e);
});
test("empty name", () => {
  assert.throws(() => createUser("   ", "a@b.co"), /name required/);
});
