const format = require("./lib/format.js");

function receiptTotal(items) {
  return "Total " + format.formatPrice(items.reduce((s, i) => s + i.cents, 0));
}

module.exports = { receiptTotal };
