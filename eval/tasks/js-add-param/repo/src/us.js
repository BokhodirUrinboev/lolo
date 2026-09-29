const { formatPrice } = require("./format");

function usPriceTag(product) {
  return `${product.name} ${formatPrice(product.cents)}`;
}

module.exports = { usPriceTag };
