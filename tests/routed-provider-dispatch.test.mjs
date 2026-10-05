import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

// The routed-provider dispatcher used to be covered only by source-text regexes in
// `publication-packaging.test.mjs`. Deleting the `custom` branch from
// `runRoutedProviderText` therefore sent every custom turn to OpenRouter while the
// suite stayed green. These tests execute the real product module with a stubbed
// `globalThis.fetch`, so a turn is judged by the request it actually sends.
//
// DB Bot Lite has one provider, DeepSeek. The list of retired hosts below is the point of
// this file: no turn, whatever `settings.json` says, may leave for any of them.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL_ID = "deepseek-flash";
const DEEPSEEK_API_KEY = "sk-deepseek-key-2222";

/** Hosts the app used before. A request to any of them is a defect, not a route. */
const RETIRED_HOSTS = [
  "https://openrouter.ai",
  "https://api.openai.com",
  "https://chatgpt.com",
  "https://auth.openai.com",
  "https://api.anthropic.com",
  "https://api2.cursor.sh",
];

const TOUCHED_ENV = [
  "SAND_DATA_ROOT",
  "SAND_USER_DATA_DIR",
  "DEEPSEEK_API_KEY",
  "SAND_DEEPSEEK_THINKING",
];

let providerSession;
let dataRoot;
const requests = [];
const savedEnv = new Map();
const realFetch = globalThis.fetch;

