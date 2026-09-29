const VAT_RATE = 0.2;

function priceWithVat(net) {
  return net * (1 + VAT_RATE);
}

module.exports = { priceWithVat, VAT_RATE };
