function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePhone(phone) {
  return /^\+?[0-9 ]{7,15}$/.test(phone);
}

module.exports = { validateEmail, validatePhone };
