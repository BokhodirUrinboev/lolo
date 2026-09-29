const { computeTax } = require("./tax");

function invoiceLines(amounts) {
  return amounts.map((a) => {
    const tax = computeTax(a);
    return { net: a, tax, gross: a + tax };
  });
}

module.exports = { invoiceLines };
