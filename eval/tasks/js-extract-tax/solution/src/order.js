const { computeTax } = require("./tax");

function orderTotal(items) {
  const net = items.reduce((s, i) => s + i.price * i.qty, 0);
  return net + computeTax(net);
}

module.exports = { orderTotal };
