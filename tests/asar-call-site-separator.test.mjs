import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { parse } from "acorn";

import { fromArchiveEntry, toArchiveRelative } from "../scripts/lib/asar-paths.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

// Both trees are scanned: `scripts/**` is where the toolchain addresses archives,
// and `tests/**` builds real archives, so a POSIX spelling there is the same bug
// wearing a different hat.
const SCAN_ROOTS = ["scripts", "tests"];
const ARCHIVE_MODULE = "@electron/asar";
const HELPER_MODULE = /(^|[/\\])asar-paths\.mjs$/;

// The archive APIs that take a member path, and the argument position it sits in.
// `@electron/asar` addresses members with the platform separator: on Windows
// `extractFile` and `statFile` reject the POSIX spelling and throw
// `"..." was not found in this archive`.
const MEMBER_ADDRESSING = new Map([
  ["extractFile", 1],
  ["statFile", 1],
]);
// These take archive paths, filesystem destinations or no member at all. They
// are still located and counted so the guard cannot pass by failing to look.
const NOT_MEMBER_ADDRESSING = new Set([
  "extractAll",
  "listPackage",
  "createPackage",
  "createPackageWithOptions",
  "unpack",
]);

function listScripts(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name.endsWith(".mjs")) found.push(target);
    }
  };
  walk(root);
  return found;
}

// Generic ESTree walk that keeps the ancestor chain, so a call can be judged in
// context. `acorn-walk` is not a dependency and this only needs to reach every
// node, so a key-recursive descent is enough.
function walkAst(node, ancestors, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, ancestors, visit);
    return;
  }
  if (node == null || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node, ancestors);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
    if (value == null || typeof value !== "object") continue;
    const next = typeof node.type === "string" ? [...ancestors, node] : ancestors;
    walkAst(value, next, visit);
  }
}

const calleeName = (node) => {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") return node.property.name;
  return null;
};

/** Every archive API name this guard knows how to judge. */
const KNOWN_ARCHIVE_APIS = new Set([...MEMBER_ADDRESSING.keys(), ...NOT_MEMBER_ADDRESSING]);

/**
 * Local bindings a file gets from `@electron/asar`, so a same-named local helper
 * cannot be mistaken for the archive API (and vice versa).
 *
 * Static imports, namespace imports and `await import(...)` destructuring are
 * all handled. Handling only the static form is exactly the kind of silent gap
 * this suite exists to close: a file that reaches the archive through a dynamic
 * import would otherwise be skipped whole, and nothing would report the skip.
 */
function archiveBindings(ast) {
  const bindings = new Map();
  let namespaced = false;

  // Top-level `const NAME = "literal"` values, so a module specifier written as a
  // constant still resolves. Without this, a dynamic import of a named constant
  // is invisible to the scan and the file is skipped whole.
  const constants = new Map();
  for (const statement of ast.body) {
    if (statement.type !== "VariableDeclaration" || statement.declarations.length !== 1) continue;
    const declarator = statement.declarations[0];
    if (declarator.id.type !== "Identifier" || declarator.init?.type !== "Literal") continue;
    if (typeof declarator.init.value === "string") constants.set(declarator.id.name, declarator.init.value);
  }
  const moduleSpecifier = (node) => {
    const source = node?.type === "AwaitExpression" ? node.argument : node;
    if (source?.type !== "ImportExpression") return null;
    const literal = source.source;
    if (literal.type === "Literal") return literal.value;
    if (literal.type === "Identifier") return constants.get(literal.name) ?? null;
    return null;
  };
  const unwrap = (expression) => {
    let node = expression;
    while (node != null && (node.type === "AwaitExpression" || node.type === "TSAsExpression")) node = node.argument ?? node.expression;
    return node;
  };

  for (const statement of ast.body) {
    if (statement.type === "ImportDeclaration" && statement.source.value === ARCHIVE_MODULE) {
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportSpecifier") bindings.set(specifier.local.name, specifier.imported.name ?? specifier.imported.value);
        else namespaced = true;
      }
    }
  }
  // Dynamic imports can sit at any depth — this file uses one inside a test
  // callback — so the whole tree is searched rather than just the top level.
  walkAst(ast, [], (node) => {
    if (node.type !== "VariableDeclarator") return;
    if (moduleSpecifier(node.init) !== ARCHIVE_MODULE) return;
    if (node.id.type === "ObjectPattern") {
      for (const property of node.id.properties) {
        if (property.type === "RestElement") {
          namespaced = true;
          continue;
        }
        const imported = property.key?.name ?? property.value?.name;
        if (imported != null) bindings.set(property.value.name ?? imported, imported);
      }
    } else {
      namespaced = true;
    }
  });
  return { bindings, namespaced };
}

