function interest(amount, ratePercent) {
  // Round to cents.
  return Math.round(amount * ratePercent) / 100;
}

module.exports = { interest };
