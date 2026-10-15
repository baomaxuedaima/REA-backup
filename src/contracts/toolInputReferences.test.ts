import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  advertisedReferenceExpansionBudget,
  countLocalReferenceExpansions,
  inputSchemaWithinReferenceExpansionBudget,
  presentInputJsonSchema,
} from "./inputSchemaPresentation.js";
import { presentAdvertisedInputSchema } from "./compactInputSchema.js";
import { TOOL_CONTRACTS, toolContract } from "./toolContracts.js";
import {
  advertisedInputJsonSchema,
  toolInputSchemaWithMetadata,
  transformAdvertisedInputJsonSchema,
} from "./toolSchemaMetadata.js";
import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "./javascript/javascriptRuntimeReconciliationExample.js";

it.each(["draft-2020-12", "draft-07"] as const)(
  "honors projection options independently of cached wire transformations in %s",
  (target) => {
    const range = z.strictObject({ offset: z.number(), length: z.number() });
    const canonical = toolInputSchemaWithMetadata({
      ...toolContract("open_binary"),
      inputSchema: z.strictObject({ before: range, after: range }),
    });
    const transform = (schema: Record<string, unknown>) => ({
      ...schema,
      title: "Transformed range inputs",
    });
    const options = { target, libraryOptions: { reused: "inline" as const } };
    for (const inlineFirst of [false, true]) {
      const wrapped = transformAdvertisedInputJsonSchema(canonical, transform);
      const project = wrapped["~standard"].jsonSchema.input;
      if (inlineFirst) project(options);
      const shared = project({ target });
      expect(JSON.stringify(shared)).toContain('"$ref":');
      const inline = project(options);
      expect(inline).toEqual(
        transform(canonical["~standard"].jsonSchema.input(options)),
      );
      expect(JSON.stringify(inline)).not.toContain('"$ref":');
      expect(project({ target })).toBe(shared);
    }
  },
);

it.each(["draft-2020-12", "draft-07"] as const)(
  "preserves the complete inline Evidence contract before deferred authentication in %s",
  (target) => {
    const schema = toolInputSchemaWithMetadata(
      toolContract("inspect_analysis_view"),
    )["~standard"].jsonSchema.input({ target });
    const ajv =
      target === "draft-2020-12"
        ? new Ajv2020({ strict: false, validateFormats: false })
        : new Ajv({ strict: false, validateFormats: false });
    expect(ajv.validateSchema(schema)).toBe(true);
    const validate = ajv.compile(schema);
    const input = {
      source: {
        kind: "inline",
        evidence: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE,
      },
      view: { kind: "summary" },
    };
    expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({ ...input, source: { kind: "inline", evidence: {} } }),
    ).toBe(false);
    expect(validate({ ...input, source: { kind: "inline" } })).toBe(false);
  },
);

describe("advertised object dependencies", () => {
  it.each([
    ["draft-07", "dependencies"],
    ["draft-2020-12", "dependentRequired"],
  ] as const)(
    "presents object-group dependencies as guidance without unsupported dialect keywords (%s)",
    (dialect, dependencyKeyword) => {
      const advertised = presentInputJsonSchema(
        {
          $schema:
            dialect === "draft-07"
              ? "http://json-schema.org/draft-07/schema#"
              : "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { url: { type: "string" }, body: { type: "string" } },
          required: ["body"],
          [dependencyKeyword]: { body: ["url"] },
        },
        () => undefined,
      );
      expect(advertised.$schema).toBe(
        dialect === "draft-07"
          ? "http://json-schema.org/draft-07/schema#"
          : "https://json-schema.org/draft/2020-12/schema",
      );
      expect(advertised).not.toHaveProperty("dependencies");
      expect(advertised).not.toHaveProperty("dependentRequired");
      expect(advertised.description).toContain(
        "When body is provided, also provide url.",
      );
    },
  );
});

