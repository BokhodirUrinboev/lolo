const SYMBOLS = { USD: "$", EUR: "€" };

function formatPrice(cents, currency = "USD") {
  return SYMBOLS[currency] + (cents / 100).toFixed(2);
}

module.exports = { formatPrice };
