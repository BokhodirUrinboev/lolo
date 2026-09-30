async function loadAll(ids, load) {
  return Promise.all(ids.map((id) => load(id)));
}

module.exports = { loadAll };
