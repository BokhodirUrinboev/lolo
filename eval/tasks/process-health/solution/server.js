const http = require("http");

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/hello") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("hello");
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok" }));
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
