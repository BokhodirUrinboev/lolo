const { calcTotal } = require("./pricing");

function orderSummary(order) {
  return `${order.id}: ${calcTotal(order.lines)}`;
}

module.exports = { orderSummary };