function chatCompletionStream(text, model = DEEPSEEK_MODEL_ID) {
  const encoder = new TextEncoder();
  const chunks = [
    `data: ${JSON.stringify({
      id: "chatcmpl-stub",
      created: 1,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-stub",
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function headerRecord(init) {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

/**
 * Writes a settings file that already went through every migration.
 *
 * The ids matter: without them the `deepseek-only` migration runs on the first read and
 * rewrites the endpoint to DeepSeek on its own, which would make every assertion below pass
 * whatever the endpoint validator did — a green test that proves nothing.
 */
async function writeSettings(settings) {
  await writeFile(
    path.join(dataRoot, "settings.json"),
    `${JSON.stringify({
      version: 1,
      settingsMigrations: ["downgrade-persisted-max-fast", "local-inference-provider", "deepseek-only"],
      ...settings,
    }, null, 2)}\n`,
    "utf8",
  );
}

before(async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-routed-provider-"));
  dataRoot = temporary;
  const output = path.join(temporary, "provider-session.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source", "host", "extensions", "inference", "provider-session.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  providerSession = await import(pathToFileURL(output).href);

  await writeSettings({ inferenceCustomEndpoint: { baseUrl: DEEPSEEK_BASE_URL, modelId: DEEPSEEK_MODEL_ID } });

  for (const name of TOUCHED_ENV) savedEnv.set(name, process.env[name]);
  // `getSandRootDir()` honours this absolute override, so the dispatch under test
  // reads the settings file written above instead of the real user profile.
  process.env.SAND_DATA_ROOT = dataRoot;
  delete process.env.SAND_USER_DATA_DIR;
  process.env.DEEPSEEK_API_KEY = DEEPSEEK_API_KEY;
  delete process.env.SAND_DEEPSEEK_THINKING;

  globalThis.fetch = async (input, init) => {
    requests.push({
      url: typeof input === "string" ? input : String(input?.url ?? input),
      method: init?.method ?? "GET",
      headers: headerRecord(init),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return chatCompletionStream("routed");
  };
});

after(async () => {
  globalThis.fetch = realFetch;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true });
});

function resetRequests() {
  requests.length = 0;
}

function onlyRequest() {
  assert.equal(requests.length, 1, `expected exactly one HTTP request, got ${requests.length}`);
  return requests[0];
}

function assertNoRetiredHostWasCalled() {
  for (const host of RETIRED_HOSTS) {
    assert.deepEqual(
      requests.filter((candidate) => candidate.url.startsWith(host)),
      [],
      `no request in a DeepSeek turn may reach ${host}`,
    );
  }
}

const USER_TURN = [{ role: "user", content: "hi" }];

test("every turn goes to the official DeepSeek API and to no other host", async () => {
  resetRequests();
  const text = await providerSession.runRoutedProviderText("deepseek", USER_TURN);
  assert.equal(text, "routed");

  const request = onlyRequest();
  assert.equal(request.url, `${DEEPSEEK_BASE_URL}/chat/completions`, "the only route must be the DeepSeek chat completions endpoint");
  assertNoRetiredHostWasCalled();
});

test("the turn is signed with the DeepSeek key and asks for the DeepSeek model", async () => {
  resetRequests();
  await providerSession.runRoutedProviderText("deepseek", USER_TURN);

  const request = onlyRequest();
  assert.equal(request.method, "POST");
  assert.equal(request.headers.authorization, `Bearer ${DEEPSEEK_API_KEY}`);
  assert.equal(request.body.model, DEEPSEEK_MODEL_ID, "the model must be the one DeepSeek actually serves today");
});

test("the stored endpoint is read, so a retired host is rejected by the reader and not by the network", async () => {
  // First half: the settings file really is the source of the model. Without this the next
  // test could pass simply because nothing was ever read from disk.
  await writeSettings({ inferenceCustomEndpoint: { baseUrl: DEEPSEEK_BASE_URL, modelId: "deepseek-v4-pro" } });
  assert.equal(
    providerSession.createProviderPromptSession("deepseek").getModelId(),
    "deepseek-v4-pro",
    "the endpoint read from settings.json must reach the executor, or the rejection below is vacuous",
  );

  // Second half: exactly what an old installation leaves behind after the upgrade.
  await writeSettings({ inferenceCustomEndpoint: { baseUrl: "https://openrouter.ai/api/v1", modelId: "openrouter-model-777" } });
  try {
    resetRequests();
    await providerSession.runRoutedProviderText("deepseek", USER_TURN);

    const request = onlyRequest();
    assert.equal(request.url, `${DEEPSEEK_BASE_URL}/chat/completions`, "a non-DeepSeek endpoint must be rejected on read, not on send");
    assert.equal(request.body.model, DEEPSEEK_MODEL_ID, "the model of a rejected endpoint must not travel either");
    assertNoRetiredHostWasCalled();
  } finally {
    await writeSettings({ inferenceCustomEndpoint: { baseUrl: DEEPSEEK_BASE_URL, modelId: DEEPSEEK_MODEL_ID } });
  }
});

test("ProviderPromptExecutor.stream routes to DeepSeek as well", async () => {
  resetRequests();
  const session = providerSession.createProviderPromptSession("deepseek");
  assert.equal(session.getModelId(), DEEPSEEK_MODEL_ID);

  const executor = session.getExecutor();
  executor.appendMessages(USER_TURN);
  const result = executor.stream(undefined, "invocation-deepseek-1");

  let text = "";
  for await (const event of result.fullStream) {
    if (event.type === "text-delta") text += event.textDelta;
  }
  await result.response;
  assert.equal(text, "routed");

  const request = onlyRequest();
  assert.equal(request.url, `${DEEPSEEK_BASE_URL}/chat/completions`);
  assert.equal(request.headers.authorization, `Bearer ${DEEPSEEK_API_KEY}`);
  assert.equal(request.body.model, DEEPSEEK_MODEL_ID);
  assertNoRetiredHostWasCalled();
});

test("thinking mode is disabled by default and stated explicitly on the wire", async () => {
  // DeepSeek answers with reasoning content by default. The flag is injected by the fetch
  // wrapper, because `@ai-sdk/openai` has no setting for a field it does not know.
  resetRequests();
  await providerSession.runRoutedProviderText("deepseek", USER_TURN);
  assert.deepEqual(onlyRequest().body.thinking, { type: "disabled" }, "the request must say it does not want reasoning content");
});

test("SAND_DEEPSEEK_THINKING=1 turns the reasoning mode back on", async () => {
  process.env.SAND_DEEPSEEK_THINKING = "1";
  try {
    resetRequests();
    await providerSession.runRoutedProviderText("deepseek", USER_TURN);
    assert.deepEqual(onlyRequest().body.thinking, { type: "enabled" }, "the opt-in must reach the API, not just a local flag");
  } finally {
    delete process.env.SAND_DEEPSEEK_THINKING;
  }
});