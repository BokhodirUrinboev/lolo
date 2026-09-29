const { formatPrice } = require("./format");

function euPriceTag(product) {
  return `${product.name} ${formatPrice(product.cents, "EUR")}`;
}

module.exports = { euPriceTag };
