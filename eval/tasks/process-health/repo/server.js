const http = require("http");

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/hello") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("hello");
    }
    res.writeHead(404);
    res.end();
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3123;
  createServer().listen(port, () => console.log(`listening on http://localhost:${port}`));
}

module.exports = { createServer };
