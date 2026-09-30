const { validateEmail, validatePhone } = require("./validators");

let nextId = 1;

function createUser(name, email, phone) {
  if (!validateEmail(email)) throw new Error("invalid email");
  if (phone !== undefined && !validatePhone(phone)) throw new Error("invalid phone");
  return { id: nextId++, name, email, phone };
}

module.exports = { createUser };
