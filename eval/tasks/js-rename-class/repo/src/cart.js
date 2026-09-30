class ShoppingCart {
  constructor(owner) {
    this.owner = owner;
    this.items = [];
  }

  add(sku, price) {
    this.items.push({ sku, price });
    return this;
  }

  total() {
    return this.items.reduce((s, i) => s + i.price, 0);
  }
}

module.exports = { ShoppingCart };