/** Local bindings of `toArchiveRelative`/`fromArchiveEntry`, including renames. */
function helperBindings(ast) {
  const bindings = new Map([
    ["toArchiveRelative", "toArchiveRelative"],
    ["fromArchiveEntry", "fromArchiveEntry"],
  ]);
  for (const statement of ast.body) {
    if (statement.type !== "ImportDeclaration" || !HELPER_MODULE.test(statement.source.value)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier") {
        bindings.set(specifier.local.name, specifier.imported.name ?? specifier.imported.value);
      }
    }
  }
  return bindings;
}

const hasSeparator = value => value.includes("/") || value.includes("\\");

// Assertion helpers whose callback is expected to throw. A member path inside
// one of these is a negative probe, not a production lookup.
const NEGATIVE_ASSERTIONS = new Set(["throws", "rejects"]);

/**
 * Decide whether one member-path argument is safe to hand to the archive API.
 *
 * `ok` means the spelling is separator-native by construction. Anything else is
 * reported with the reason it cannot be proven safe, so a new call site has to
 * make the routing explicit instead of inheriting it by accident.
 */
function classifyMemberArgument(node, helpers) {
  if (node == null) return { ok: false, reason: "no member path argument was passed" };
  if (node.type === "Literal" && typeof node.value === "string") {
    return hasSeparator(node.value)
      ? { ok: false, reason: `the literal ${JSON.stringify(node.value)} hard-codes a separator instead of routing through toArchiveRelative` }
      : { ok: true, reason: "single-segment member name" };
  }
  if (node.type === "TemplateLiteral") {
    if (node.expressions.length > 0) {
      return { ok: false, reason: "a template literal with substitutions is not routed through toArchiveRelative" };
    }
    const cooked = node.quasis.map(quasi => quasi.value.cooked ?? "").join("");
    return hasSeparator(cooked)
      ? { ok: false, reason: `the template literal ${JSON.stringify(cooked)} hard-codes a separator instead of routing through toArchiveRelative` }
      : { ok: true, reason: "single-segment member name" };
  }
  if (node.type === "CallExpression") {
    const name = calleeName(node.callee);
    const imported = name == null ? null : helpers.get(name);
    if (imported === "toArchiveRelative") return { ok: true, reason: "routed through toArchiveRelative" };
    if (imported === "fromArchiveEntry") {
      return { ok: false, reason: "fromArchiveEntry converts to forward slashes, which is the exact inverse of what this API requires" };
    }
    return { ok: false, reason: `the member path is produced by ${name ?? node.callee.type}(), which is not toArchiveRelative` };
  }
  return { ok: false, reason: `the member path is a bare ${node.type}, so its separator spelling is unproven` };
}

function inspectFile(file) {
  const source = readFileSync(file, "utf8");
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const { bindings, namespaced } = archiveBindings(ast);
  const helpers = helperBindings(ast);
  const relative = path.relative(repositoryRoot, file).split(path.sep).join("/");
  const findings = [];
  const sites = [];
  const negatives = [];
  const handed = [];

  walkAst(ast, [], (node, ancestors) => {
    if (node.type !== "CallExpression") return;
    const name = calleeName(node.callee);
    if (name == null) return;
    const api = bindings.get(name) ?? (namespaced && KNOWN_ARCHIVE_APIS.has(name) ? name : null);
    if (api == null) return;
    const position = node.loc.start.line;
    const site = { file: relative, line: position, api, snippet: source.split("\n")[position - 1].trim() };
    sites.push(site);
    const memberIndex = MEMBER_ADDRESSING.get(api);
    if (memberIndex == null) return;
    // A POSIX spelling inside `assert.throws(...)` is a deliberate negative
    // probe: the call is *supposed* to fail, and that is how the suite proves
    // the platform really rejects the spelling. Judged structurally, so the
    // exemption cannot be reached by naming a variable `expectedToThrow`.
    if (ancestors.some(ancestor =>
      ancestor.type === "CallExpression" && NEGATIVE_ASSERTIONS.has(calleeName(ancestor.callee)))) {
      negatives.push(site);
      return;
    }
    const verdict = classifyMemberArgument(node.arguments[memberIndex], helpers);
    if (verdict.ok) return;
    findings.push(`${relative}:${position} ${api}() receives a member path that is not separator-native — ${verdict.reason}\n    ${site.snippet}`);
  });

  // An archive API does not have to be CALLED here to be used: `package-windows-lite.mjs`
  // hands `listPackage` to `listArchiveFiles`, which calls it. Treating that import as dead
  // would make the anti-skip guard below fire on a live consumer, and treating it as
  // invisible would make the guard pass on a file the scan cannot actually judge. So the
  // reference is located, and it is judged by what it risks: an API that addresses a member
  // is a hole, because the call that carries the member path is somewhere this scan cannot
  // see; an API that takes an archive path carries no separator at all.
  walkAst(ast, [], (node) => {
    if (node.type !== "CallExpression") return;
    for (const argument of node.arguments) {
      if (argument?.type !== "Identifier") continue;
      const api = bindings.get(argument.name);
      if (api == null) continue;
      const position = node.loc.start.line;
      const where = { file: relative, line: position, api, snippet: source.split("\n")[position - 1].trim() };
      handed.push(where);
      if (MEMBER_ADDRESSING.has(api)) {
        findings.push(`${relative}:${position} ${api} is handed to ${calleeName(node.callee) ?? node.callee.type}() instead of being called here — a member-addressing call the scan cannot judge\n    ${where.snippet}`);
      }
    }
  });

  return {
    sites,
    handed,
    findings,
    negatives,
    touched: bindings.size > 0 || namespaced,
    // The member-addressing APIs this file imports. A file that imports one and yields no
    // judged site for it is a file the scan is blind to, which a single global counter
    // cannot tell apart from a tree that simply shrank.
    memberImports: [...new Set([...bindings.values()].filter((api) => MEMBER_ADDRESSING.has(api)))],
    file: relative,
  };
}

