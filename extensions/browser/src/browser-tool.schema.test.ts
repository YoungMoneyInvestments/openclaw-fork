// Browser tests cover browser tool.schema plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { projectRuntimeToolInputSchema } from "openclaw/plugin-sdk/agent-harness-runtime";
import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { normalizeOpenAIToolSchemas } from "openclaw/plugin-sdk/provider-tools";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createBrowserToolSchema, resolveBrowserToolCapabilities } from "./browser-tool.schema.js";
import { ACT_MAX_VIEWPORT_DIMENSION } from "./browser/act-policy.js";

type SchemaRecord = Record<string, { maximum?: number; properties?: SchemaRecord }>;
type SchemaProperty = {
  description?: string;
  enum?: string[];
  maximum?: number;
  properties?: SchemaRecord;
};
type BrowserSchemaRecord = Record<string, SchemaProperty>;

function requireSchemaProperty<T>(properties: Record<string, T>, name: string, context: string): T {
  return expectDefined(properties[name], context);
}

describe("browser tool schema", () => {
  const BrowserToolSchema = createBrowserToolSchema(resolveBrowserToolCapabilities());
  it("advertises the viewport resize maximum on nested and flattened act params", () => {
    const properties = BrowserToolSchema.properties as SchemaRecord;
    const requestProperties =
      requireSchemaProperty(properties, "request", "browser request schema").properties ?? {};

    expect(requireSchemaProperty(properties, "width", "browser width schema").maximum).toBe(
      ACT_MAX_VIEWPORT_DIMENSION,
    );
    expect(requireSchemaProperty(properties, "height", "browser height schema").maximum).toBe(
      ACT_MAX_VIEWPORT_DIMENSION,
    );
    expect(
      requireSchemaProperty(requestProperties, "width", "browser request width schema").maximum,
    ).toBe(ACT_MAX_VIEWPORT_DIMENSION);
    expect(
      requireSchemaProperty(requestProperties, "height", "browser request height schema").maximum,
    ).toBe(ACT_MAX_VIEWPORT_DIMENSION);
  });

  it("describes targetId as a compatible tab reference", () => {
    const properties = BrowserToolSchema.properties as BrowserSchemaRecord;
    const targetId = requireSchemaProperty(properties, "targetId", "browser targetId schema");
    const requestProperties = requireSchemaProperty(properties, "request", "browser request schema")
      .properties as BrowserSchemaRecord;
    const requestTargetId = requireSchemaProperty(
      requestProperties,
      "targetId",
      "browser request targetId schema",
    );

    expect(targetId.description).toContain("Prefer suggestedTargetId");
    expect(targetId.description).toContain("raw CDP targetId");
    expect(requestTargetId.description).toBe(targetId.description);
  });

  it("describes canonical keyboard keys and aliases on nested and flattened act params", () => {
    const properties = BrowserToolSchema.properties as BrowserSchemaRecord;
    const requestProperties = requireSchemaProperty(properties, "request", "browser request schema")
      .properties as BrowserSchemaRecord;
    const key = requireSchemaProperty(properties, "key", "browser key schema");
    const requestKey = requireSchemaProperty(
      requestProperties,
      "key",
      "browser request key schema",
    );

    expect(key.description).toContain("Escape");
    expect(key.description).toContain("aliases Esc, Return, Del, Ctrl, Cmd");
    expect(key.description).toContain("Control+Shift+T");
    expect(requestKey.description).toBe(key.description);
  });

  it.each([false, true])(
    "preserves key guidance within the Codex schema budget (bound=%s)",
    (tabBound) => {
      const schema = createBrowserToolSchema(resolveBrowserToolCapabilities({ tabBound }));
      const properties = schema.properties as BrowserSchemaRecord;
      const key = requireSchemaProperty(properties, "key", "browser key schema");
      const normalized = normalizeOpenAIToolSchemas({
        provider: "openai",
        modelApi: "openai-chatgpt-responses",
        tools: [
          {
            name: "browser",
            label: "Browser",
            description: "Browser",
            parameters: schema,
            execute: async () => ({ content: [], details: {} }),
          },
        ],
      });
      const projection = projectRuntimeToolInputSchema(normalized[0]?.parameters);
      expect(projection.violations).toEqual([]);
      // Codex strips parameter descriptions above 5,000 bytes after schema normalization.
      expect(Buffer.byteLength(JSON.stringify(projection.schema))).toBeLessThanOrEqual(5_000);
      expect(projection.schema).toHaveProperty("properties.key.description", key.description);
      expect(projection.schema).toHaveProperty(
        "properties.request.properties.key.description",
        key.description,
      );
    },
  );

  it("exposes explicit download actions and their output path", () => {
    const properties = BrowserToolSchema.properties as BrowserSchemaRecord;

    expect(requireSchemaProperty(properties, "action", "browser action schema").enum).toEqual(
      expect.arrayContaining(["download", "waitfordownload"]),
    );
    expect(properties.path).toBeDefined();
  });

  it.each([false, true])("accepts the new action parameters (bound=%s)", (tabBound) => {
    const schema = createBrowserToolSchema(resolveBrowserToolCapabilities({ tabBound }));
    for (const args of [
      { action: "requests", targetId: "t1", filter: "fetch", clear: true, limit: 10 },
      { action: "errors", targetId: "t1", clear: true, limit: 10 },
      { action: "text", targetId: "t1", selector: "article", maxChars: 1000 },
      {
        action: "emulate",
        targetId: "t1",
        device: "iPhone 15",
        colorScheme: "none",
        timezoneId: "America/New_York",
        locale: "en-US",
      },
      { action: "snapshot", query: "sign in" },
    ]) {
      expect(Value.Check(schema, args), JSON.stringify(args)).toBe(true);
    }
    expect(Value.Check(schema, { action: "emulate", colorScheme: "invalid" })).toBe(false);
    expect(Value.Check(schema, { action: "requests", clear: "true" })).toBe(false);
    expect(Value.Check(schema, { action: "errors", clear: "true" })).toBe(false);
    expect(Value.Check(schema, { action: "errors", limit: 0 })).toBe(false);
  });

  it("hides Playwright-only actions for an existing-session binding", () => {
    const capabilities = resolveBrowserToolCapabilities({
      tabBound: true,
      profileCapabilities: {
        supportsBatchActions: false,
        supportsDownloads: false,
        supportsPdf: false,
        supportsRequests: false,
        supportsErrors: false,
        supportsPageText: false,
        supportsEmulation: false,
      },
    });
    for (const action of [
      "requests",
      "errors",
      "text",
      "emulate",
      "pdf",
      "download",
      "waitfordownload",
    ]) {
      expect(capabilities.actions).not.toContain(action);
    }
    expect(capabilities.actions).toContain("snapshot");
    expect(capabilities.actions).toContain("console");
  });

  it("exposes scrollIntoView on nested and flattened act params", () => {
    const properties = BrowserToolSchema.properties as BrowserSchemaRecord;
    const requestProperties = requireSchemaProperty(properties, "request", "browser request schema")
      .properties as BrowserSchemaRecord;

    expect(requireSchemaProperty(properties, "kind", "browser action kind schema").enum).toContain(
      "scrollIntoView",
    );
    expect(
      requireSchemaProperty(requestProperties, "kind", "browser request kind schema").enum,
    ).toContain("scrollIntoView");
  });

  it("exposes batch actions on nested and flattened act params", () => {
    const properties = BrowserToolSchema.properties as BrowserSchemaRecord;
    const requestProperties = requireSchemaProperty(properties, "request", "browser request schema")
      .properties as BrowserSchemaRecord;

    expect(requireSchemaProperty(properties, "kind", "browser action kind schema").enum).toContain(
      "batch",
    );
    expect(properties.actions).toBeDefined();
    expect(
      requireSchemaProperty(requestProperties, "kind", "browser request kind schema").enum,
    ).toContain("batch");
    expect(requestProperties.actions).toBeDefined();

    for (const name of ["kind", "actions", "stopOnError", "doubleClick", "ref"] as const) {
      const flattened = requireSchemaProperty(properties, name, `browser ${name} schema`);
      const nested = requireSchemaProperty(
        requestProperties,
        name,
        `browser request ${name} schema`,
      );

      expect(flattened.description, name).toBeTruthy();
      expect(nested.description, name).toBe(flattened.description);
    }

    expect(properties.actions?.description).toContain("batch");
    expect(properties.stopOnError?.description).toContain("default");
    expect(properties.doubleClick?.description).toContain("clickCoords");
    expect(properties.ref?.description).toContain("snapshot");
    expect(properties.profile?.description).toContain("default");
    expect(properties.labels?.description).toContain("snapshot");
    expect(properties.request?.description).toContain("act");
  });

  it("publishes the nested act request as partial so flattened repair stays reachable", () => {
    const schema = createBrowserToolSchema(resolveBrowserToolCapabilities());
    const properties = schema.properties as BrowserSchemaRecord;
    const request = requireSchemaProperty(properties, "request", "browser request schema") as {
      properties?: BrowserSchemaRecord;
      required?: string[];
    };
    const topLevelRequired = (schema as unknown as { required?: string[] }).required ?? [];

    // A partial `request` must survive tool-argument validation, because
    // readActRequestParam() repairs it from flattened top-level act fields.
    expect(request.required ?? []).not.toContain("kind");
    expect(topLevelRequired).not.toContain("kind");
    expect(topLevelRequired).toContain("action");
    expect(
      requireSchemaProperty(request.properties ?? {}, "kind", "browser request kind schema").enum,
    ).toContain("batch");
  });

  it("accepts both act payload shapes plus the partial request the runtime repairs", () => {
    const schema = createBrowserToolSchema(resolveBrowserToolCapabilities());
    const actions = [{ kind: "resize", width: 1024, height: 768 }];

    for (const args of [
      { action: "act", kind: "batch", actions },
      { action: "act", request: { kind: "batch", actions } },
      { action: "act", kind: "batch", actions, request: {} },
      { action: "act", kind: "click", ref: "e2", request: {} },
      { action: "act", request: { actions } },
    ]) {
      expect(Value.Check(schema, args), JSON.stringify(args)).toBe(true);
    }

    expect(Value.Check(schema, { action: "act", request: { kind: "nope" } })).toBe(false);
    expect(Value.Check(schema, { action: "act", kind: "nope", actions })).toBe(false);
  });

  it.each([
    { action: "act", kind: "batch", actions: [{ kind: "resize", width: 1024, height: 768 }] },
    {
      action: "act",
      request: { kind: "batch", actions: [{ kind: "resize", width: 1024, height: 768 }] },
    },
    {
      action: "act",
      kind: "batch",
      actions: [{ kind: "resize", width: 640, height: 480 }],
      request: {},
    },
  ])("passes tool-argument validation for %j", (args) => {
    const validated = validateToolArguments(
      {
        name: "browser",
        description: "Browser",
        parameters: createBrowserToolSchema(resolveBrowserToolCapabilities()),
      },
      { type: "toolCall", id: "call-1", name: "browser", arguments: args },
    );

    expect(validated).toMatchObject({ action: "act" });
  });

  it("preserves batch fields without advertising them on unsupported profiles", () => {
    const schema = createBrowserToolSchema(
      resolveBrowserToolCapabilities({
        profileCapabilities: {
          supportsBatchActions: false,
          supportsDownloads: false,
          supportsPdf: false,
        },
      }),
    );
    const properties = schema.properties as BrowserSchemaRecord;
    const requestProperties = requireSchemaProperty(properties, "request", "browser request schema")
      .properties as BrowserSchemaRecord;

    for (const scopedProperties of [properties, requestProperties]) {
      expect(scopedProperties.kind?.enum).not.toContain("batch");
      expect(scopedProperties.kind?.description).not.toContain("batch");
      expect(scopedProperties.actions).toBeDefined();
      expect(scopedProperties.stopOnError).toBeDefined();
      expect(scopedProperties.actions?.description).toBeUndefined();
      expect(scopedProperties.stopOnError?.description).toBeUndefined();
    }
  });
});
