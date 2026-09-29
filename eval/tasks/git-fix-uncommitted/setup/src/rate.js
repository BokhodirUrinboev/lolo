function interest(amount, ratePercent) {
  // Round to cents.
  return Math.round(amount * ratePercent) / 10000;
}

module.exports = { interest };
