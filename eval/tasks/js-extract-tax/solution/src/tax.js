function computeTax(amount) {
  return Math.round(amount * 0.12 * 100) / 100;
}

module.exports = { computeTax };
