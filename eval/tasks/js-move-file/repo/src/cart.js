const { formatPrice } = require("./utils/format");

function cartLine(name, cents) {
  return `${name}: ${formatPrice(cents)}`;
}

module.exports = { cartLine };
