const fs = require("fs");
const path = process.argv[2];
const c = fs.readFileSync(path, "utf8");
const keywords = process.argv.slice(3);
for (const kw of keywords) {
  const count = c.split(kw).length - 1;
  console.log(kw, count);
}
