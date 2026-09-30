const test = require("node:test");
const assert = require("node:assert");
const { createUser } = require("../src/users");
const { inviteAdmin } = require("../src/admin");

test("creates users and invites admins", () => {
  assert.strictEqual(createUser("Ann", "ann@x.io").email, "ann@x.io");
  assert.throws(() => createUser("Ann", "nope"), /invalid email/);
  assert.deepStrictEqual(inviteAdmin("bo@x.io"), { ok: true, email: "bo@x.io" });
});
