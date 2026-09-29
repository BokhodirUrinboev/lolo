const { computeTotal } = require("./pricing");

function orderSummary(order) {
  return `${order.id}: ${computeTotal(order.lines)}`;
}

module.exports = { orderSummary };
