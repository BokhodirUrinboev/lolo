const VAT_RATE = 0.15;

function priceWithVat(net) {
  return Math.round(net * (1 + VAT_RATE) * 100) / 100;
}

module.exports = { priceWithVat, VAT_RATE };
