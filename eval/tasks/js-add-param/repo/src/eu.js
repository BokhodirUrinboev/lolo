const { formatPrice } = require("./format");

function euPriceTag(product) {
  return `${product.name} ${formatPrice(product.cents)}`;
}

module.exports = { euPriceTag };
