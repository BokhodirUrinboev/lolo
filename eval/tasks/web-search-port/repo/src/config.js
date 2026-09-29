const BROKER_HOST = "localhost";
// Zephyr's default port (see its documentation).
const DEFAULT_PORT = 0;

function brokerUrl(host = BROKER_HOST, port = DEFAULT_PORT) {
  return `zephyr://${host}:${port}`;
}

module.exports = { BROKER_HOST, DEFAULT_PORT, brokerUrl };
