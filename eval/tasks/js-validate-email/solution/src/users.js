let nextId = 1;

function createUser(name, email) {
  if (!name || !name.trim()) throw new Error("name required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid email");
  return { id: nextId++, name: name.trim(), email: email.toLowerCase() };
}

module.exports = { createUser };
