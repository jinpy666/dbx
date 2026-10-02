import { describe, expect, it, vi } from "vitest";
import { createPluginAiCompletion, pluginAiModels, pluginAiPromptPreview } from "./pluginAiCompletion";
import type { AiConfigItem } from "@/types/ai";
const config = { id: "one", name: "My AI", provider: "openai", authMethod: "api-key", apiStyle: "completions", model: "a", models: [{ name: "b" }], apiKey: "secret", endpoint: "private", customHeaders: { token: "secret" }, isDefault: true } as AiConfigItem;
describe("plugin text completion", () => {
  it("only exposes whitelisted metadata and excludes CLI agents", () => {
    const models = pluginAiModels([config, { ...config, id: "cli", provider: "codex-cli" }]);
    expect(models).toEqual([
      { configId: "one", name: "My AI", model: "a", isDefault: true },
      { configId: "one", name: "My AI", model: "b", isDefault: false },
    ]);
    expect(JSON.stringify(models)).not.toContain("secret");
  });
  it("validates selected models and requires host consent", async () => {
    const complete = vi.fn();
    const confirm = vi.fn().mockResolvedValue(false);
    const api = createPluginAiCompletion({ load: async () => [config], complete, confirm });
    await expect(api.generateAiText("Plugin", { configId: "missing", model: "unknown", prompt: "hi" })).rejects.toThrow("no longer available");
    expect(confirm).not.toHaveBeenCalled();
    await expect(api.generateAiText("Plugin", { configId: "one", model: "b", prompt: "hi" })).rejects.toThrow("cancelled");
    expect(complete).not.toHaveBeenCalled();
  });
  it("resolves credentials only inside host and sanitizes provider errors", async () => {
    const complete = vi.fn().mockResolvedValue(" fix: example ");
    const api = createPluginAiCompletion({ load: async () => [config], complete, confirm: async () => true });
    expect(await api.generateAiText("Plugin", { configId: "one", model: "b", prompt: "hi" })).toBe("fix: example");
    expect(complete.mock.calls[0][0].config).toMatchObject({ model: "b", apiKey: "secret" });
    complete.mockRejectedValue(new Error("secret"));
    await expect(api.generateAiText("Plugin", { configId: "one", model: "b", prompt: "hi" })).rejects.toThrow("AI generation failed");
  });
  it("lists empty providers, discovers models and accepts manual IDs without changing defaults", async () => {
    const empty = { ...config, model: "", models: [] };
    const complete = vi.fn().mockResolvedValue("done");
    const discover = vi.fn().mockResolvedValue([{ id: "remote", apiKey: "secret" }]);
    const api = createPluginAiCompletion({ load: async () => [empty], discover, complete, confirm: async () => true });
    expect(await api.listAiProviders()).toEqual([{ configId: "one", name: "My AI" }]);
    expect(await api.discoverAiModels("one")).toEqual([{ configId: "one", name: "My AI", model: "remote", isDefault: false }]);
    await api.generateAiText("Plugin", { configId: "one", model: "manual", prompt: "hi" });
    expect(complete.mock.calls[0][0].config.model).toBe("manual");
    expect(empty.model).toBe("");
    discover.mockRejectedValue(new Error("secret endpoint"));
    await expect(api.discoverAiModels("one")).rejects.toThrow("Could not fetch models");
  });
  it("blocks concurrent requests and rejects empty or excessive results", async () => {
    let finish!: (s: string) => void;
    const complete = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const api = createPluginAiCompletion({ load: async () => [config], complete, confirm: async () => true });
    const input = { configId: "one", model: "a", prompt: "hi" };
    const first = api.generateAiText("Plugin", input);
    await expect(api.generateAiText("Plugin", input)).rejects.toThrow("already generating");
    await vi.waitFor(() => expect(complete).toHaveBeenCalled());
    finish("");
    await expect(first).rejects.toThrow("empty");
    complete.mockResolvedValue("x".repeat(16001));
    await expect(api.generateAiText("Plugin", input)).rejects.toThrow("16000");
  });
  it("previews the prompt first line and byte size in the consent surface", async () => {
    expect(pluginAiPromptPreview("SELECT 1;\nDROP TABLE users;")).toEqual({ firstLine: "SELECT 1;", bytes: new TextEncoder().encode("SELECT 1;\nDROP TABLE users;").byteLength });
    expect(pluginAiPromptPreview("x".repeat(500)).firstLine.length).toBe(200);
    const confirm = vi.fn().mockResolvedValue(true);
    const complete = vi.fn().mockResolvedValue("ok");
    const api = createPluginAiCompletion({ load: async () => [config], complete, confirm });
    await api.generateAiText("Plugin", { configId: "one", model: "a", prompt: "line one\nline two" });
    expect(confirm.mock.calls[0][2]).toMatchObject({ firstLine: "line one", bytes: 17 });
  });
  it("remembers a workbench-session allow with remember, never a denial", async () => {
    const complete = vi.fn().mockResolvedValue("ok");
    const confirm = vi.fn().mockResolvedValue({ allowed: true, remember: true });
    const api = createPluginAiCompletion({ load: async () => [config], complete, confirm });
    await api.generateAiText("Plugin", { configId: "one", model: "a", prompt: "first" });
    await api.generateAiText("Plugin", { configId: "one", model: "b", prompt: "second" });
    expect(confirm).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledTimes(2);
    // Plain booleans stay accepted and never arm the memory.
    const confirmPlain = vi.fn().mockResolvedValue(true);
    const apiPlain = createPluginAiCompletion({ load: async () => [config], complete, confirm: confirmPlain });
    await apiPlain.generateAiText("Plugin", { configId: "one", model: "a", prompt: "first" });
    await apiPlain.generateAiText("Plugin", { configId: "one", model: "a", prompt: "second" });
    expect(confirmPlain).toHaveBeenCalledTimes(2);
    // A remembered answer is scoped to its own completion instance (workbench).
    await expect(api.generateAiText("Plugin", { configId: "one", model: "a", prompt: "third" })).resolves.toBe("ok");
    expect(confirm).toHaveBeenCalledOnce();
    // Denials are never remembered: the next generation asks again.
    const confirmDeny = vi.fn().mockResolvedValue({ allowed: false, remember: true });
    const apiDeny = createPluginAiCompletion({ load: async () => [config], complete, confirm: confirmDeny });
    await expect(apiDeny.generateAiText("Plugin", { configId: "one", model: "a", prompt: "x" })).rejects.toThrow("cancelled");
    await expect(apiDeny.generateAiText("Plugin", { configId: "one", model: "a", prompt: "x" })).rejects.toThrow("cancelled");
    expect(confirmDeny).toHaveBeenCalledTimes(2);
  });
});
