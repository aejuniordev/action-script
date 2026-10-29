import type { Context, HttpRequest, Workspace } from "@yaakapp/api";
import { describe, expect, test } from "vitest";
import { plugin } from "../src/index";

/** A context with an in-memory store, whose forms all return `reply`. */
function makeCtx(reply: unknown, initial: Record<string, unknown>) {
  const store = new Map(Object.entries(initial));
  const ctx = {
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string) => store.delete(key),
    },
    toast: { show: async () => {} },
    prompt: { form: async () => reply },
  } as unknown as Context;
  return { ctx, store };
}

const request = { id: "rq_1", workspaceId: "wk_1", name: "Users", url: "" } as HttpRequest;
const workspace = { id: "wk_1" } as Workspace;
const editScripts = plugin.httpRequestActions!.find((a) => a.label === "Edit Scripts")!;
const scriptVariables = plugin.workspaceActions!.find((a) => a.label === "Script Variables")!;

describe("Edit Scripts", () => {
  const saved = { pre: "PRE", post: "POST" };

  // Yaak leaves inputs that were never edited out of the form's values
  test.each([
    ["saving without edits keeps both", {}, saved],
    ["editing only post-response keeps pre-request", { post: "NEW" }, { pre: "PRE", post: "NEW" }],
    ["editing only pre-request keeps post-response", { pre: "NEW" }, { pre: "NEW", post: "POST" }],
    ["cancelling keeps both", null, saved],
    ["clearing both deletes them", { pre: "", post: "" }, undefined],
  ])("%s", async (_, reply, expected) => {
    const { ctx, store } = makeCtx(reply, { "script.rq_1": saved });
    await editScripts.onSelect(ctx, { httpRequest: request });
    expect(store.get("script.rq_1")).toEqual(expected);
  });
});

describe("Script Variables", () => {
  test("saving without edits keeps the variables", async () => {
    const { ctx, store } = makeCtx({}, { "vars.wk_1": { token: "abc" } });
    await scriptVariables.onSelect(ctx, { workspace });
    expect(store.get("vars.wk_1")).toEqual({ token: "abc" });
  });

  test("saves edited variables", async () => {
    const { ctx, store } = makeCtx({ vars: '{"a":1}' }, { "vars.wk_1": { token: "abc" } });
    await scriptVariables.onSelect(ctx, { workspace });
    expect(store.get("vars.wk_1")).toEqual({ a: 1 });
  });
});
