const pricing = require("./pricing");

function invoiceTotal(invoice) {
  const net = pricing.calcTotal(invoice.lines);
  return Math.round(net * (1 + invoice.taxRate) * 100) / 100;
}

module.exports = { invoiceTotal };
