const { formatPrice } = require("./lib/format");

function cartLine(name, cents) {
  return `${name}: ${formatPrice(cents)}`;
}

module.exports = { cartLine };
