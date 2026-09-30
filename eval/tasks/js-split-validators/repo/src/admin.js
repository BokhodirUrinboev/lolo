const { validateEmail } = require("./users");

function inviteAdmin(email) {
  if (!validateEmail(email)) return { ok: false, reason: "invalid email" };
  return { ok: true, email };
}

module.exports = { inviteAdmin };
