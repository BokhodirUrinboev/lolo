function invoiceLines(amounts) {
  return amounts.map((a) => {
    const tax = Math.round(a * 0.12 * 100) / 100;
    return { net: a, tax, gross: a + tax };
  });
}

module.exports = { invoiceLines };
