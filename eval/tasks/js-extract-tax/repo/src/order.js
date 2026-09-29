function orderTotal(items) {
  const net = items.reduce((s, i) => s + i.price * i.qty, 0);
  const tax = Math.round(net * 0.12 * 100) / 100;
  return net + tax;
}

module.exports = { orderTotal };
