import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

const tableSrc = read("source/shared/rpc/main.ts");
const table = {};
for (const m of tableSrc.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*\{\s*args:\s*"(none|object)"\s*\}/gm)) {
  table[m[1]] = m[2];
}
const tableKeys = Object.keys(table);

const edgeSrc = read("source/electron-main/main-edge.ts");
const handlers = new Set();
// literal handlers in createMainEdgeHandlers
const literalStart = edgeSrc.indexOf("const handlers: HandlerMap = {");
const literalEnd = edgeSrc.indexOf("\n  for (const name of [", literalStart);
const literalBlock = edgeSrc.slice(literalStart, literalEnd);
for (const m of literalBlock.matchAll(/^\s{4}([A-Za-z0-9_]+):\s/gm)) handlers.add(m[1]);
// unserved list
const unservedStart = edgeSrc.indexOf('for (const name of [');
const unservedEnd = edgeSrc.indexOf(']) handlers[name] = unserved;', unservedStart);
for (const m of edgeSrc.slice(unservedStart, unservedEnd).matchAll(/"([A-Za-z0-9_]+)"/g)) handlers.add(m[1]);

const preloadSrc = read("source/electron-preload/preload.ts");
const wrapped = new Set();
for (const m of preloadSrc.matchAll(/edge\(\s*"([A-Za-z0-9_]+)"/g)) wrapped.add(m[1]);

console.log("table size:", tableKeys.length);
console.log("handlers size:", handlers.size);
console.log("wrapped size:", wrapped.size);

const noHandler = tableKeys.filter((k) => !handlers.has(k));
const noWrap = tableKeys.filter((k) => !wrapped.has(k));
const extraHandler = [...handlers].filter((k) => !table[k]);
const extraWrap = [...wrapped].filter((k) => !table[k]);

console.log("\n=== TABLE WITHOUT HANDLER ===");
console.log(noHandler);
console.log("\n=== TABLE WITHOUT PRELOAD WRAPPER ===");
console.log(noWrap);
console.log("\n=== HANDLER NOT IN TABLE ===");
console.log(extraHandler);
console.log("\n=== WRAPPER NOT IN TABLE ===");
console.log(extraWrap);

// args consistency: table says none -> wrapper must call edge(name) with no object
console.log("\n=== args=none methods called WITH an object literal in preload ===");
for (const k of tableKeys) {
  if (table[k] !== "none") continue;
  const re = new RegExp(`edge\\(\\s*"${k}"\\s*,`);
  if (re.test(preloadSrc)) console.log("  ", k);
}

console.log("\n=== args=object methods called with NO payload in preload ===");
for (const k of tableKeys) {
  if (table[k] !== "object") continue;
  const re = new RegExp(`edge\\(\\s*"${k}"\\s*\\)`);
  if (re.test(preloadSrc)) console.log("  ", k);
}