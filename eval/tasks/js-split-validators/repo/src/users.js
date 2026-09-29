function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePhone(phone) {
  return /^\+?[0-9 ]{7,15}$/.test(phone);
}

let nextId = 1;

function createUser(name, email, phone) {
  if (!validateEmail(email)) throw new Error("invalid email");
  if (phone !== undefined && !validatePhone(phone)) throw new Error("invalid phone");
  return { id: nextId++, name, email, phone };
}

module.exports = { createUser, validateEmail, validatePhone };