test("every archive API call site addresses members through the platform separator", () => {
  const files = SCAN_ROOTS
    .map(root => path.join(repositoryRoot, root))
    .flatMap(root => listScripts(root));
  assert.ok(files.length > 0, `no scripts were scanned under ${SCAN_ROOTS.join(", ")}`);

  const sites = [];
  const findings = [];
  const negatives = [];
  const importing = [];
  const unscanned = [];
  const handed = [];
  const blind = [];
  for (const file of files) {
    const inspected = inspectFile(file);
    sites.push(...inspected.sites, ...inspected.handed);
    findings.push(...inspected.findings);
    negatives.push(...inspected.negatives);
    handed.push(...inspected.handed);
    if (!inspected.touched) continue;
    importing.push(inspected.file);
    if (inspected.sites.length === 0 && inspected.handed.length === 0) unscanned.push(inspected.file);
    if (inspected.memberImports.length > 0 &&
      !inspected.sites.some((site) => MEMBER_ADDRESSING.has(site.api))) {
      blind.push(`${inspected.file} (imports ${inspected.memberImports.join(", ")})`);
    }
  }

  assert.deepEqual(
    findings,
    [],
    `Archive call sites must route their member path through toArchiveRelative (${sites.filter(s => MEMBER_ADDRESSING.has(s.api)).length} member-addressing call sites inspected, ${negatives.length} deliberate negative probes):\n  ${findings.join("\n  ")}`,
  );

  // The negative-probe exemption must stay tiny. If it ever starts covering a
  // production lookup, the count below is what notices.
  assert.ok(
    negatives.length <= 4,
    `expected only a handful of deliberate negative probes, found ${negatives.length}: ${negatives.map(s => `${s.file}:${s.line}`).join(", ")}`,
  );

  // Anti-skip guard. A file that imports `@electron/asar` but yields neither a call site
  // nor a reference the scan could judge means the scan is blind to that file — the same
  // silent hole that let the dynamic-import sites in this very suite go unexamined. Deriving
  // the expectation from the imports keeps it correct as files come and go.
  assert.deepEqual(
    unscanned,
    [],
    `these files import ${ARCHIVE_MODULE} but the scan found no call in them: ${unscanned.join(", ")}`,
  );
  // Handing an archive API to another function is legal only for one that takes no member
  // path, and that is what the findings assertion above says. What is left to pin here is
  // that the reference branch of the scan really ran: a scan that never located a hand-off
  // would report no finding for the same reason it reports none for a clean file.
  assert.ok(
    handed.length > 0,
    "the scan located no archive API handed to another function, so its reference branch is unexercised and `unscanned` above cannot fail for the right reason",
  );
  // A fixed count of consumer FILES is not a guard: it cannot tell a tree that
  // legitimately shrank from a scan that stopped looking, and this suite had
  // exactly that bug before (it used to demand "at least 17"). The seven
  // archive consumers it used to see became four when the fidelity packaging
  // scripts were deleted — a correct removal, not a regression.
  //
  // What actually proves the scan works is structural, and all three checks are
  // below and stay: `sites.length >= 20` fails if the parser stopped matching
  // call syntax, the `byApi` loop fails if it stopped seeing each API, and
  // `unscanned` fails if a file that imports the archive module yields nothing
  // the scan could judge. A fourth file can therefore never enter unexamined,
  // and the seventh can never leave silently — whatever the number of files is.
  assert.ok(sites.length >= 20, `expected the scan to find the repo's archive call sites, found ${sites.length}`);
  const byApi = new Map();
  for (const site of sites) byApi.set(site.api, (byApi.get(site.api) ?? 0) + 1);
  for (const api of ["extractFile", "extractAll", "statFile", "listPackage", "createPackage"]) {
    assert.ok(byApi.get(api) > 0, `the scan never saw a ${api}() call, so it is not looking at the right nodes`);
  }
  // Every file that imports a member-addressing API must contribute at least one judged
  // site. This replaces a fixed count: the count used to say "at least 17", which stopped
  // being true when scripts came and went, and a global counter cannot tell a tree that
  // shrank from a scan that stopped looking.
  assert.deepEqual(
    blind,
    [],
    `these files import an archive API that addresses a member, but no call site in them was judged:\n  ${blind.join("\n  ")}`,
  );
  assert.ok(
    sites.filter(s => MEMBER_ADDRESSING.has(s.api)).length > 0,
    "no member-addressing call site was judged anywhere, so the check above is measuring nothing",
  );
});

