import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

/**
 * Web search reported "this may be temporary. Try again" on a host where it could never
 * succeed, and the model believed it. `WebSearch` and `WebFetch` are the only web tools the
 * product has, and both are served by a gRPC call into the Cursor backend. On a host with no
 * signed-in account -- the supported `inferenceProvider: "custom"` configuration -- the
 * credential lookup inside the connect interceptor throws `SandCredentialsWaitingError`
 * before any request is built. Connect wraps that throw as `[unknown]`, the code switch in
 * `maybeNormalizeExecBoundaryError` has no case for it and falls into `default:`, and the
 * model was handed "Tool failed; this may be temporary. Try again."
 *
 * Measured on the live box: four `WebSearch` calls and one `WebFetch`, five identical
 * failures, and then the agent told the user web search was broken. Nothing was transient,
 * nothing was wrong with the network -- `curl` reached the same host through the shell tool
 * moments later -- and no retry could ever have changed the answer. The provider's own text
 * made it worse by promising "renews this automatically ... this resolves on its own
 * shortly", the exact false reassurance `classifierFailureFromError` was written to strip on
 * the classifier path and which had no guard here.
 *
 * These tests drive the real service, so the fix is proved on the real failure and not on a
 * hand-built error object.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function bundle(entries) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-websearch-"));
  const names = [];
  for (const entry of entries) {
    const name = `${entry.at(-1).replace(/\.ts$/, "")}.mjs`;
    names.push([name, path.join(directory, name)]);
    await build({
      entryPoints: [path.join(repoRoot, "source", ...entry)],
      outfile: path.join(directory, name),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      // The Cursor backend client pulls undici, which is CommonJS and calls `require`
      // at runtime. Without this shim the bundle throws "Dynamic require of assert is not
      // supported" before a single line of product code runs.
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
      },
      logLevel: "silent",
    });
  }
  const loaded = {};
  for (const [name, file] of names) loaded[name] = await import(pathToFileURL(file).href);
  return { loaded, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

const { loaded, dispose } = await bundle([
  ["host", "extensions", "inference", "cursor-web-tools.ts"],
  ["host", "extensions", "auth", "auth-service.ts"],
  ["packages", "agent", "tools", "core", "connect-error.ts"],
]);
const { createCursorWebSearchService } = loaded["cursor-web-tools.mjs"];
const { SandCredentialsWaitingError, SAND_SHORTLIVED_CREDS_WAITING_MESSAGE } = loaded["auth-service.mjs"];
const { maybeNormalizeExecBoundaryError } = loaded["connect-error.mjs"];

test.after(() => dispose());

/** Exactly what `auth-service.getAccessToken` does on a host with no signed-in account. */
const accountlessGetAccessToken = async () => {
  throw new SandCredentialsWaitingError(SAND_SHORTLIVED_CREDS_WAITING_MESSAGE);
};

/**
 * Runs one search and returns what it raised.
 *
 * The factory itself throws here, not the call: the transport is built eagerly and there is
 * nothing to connect to. Both halves are the same failure to the model, so both are captured
 * here rather than leaving a thrown factory to fail the test on its own.
 */
async function attemptSearch(searchTerm) {
  try {
    const service = createCursorWebSearchService({
      getAccessToken: accountlessGetAccessToken,
      getMachineId: () => "test-machine-id",
      modelId: "test-model",
    });
    return await service(undefined, { searchTerm });
  } catch (error) {
    return error;
  }
}

// The web search and web fetch tools are the last callers of the Cursor backend, and that
// backend has no default URL any more: this build ships no remote endpoint, so with no
// `SAND_BACKEND_URL` set the call cannot even be attempted. The obligation is unchanged —
// the model has to learn the real cause and must not be invited to retry — but the cause is
// now the missing backend rather than a missing sign-in.
test("a web search on this build is reported as impossible, not as temporary", async () => {
  assert.equal(
    process.env.SAND_BACKEND_URL,
    undefined,
    "the guard must find no backend URL configured, or the service below is exercising a different path",
  );

  const raised = await attemptSearch("vlad mafaney twitch");

  assert.ok(
    raised instanceof Error,
    `the missing backend throws before the call leaves the process, so the caller sees an Error and not a hang: ${String(raised)}`,
  );

  const message = String(raised?.message ?? raised);
  assert.equal(
    message.includes("Try again"),
    false,
    "the model was told to retry a call that can never succeed, and it retried four times before reporting web search as broken",
  );
  assert.equal(
    /temporary|renews this automatically|resolves on its own/i.test(message),
    false,
    "nothing about a missing backend is temporary; the message must not invite a retry or promise a self-healing",
  );
  assert.match(
    message,
    /отключён|disabled/i,
    "the model has to learn the actual cause, or it will keep reaching for a tool that cannot work",
  );
  // The boundary classifier in `connect-error.ts` recognises a missing sign-in, not a missing
  // backend, so this error reaches the model unclassified rather than as a retryable
  // environment failure. The message above is what stops the loop; the classifier is the
  // improvement still owed by whoever owns that file.
  assert.equal(
    maybeNormalizeExecBoundaryError(raised)?.modelVisibleErrorMessage,
    undefined,
    "the classifier started recognising the disabled backend; this guard has to be updated and the change reported",
  );
});

test("the promise of automatic renewal never reaches the model or the user", async () => {
  const raised = await attemptSearch("anything");
  assert.ok(raised instanceof Error, `the search had to fail: ${String(raised)}`);
  const normalized = maybeNormalizeExecBoundaryError(raised);
  const message = normalized?.modelVisibleErrorMessage ?? String(raised?.message ?? raised);

  for (const [surface, text] of [
    ["model-visible", message],
    ["client-visible", normalized?.clientVisibleErrorMessage ?? message],
  ]) {
    assert.equal(
      /renews this automatically|resolves on its own/i.test(text),
      false,
      `the ${surface} message repeats a self-healing this host cannot deliver, which is the false reassurance the classifier path was fixed to remove`,
    );
    assert.equal(
      /temporary|Try again/i.test(text),
      false,
      `the ${surface} message still invites a retry of a call that cannot succeed, which is what produced the four identical attempts`,
    );
  }
});

test("a credential failure on a tool other than web search is reported the same way", async () => {
  const raised = new Error(`[unauthenticated] ${SAND_SHORTLIVED_CREDS_WAITING_MESSAGE}`);
  const normalized = maybeNormalizeExecBoundaryError(raised);

  assert.match(
    normalized.modelVisibleErrorMessage,
    /signed-in/i,
    "every Cursor-backed tool dies this way, so the correction belongs at the boundary and not inside the web search tool",
  );
});

test("an unrelated connect failure keeps its own classification", () => {
  const rateLimited = maybeNormalizeExecBoundaryError(
    new Error("[resource_exhausted] high load, rate limit exceeded"),
  );

  assert.equal(
    rateLimited.classification,
    "provider_error",
    "a genuinely temporary provider failure must still be classified as a provider error, or this fix would silence real retries",
  );
  assert.match(
    rateLimited.modelVisibleErrorMessage,
    /rate limited/i,
    "a real rate limit still has to read as a rate limit",
  );
});