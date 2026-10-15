import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../../fixtures/artifactInventory.js";
import { readJavaScriptArtifactFiles } from "../../../support/javascriptApplicationScope.js";
import { createJavaScriptArtifactReader } from "../../../../src/artifacts/javascript/JavaScriptArtifactReader.js";
import { analyzeJavaScriptArtifactFiles } from "../../../../src/application/javascript/JavaScriptArtifactAnalysis.js";
import { buildJavaScriptArtifactGraph } from "../../../../src/application/javascript/JavaScriptArtifactGraphBuilder.js";

it("projects a qualified global socket with its source evidence and excludes a local lookalike", async () => {
  const root = await createTestTempDirectory("rea-js-qualified-socket-");
  await writeFile(
    join(root, "app.js"),
    [
      'function local(window) { new window.WebSocket("wss://example.test/local"); }',
      'new globalThis.WebSocket("wss://example.test/socket");',
    ].join("\n"),
  );
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const analysis = analyzeJavaScriptArtifactFiles(files);
    const graph = buildJavaScriptArtifactGraph(snapshot, files, analysis);
    const endpoints = graph.nodes.filter(({ kind }) => kind === "endpoint");
    expect(endpoints).toHaveLength(1);
    const observation = endpoints[0]?.observations[0];
    expect(observation?.properties).toMatchObject({
      value: "wss://example.test/socket",
      mechanism: "call:globalThis.WebSocket",
    });
    expect(observation?.evidence).toMatchObject({
      authority: "ast-static-analysis",
      state: "observed",
      confidence: "exact",
      location: {
        available: true,
        value: {
          kind: "source-range",
          source: "app.js",
          start: { line: 2, column: 0 },
        },
      },
    });
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("retains constructor captures, ws imports and template keys with their graph source ranges", async () => {
  const root = await createTestTempDirectory("rea-js-bound-socket-");
  await writeFile(
    join(root, "app.js"),
    [
      'import Socket from "ws";',
      "const Captured = globalThis.WebSocket;",
      'new Socket("wss://example.test/imported");',
      'new Captured("wss://example.test/captured");',
      'new globalThis[`WebSocket`]("wss://example.test/template");',
      'const CommonJs = require("ws");',
      'new CommonJs("wss://example.test/commonjs");',
      "const { WebSocket: Projected } = globalThis;",
      'new Projected("wss://example.test/projected");',
      "function connect() {",
      'new Deferred("wss://example.test/deferred");',
      "}",
      "const Deferred = globalThis.WebSocket;",
      "connect();",
    ].join("\n"),
  );
  await writeFile(
    join(root, "import-equals.ts"),
    'import Socket = require("ws");\nnew Socket("wss://example.test/import-equals");',
  );
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const analysis = analyzeJavaScriptArtifactFiles(files);
    const graph = buildJavaScriptArtifactGraph(snapshot, files, analysis);
    const endpoints = graph.nodes.filter(({ kind }) => kind === "endpoint");
    expect(endpoints).toHaveLength(7);
    for (const [path, constructor, line, source] of [
      ["imported", "Socket", 3, "app.js"],
      ["captured", "Captured", 4, "app.js"],
      ["template", "globalThis.WebSocket", 5, "app.js"],
      ["commonjs", "CommonJs", 7, "app.js"],
      ["projected", "Projected", 9, "app.js"],
      ["deferred", "Deferred", 11, "app.js"],
      ["import-equals", "Socket", 2, "import-equals.ts"],
    ] as const) {
      const observation = endpoints.find(({ observations }) =>
        observations.some(
          ({ properties }) => properties.value === `wss://example.test/${path}`,
        ),
      )?.observations[0];
      expect(observation?.properties).toMatchObject({
        value: `wss://example.test/${path}`,
        mechanism: `call:${constructor}`,
      });
      expect(observation?.evidence).toMatchObject({
        authority: "ast-static-analysis",
        state: "observed",
        confidence: "exact",
        location: {
          available: true,
          value: {
            kind: "source-range",
            source,
            start: { line, column: 0 },
          },
        },
      });
    }
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps ambiguous endpoint candidates inferred through artifact graph projection", async () => {
  const root = await createTestTempDirectory("rea-js-endpoint-certainty-");
  await writeFile(join(root, "app.js"), 'form.get("shared"); fetch("shared");');
  const snapshot = await scanCanonicalArtifactInventory(root, {});
  const reader = createJavaScriptArtifactReader(root, "directory");
  try {
    const files = await readJavaScriptArtifactFiles(reader, snapshot);
    const analysis = analyzeJavaScriptArtifactFiles(files);
    const graph = buildJavaScriptArtifactGraph(snapshot, files, analysis);
    const endpoints = graph.nodes.filter(({ kind }) => kind === "endpoint");
    const candidate = endpoints.find(({ observations }) =>
      observations.some(
        ({ properties }) => properties.interpretation === "candidate",
      ),
    );
    const observed = endpoints.find(({ observations }) =>
      observations.some(
        ({ properties }) =>
          properties.value === "shared" &&
          properties.interpretation === undefined,
      ),
    );

    expect(candidate).toBeDefined();
    expect(observed).toBeDefined();
    expect(candidate?.node_id).not.toBe(observed?.node_id);
    const candidateObservation = candidate?.observations[0];
    expect(candidateObservation?.properties).toMatchObject({
      value: "shared",
      interpretation: "candidate",
    });
    expect(candidateObservation?.evidence).toMatchObject({
      authority: "static-relationship-inference",
      state: "inferred",
      confidence: "low",
      location: {
        available: true,
        value: { kind: "source-range", source: "app.js" },
      },
    });
    expect(candidateObservation?.evidence.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining("only a candidate")]),
    );
    expect(observed?.observations[0]?.evidence).toMatchObject({
      authority: "ast-static-analysis",
      state: "observed",
      confidence: "exact",
    });
    const candidateEdge = graph.edges.find(
      ({ target_node_id }) => target_node_id === candidate?.node_id,
    );
    expect(candidateEdge?.properties.interpretation).toBe("candidate");
    expect(candidateEdge?.evidence).toMatchObject({
      state: "inferred",
      confidence: "low",
    });
    expect(candidateEdge?.evidence.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining("only a candidate")]),
    );
  } finally {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  }
});