describe("advertised literal values", () => {
  // The same budget the compact profile registers (COMPACT_INPUT_SCHEMA_BUDGET_BYTES).
  const compactBudgetBytes = 13 * 1024;
  const nonStringLiteralPaths = (
    node: unknown,
    path: string,
    found: string[],
  ): string[] => {
    if (Array.isArray(node)) {
      node.forEach((child, index) =>
        nonStringLiteralPaths(child, `${path}[${index}]`, found),
      );
      return found;
    }
    if (typeof node !== "object" || node === null) return found;
    for (const [key, value] of Object.entries(node)) {
      const childPath = `${path}.${key}`;
      if (key === "const" && typeof value !== "string")
        found.push(`${childPath} = ${JSON.stringify(value)}`);
      else if (
        key === "enum" &&
        Array.isArray(value) &&
        value.some((member) => typeof member !== "string")
      )
        found.push(`${childPath} = ${JSON.stringify(value)}`);
      else if (!["examples", "default"].includes(key))
        nonStringLiteralPaths(value, childPath, found);
    }
    return found;
  };

  // Clients whose declaration renderer turns `const` into a one-member
  // `enum` meet Google function declarations that accept only string enum
  // members, so one boolean literal fails the whole catalog
  // (morluto/rea#4025). The canonical Zod schema still enforces the literal.
  it("advertises no non-string const or enum values in any profile", () => {
    const offending = TOOL_CONTRACTS.flatMap((contract) => {
      const full = advertisedInputJsonSchema(contract);
      const compact = presentAdvertisedInputSchema(full, {
        budgetBytes: compactBudgetBytes,
      });
      return [
        ...nonStringLiteralPaths(full, `${contract.name}(full)`, []),
        ...nonStringLiteralPaths(compact, `${contract.name}(compact)`, []),
      ];
    });
    expect(offending).toEqual([]);
  });

  it("presents boolean literals as typed booleans and keeps their defaults", () => {
    const schema = z.union([
      z.strictObject({
        target_id: z.string(),
        include_script_sources: z.literal(false).default(false),
      }),
      z.strictObject({
        target_id: z.string(),
        include_script_sources: z.literal(true),
      }),
    ]);
    const presented = presentInputJsonSchema(
      z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }),
      () => undefined,
    );
    expect(presented.properties).toMatchObject({
      target_id: { type: "string" },
      include_script_sources: { type: "boolean", default: false },
    });
    expect(presented).not.toHaveProperty([
      "properties",
      "include_script_sources",
      "anyOf",
    ]);
    expect(nonStringLiteralPaths(presented, "root", [])).toEqual([]);
    const validate = new Ajv2020({ strict: false }).compile(presented);
    for (const input of [
      { target_id: "page" },
      { target_id: "page", include_script_sources: true },
      { target_id: "page", include_script_sources: false },
    ]) {
      expect(schema.safeParse(input).success).toBe(true);
      expect(validate(input)).toBe(true);
    }
    expect(validate({ target_id: "page", include_script_sources: "yes" })).toBe(
      false,
    );
  });

  it("keeps a boolean literal that discriminates nested object alternatives", () => {
    const presented = presentInputJsonSchema(
      {
        type: "object",
        properties: {
          source: {
            oneOf: [
              {
                type: "object",
                properties: { included: { type: "boolean", const: false } },
                required: ["included"],
              },
              {
                type: "object",
                properties: {
                  included: { type: "boolean", const: true },
                  text: { type: "string" },
                },
                required: ["included", "text"],
              },
            ],
          },
        },
      },
      () => undefined,
    );
    expect(nonStringLiteralPaths(presented, "root", [])).toEqual([]);
    const source = (presented.properties as Record<string, unknown>).source;
    expect(source).toMatchObject({
      oneOf: [
        { properties: { included: { type: "boolean" } } },
        { properties: { included: { type: "boolean" }, text: {} } },
      ],
    });
  });
});

