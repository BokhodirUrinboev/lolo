const API_BASE = "https://api.paynest.example";
const API_VERSION = "2026-08-14";

function headers(key) {
  return { Authorization: `Bearer ${key}`, "Paynest-Version": API_VERSION };
}

module.exports = { API_BASE, API_VERSION, headers };
