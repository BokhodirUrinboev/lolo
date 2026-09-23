let nextId = 1;

function createUser(name, email) {
  return { id: nextId++, name: name.trim(), email: email.toLowerCase() };
}

module.exports = { createUser };