describe("advertised production selector contracts", () => {
  it.each(["draft-2020-12", "draft-07"] as const)(
    "preserves production native-selector constraints in %s",
    (target) => {
      const contract = toolContract("observe_native_calls");
      const advertised = toolInputSchemaWithMetadata(contract)[
        "~standard"
      ].jsonSchema.input({ target });
      const ajv =
        target === "draft-2020-12"
          ? new Ajv2020({ strict: false })
          : new Ajv({ strict: false });
      const validate = ajv.compile(advertised);
      for (const selector of [
        "setFoo:",
        "dataTaskWithRequest:completionHandler:",
        "",
        "bad selector:",
        "bad[selector]:",
        "set\0Foo:",
        "setFoo:\n",
      ]) {
        const sample = {
          breakpoints: [
            {
              kind: "objc-method",
              class_name: "NSURLSession",
              selector,
            },
          ],
        };
        expect(validate(sample)).toBe(
          contract.inputSchema.safeParse(sample).success,
        );
      }
      const unexpected = {
        breakpoints: [
          {
            kind: "objc-method",
            class_name: "NSURLSession",
            selector: "setFoo:",
            unexpected: true,
          },
        ],
      };
      expect(contract.inputSchema.safeParse(unexpected).success).toBe(false);
      expect(validate(unexpected)).toBe(false);
    },
  );
});

describe("advertised schema metadata and validation", () => {
  it.each(["draft-2020-12", "draft-07"] as const)(
    "retains specialized descriptions, literal metadata and strict validation in %s",
    (target) => {
      const literal = {
        properties: { target: { $ref: "literal caller data" } },
        examples: [{ properties: { path: {} } }],
      };
      const range = z
        .object({
          offset: z.number().int().nonnegative().max(65535),
          length: z.number().int().min(1),
        })
        .strict()
        .describe("Exact byte range in the selected artifact.");
      const canonical = z
        .object({
          before: range,
          after: range,
          metadata: z
            .record(z.string(), z.unknown())
            .meta({ default: literal, examples: [literal] }),
          constructor: z.string(),
        })
        .strict();
      const advertised = toolInputSchemaWithMetadata({
        ...toolContract("open_binary"),
        inputSchema: canonical,
      })["~standard"].jsonSchema.input({ target });
      const inline = toolInputSchemaWithMetadata({
        ...toolContract("open_binary"),
        inputSchema: canonical,
      })["~standard"].jsonSchema.input({
        target,
        libraryOptions: { reused: "inline" },
      });
      expect(inline).toMatchObject({
        properties: {
          before: { description: "Exact byte range in the selected artifact." },
          after: { description: "Exact byte range in the selected artifact." },
          metadata: { default: literal, examples: [literal] },
        },
      });
      // Inherited object keys never supply a description.
      expect(inline).not.toHaveProperty([
        "properties",
        "constructor",
        "description",
      ]);
      const ajv =
        target === "draft-2020-12"
          ? new Ajv2020({ strict: false })
          : new Ajv({ strict: false });
      const validate = ajv.compile(advertised);
      const valid = {
        before: { offset: 0, length: 1 },
        after: { offset: 65535, length: 2 },
        metadata: literal,
        constructor: "constructor data",
      };
      const samples = [
        valid,
        ...[
          { offset: -1 },
          { offset: 65536 },
          { offset: 0.5 },
          { length: 0 },
          { unexpected: true },
        ].map((change) => ({
          ...valid,
          before: { ...valid.before, ...change },
        })),
        { ...valid, after: null },
        { ...valid, unexpected: true },
      ];
      expect(canonical.safeParse(valid).success).toBe(true);
      for (const sample of samples)
        expect(validate(sample)).toBe(canonical.safeParse(sample).success);
    },
  );
});

