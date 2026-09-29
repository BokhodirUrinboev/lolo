async function loadAll(ids, load) {
  const results = [];
  ids.forEach(async (id) => {
    results.push(await load(id));
  });
  return results;
}

module.exports = { loadAll };
