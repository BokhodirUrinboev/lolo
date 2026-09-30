const { ShoppingCart } = require("./cart");

function quickCart(owner, prices) {
  const cart = new ShoppingCart(owner);
  prices.forEach((p, i) => cart.add(`sku-${i}`, p));
  return cart;
}

function describe(cart) {
  if (!(cart instanceof ShoppingCart)) throw new TypeError("not a cart");
  return `${cart.owner}: ${cart.items.length} items, ${cart.total()}`;
}

module.exports = { quickCart, describe };