describe("advertised reference expansion budget", () => {
  it("counts references in keyword-named fields, excluding literals", () => {
    const fields = ["default", "enum", "examples", "const", "$defs"];
    const schema = {
      type: "object",
      properties: Object.fromEntries(
        fields.map((name) => [name, { $ref: "#/$defs/value" }]),
      ),
      $defs: { value: { type: "string" } },
      default: { $ref: "#/$defs/value" },
      examples: [{ $ref: "#/$defs/value" }],
    };
    expect(countLocalReferenceExpansions(schema)).toBe(fields.length);
  });
  const reusedComponent = z
    .object({ kind: z.literal("rec"), value: z.string() })
    .strict();
  const inputWithReusedFields = (count: number) =>
    z.strictObject(
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `field_${String(index).padStart(2, "0")}`,
          reusedComponent,
        ]),
      ),
    );
  const advertisedInput = (
    canonical: z.ZodType<Readonly<Record<string, unknown>>>,
  ) =>
    toolInputSchemaWithMetadata({
      ...toolContract("open_binary"),
      inputSchema: canonical,
    })["~standard"].jsonSchema.input({ target: "draft-2020-12" });

  it("keeps shared definitions while every client can resolve them", () => {
    const advertised = advertisedInput(inputWithReusedFields(8));
    expect(advertised.$defs).toBeDefined();
    expect(countLocalReferenceExpansions(advertised)).toBe(8);
  });

  it("keeps shared definitions exactly at the budget", () => {
    const advertised = advertisedInput(
      inputWithReusedFields(advertisedReferenceExpansionBudget),
    );
    expect(advertised.$defs).toBeDefined();
    expect(countLocalReferenceExpansions(advertised)).toBe(
      advertisedReferenceExpansionBudget,
    );
  });

  it("re-projects without shared definitions once the budget is exceeded", () => {
    const advertised = advertisedInput(
      inputWithReusedFields(advertisedReferenceExpansionBudget + 1),
    );
    expect(advertised.$defs).toBeUndefined();
    expect(countLocalReferenceExpansions(advertised)).toBe(0);
    const properties = advertised.properties as Record<string, unknown>;
    expect(properties.field_00).toMatchObject({
      type: "object",
      properties: { kind: { const: "rec" }, value: { type: "string" } },
      required: ["kind", "value"],
    });
  });

  it("keeps the shared form untouched when it fits and swaps it when not", () => {
    const shared = {
      type: "object",
      properties: { value: { $ref: "#/$defs/shared" } },
      $defs: { shared: { type: "string" } },
    };
    const inlined = {
      type: "object",
      properties: { value: { type: "string" } },
    };
    expect(
      inputSchemaWithinReferenceExpansionBudget(
        shared,
        () => inlined,
        advertisedReferenceExpansionBudget,
      ),
    ).toBe(shared);
    expect(
      inputSchemaWithinReferenceExpansionBudget(
        {
          ...shared,
          properties: Object.fromEntries(
            Array.from({ length: 33 }, (_, index) => [
              `field_${index}`,
              { $ref: "#/$defs/shared" },
            ]),
          ),
        },
        () => inlined,
        advertisedReferenceExpansionBudget,
      ),
    ).toBe(inlined);
  });
});