test("the helper really converts in the two opposite directions", () => {
  // On this host `toArchiveRelative` must produce whatever `path.sep` is, and
  // `fromArchiveEntry` must produce forward slashes from either spelling.
  assert.equal(toArchiveRelative("/dist/renderer/index.html"), ["dist", "renderer", "index.html"].join(path.sep));
  assert.equal(toArchiveRelative("dist/renderer/index.html"), ["dist", "renderer", "index.html"].join(path.sep));
  assert.equal(toArchiveRelative("dist\\renderer\\index.html"), ["dist", "renderer", "index.html"].join(path.sep));
  assert.equal(fromArchiveEntry(`\\dist\\renderer\\index.html`), "dist/renderer/index.html");
  assert.equal(fromArchiveEntry("/dist/renderer/index.html"), "dist/renderer/index.html");
  // The two helpers are not interchangeable: conflating them is the bug this
  // suite exists to prevent, so assert they disagree on a Windows spelling.
  if (path.sep === "\\") {
    assert.notEqual(toArchiveRelative("dist/renderer/index.html"), fromArchiveEntry("dist/renderer/index.html"));
  }
});

test("a POSIX-spelled member path is rejected while the routed spelling is accepted", async () => {
  // The syntactic guard above is only worth anything if the machine really does
  // reject the POSIX spelling, so prove that against a real archive.
  //
  // The probe needs three segments on purpose. `getFile` resolves a member as
  // `searchNodeFromDirectory(path.dirname(p))` plus `path.basename(p)`, and
  // win32 `dirname`/`basename` accept `/`. A two-segment POSIX path therefore
  // finds its top-level directory and succeeds *by accident*, and only a deeper
  // member fails. Every real call site addresses `dist/renderer/...`, so the
  // shallow case must not be what this suite proves.
  const { createPackage, extractFile } = await import(ARCHIVE_MODULE);
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const scratch = mkdtempSync(path.join(tmpdir(), "asar-guard-"));
  try {
    const stage = path.join(scratch, "stage");
    mkdirSync(path.join(stage, "dist", "renderer"), { recursive: true });
    writeFileSync(path.join(stage, "dist", "renderer", "probe.json"), "{}\n");
    writeFileSync(path.join(stage, "package.json"), '{"name":"probe"}\n');
    const archive = path.join(scratch, "app.asar");
    await createPackage(stage, archive);
    assert.equal(extractFile(archive, toArchiveRelative("dist/renderer/probe.json")).toString("utf8"), "{}\n");
    assert.throws(
      () => extractFile(archive, "dist/renderer/probe.json"),
      /was not found in (this )?archive|Cannot find/,
      "the POSIX spelling is expected to be rejected on this host; if it now works the guard rationale needs revisiting",
    );
    // A single-segment member carries no separator at all, so passing it
    // unconverted is genuinely legal on every host. That is the one exemption
    // the AST guard allows, and it is safe rather than merely tolerated.
    assert.equal(extractFile(archive, "package.json").toString("utf8"), '{"name":"probe"}\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});