describe("root input presentation", () => {
  it("preserves prototype-named properties in object-root presentation", () => {
    const fields = Object.fromEntries([
      ["__proto__", { type: "string" }],
      ["constructor", { type: "number" }],
    ]);
    const branch = {
      type: "object",
      properties: fields,
      required: ["__proto__"],
      additionalProperties: false,
    };
    const presented = presentInputJsonSchema(
      { anyOf: [branch, branch] },
      (property) => `Parameter ${property}`,
    );
    expect(presented).not.toHaveProperty("anyOf");
    expect(presented).toMatchObject({
      type: "object",
      required: ["__proto__"],
      additionalProperties: false,
    });
    const properties = presented.properties;
    if (typeof properties !== "object" || properties === null)
      throw new Error("Missing root properties");
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    expect(Object.hasOwn(properties, "__proto__")).toBe(true);
  });

  it.each(["draft-2020-12", "draft-07"] as const)(
    "advertises complete root groups while runtime keeps the exact union in %s",
    (target) => {
      const schema = z.union([
        z.strictObject({ before: z.string(), after: z.string() }),
        z.strictObject({
          before_scenario: z.number(),
          after_scenario: z.number(),
          normalization: z.boolean().optional(),
        }),
      ]);
      const canonical = z.toJSONSchema(schema, { io: "input", target });
      const advertised = presentInputJsonSchema(
        canonical,
        (property) => property,
      );
      // Anthropic tool input schemas reject anyOf, oneOf, and allOf at the root.
      for (const combinator of ["anyOf", "oneOf", "allOf"])
        expect(advertised).not.toHaveProperty(combinator);
      expect(advertised.description).toBe(
        "Provide a complete input group: before + after; before_scenario + after_scenario + [normalization].",
      );
      const ajv =
        target === "draft-2020-12"
          ? new Ajv2020({ strict: false })
          : new Ajv({ strict: false });
      const validate = ajv.compile(advertised);
      for (const input of [
        { before: "first", after: "second" },
        { before_scenario: 1, after_scenario: 2 },
        { before_scenario: 1, after_scenario: 2, normalization: true },
      ]) {
        expect(schema.safeParse(input).success).toBe(true);
        expect(validate(input)).toBe(true);
      }
      for (const input of [
        {},
        { before: "first" },
        { unexpected: true },
        { before_scenario: 1, after_scenario: "wrong" },
      ]) {
        expect(schema.safeParse(input).success).toBe(false);
        expect(validate(input)).toBe(false);
      }
      // The vendor-safe advertisement uses group guidance instead of
      // dependentRequired; the canonical runtime parser keeps exact unions.
      expect(
        schema.safeParse({ before_scenario: 1, normalization: true }).success,
      ).toBe(false);
      expect(validate({ before_scenario: 1, normalization: true })).toBe(true);
      expect(
        schema.safeParse({ after_scenario: 2, normalization: true }).success,
      ).toBe(false);
      expect(validate({ after_scenario: 2, normalization: true })).toBe(true);
      // Cross-group exclusion is enforced only by the canonical runtime parser.
      const mixed = {
        before: "first",
        after: "second",
        before_scenario: 1,
        after_scenario: 2,
      };
      expect(validate(mixed)).toBe(true);
      expect(schema.safeParse(mixed).success).toBe(false);
    },
  );

  it("keeps a root branch whose reference siblings cannot be merged", () => {
    const branch = { $ref: "#/$defs/object", additionalProperties: false };
    const root = {
      $defs: {
        object: { type: "object", properties: { value: { type: "string" } } },
      },
      anyOf: [branch],
    };
    const presented = presentInputJsonSchema(root, (property) => property);
    expect(presented.anyOf).toEqual([branch]);
    const ajv = new Ajv2020({ strict: false });
    for (const sample of [{}, { value: "value" }, { other: 1 }, null])
      expect(ajv.compile(presented)(sample)).toBe(ajv.compile(root)(sample));
  });

  it("preserves specialized guidance across reference chains without following literal references", () => {
    const literal = { properties: { literal: {} }, $ref: "#/$defs/missing" };
    const presented = presentInputJsonSchema(
      {
        $defs: {
          "a~b": {
            type: "string",
            description: "Literal URL selected by the caller.",
          },
          alias: { $ref: "#/$defs/a~0b" },
        },
        type: "object",
        properties: {
          url: { $ref: "#/$defs/alias" },
          other: { $ref: "#/$defs/alias", description: "Explicit override." },
        },
        default: literal,
        const: literal,
        examples: [literal],
        enum: [literal],
      },
      (property) => `Parameter ${property}`,
    );
    expect(presented).toMatchObject({
      properties: {
        url: { description: "Literal URL selected by the caller." },
        other: { description: "Explicit override." },
      },
      default: literal,
      const: literal,
      examples: [literal],
      enum: [literal],
    });
  });
});
