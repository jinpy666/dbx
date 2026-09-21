import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFrontendPluginRegistry, evaluatePluginCommandConditions } from "./frontendPlugin";
import { executePluginCommand } from "./pluginCommandRegistry";
import { closePluginDockEntry, usePluginBottomDock } from "./pluginBottomDock";
import type { InstalledPlugin, PluginMenusContribution } from "@/types/database";

// PR-A4 command/menus 宿主侧（HOST_PLUGIN_UI_SPEC §4/§5/§8.3/§11）：命令注册
// 表从已安装插件的静态声明派生工具栏入口；执行时以宿主权威 context 打开——
// presentation: tab（缺省）开工作台 tab，panel 开全局底部 Dock；插件载荷在
// context.plugin，workbenchId/restored/surface 由宿主注入、永不采信插件值。
function installedPlugin(id: string, contributions: InstalledPlugin["manifest"]["contributions"] = []): InstalledPlugin {
  return {
    compatibility: { compatible: true },
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      drivers: [],
      contributions,
    },
  };
}

function localTerminalCommand(actionOverrides: Record<string, unknown> = {}) {
  return {
    type: "command",
    id: "open-local-terminal",
    label: "Local terminal",
    action: {
      type: "open-workbench",
      workbench: "io.dbx.ssh.workbench",
      reuse: "singleton",
      context: { plugin: { mode: "local-terminal" } },
      ...actionOverrides,
    },
  };
}

function menusContribution(items: PluginMenusContribution["items"]): PluginMenusContribution {
  return { type: "menus", id: "entrypoints", items };
}

describe("plugin command registry (PR-A4)", () => {
  beforeEach(() => {
    const { entries, visible } = usePluginBottomDock();
    entries.value.splice(0);
    visible.value = false;
  });

  it("derives visible appToolbar entries ordered by order then command id", () => {
    const registry = createFrontendPluginRegistry([
      installedPlugin("io.dbx.ssh", [
        { type: "workbench", id: "io.dbx.ssh.workbench", label: "SSH" },
        localTerminalCommand(),
        menusContribution([
          { location: "commandPalette", command: "open-local-terminal", group: "primary", order: 100 },
          { location: "appToolbar", command: "open-local-terminal", group: "navigation", order: 100, default_visible: true },
        ]),
      ] as unknown as InstalledPlugin["manifest"]["contributions"]),
    ]);
    const entries = registry.listToolbarMenuCommands();
    expect(entries).toHaveLength(1);
    expect(entries[0].plugin.manifest.id).toBe("io.dbx.ssh");
    expect(entries[0].command.id).toBe("open-local-terminal");

    // §5.2：工具栏项缺省隐藏——default_visible 非 true 一律不渲染。
    const hidden = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", [localTerminalCommand(), menusContribution([{ location: "appToolbar", command: "open-local-terminal", group: "navigation", order: 100 }])] as unknown as InstalledPlugin["manifest"]["contributions"])]);
    expect(hidden.listToolbarMenuCommands()).toHaveLength(0);
  });

  it("executes a tab command with a host-authored context and singleton reuse", () => {
    const registry = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", [{ type: "workbench", id: "io.dbx.ssh.workbench", label: "SSH" }, localTerminalCommand()] as unknown as InstalledPlugin["manifest"]["contributions"])]);
    const openPluginWorkbench = vi.fn();
    const result = executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ssh", "open-local-terminal");
    expect(result.error).toBeUndefined();
    expect(openPluginWorkbench).toHaveBeenCalledTimes(1);
    const [pluginId, workbenchId, options] = openPluginWorkbench.mock.calls[0];
    expect(pluginId).toBe("io.dbx.ssh");
    expect(workbenchId).toBe("io.dbx.ssh.workbench");
    expect(options.forceNew).toBe(false);
    // 插件载荷在 context.plugin；保留字段由宿主注入且覆盖插件伪造值。
    expect(options.context.plugin).toEqual({ mode: "local-terminal" });
    expect(typeof options.context.workbenchId).toBe("string");
    expect(options.context.restored).toBe(false);
    expect(options.context.surface).toBe("tab");
    expect(usePluginBottomDock().visible.value).toBe(false);
  });

  it("adds a dock terminal entry per panel execution with host-authored identity", () => {
    const registry = createFrontendPluginRegistry([
      installedPlugin("io.dbx.ssh", [
        { type: "workbench", id: "io.dbx.ssh.workbench", label: "SSH" },
        localTerminalCommand({ presentation: "panel", context: { plugin: { mode: "local-terminal" }, workbenchId: "plugin-forged", surface: "tab" } }),
      ] as unknown as InstalledPlugin["manifest"]["contributions"]),
    ]);
    const openPluginWorkbench = vi.fn();
    const { entries, activeEntryId, visible } = usePluginBottomDock();

    const first = executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ssh", "open-local-terminal");
    expect(first.error).toBeUndefined();
    expect(entries.value).toHaveLength(1);
    expect(visible.value).toBe(true);
    const firstEntry = entries.value[0];
    expect(firstEntry.pluginId).toBe("io.dbx.ssh");
    expect(firstEntry.workbenchContributionId).toBe("io.dbx.ssh.workbench");
    expect(firstEntry.context.plugin).toEqual({ mode: "local-terminal" });
    // 插件伪造的保留字段被宿主权威值覆盖；workbenchId = 条目 id 且稳定。
    expect(firstEntry.context.workbenchId).toBe(firstEntry.id);
    expect(firstEntry.context.workbenchId).not.toBe("plugin-forged");
    expect(firstEntry.context.restored).toBe(false);
    expect(firstEntry.context.surface).toBe("panel");
    expect(activeEntryId.value).toBe(firstEntry.id);

    // 再执行一次 → 新终端条目（VS Code + 语义），互不覆盖。
    executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ssh", "open-local-terminal");
    expect(entries.value).toHaveLength(2);
    expect(entries.value[1].id).not.toBe(firstEntry.id);
    expect(activeEntryId.value).toBe(entries.value[1].id);
    expect(openPluginWorkbench).not.toHaveBeenCalled();

    // 关闭条目回收 tab；全部关闭后面板隐藏。
    closePluginDockEntry(entries.value[1].id);
    closePluginDockEntry(entries.value[0].id);
    expect(visible.value).toBe(false);
  });

  it("drops plugin-forged reserved fields and honors reuse:new with forceNew", () => {
    const registry = createFrontendPluginRegistry([
      installedPlugin("io.dbx.ssh", [
        { type: "workbench", id: "io.dbx.ssh.workbench", label: "SSH" },
        localTerminalCommand({ reuse: "new", context: { plugin: { mode: "local-terminal" }, workbenchId: "plugin-forged", restored: true, surface: "panel" } }),
      ] as unknown as InstalledPlugin["manifest"]["contributions"]),
    ]);
    const openPluginWorkbench = vi.fn();
    const result = executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ssh", "open-local-terminal");
    expect(result.error).toBeUndefined();
    const [, , options] = openPluginWorkbench.mock.calls[0];
    expect(options.forceNew).toBe(true);
    expect(options.context.workbenchId).not.toBe("plugin-forged");
    expect(options.context.restored).toBe(false);
    expect(options.context.surface).toBe("tab");
  });

  it("reports unknown commands and dangling workbench references instead of opening a tab", () => {
    const registry = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", [localTerminalCommand({ workbench: "io.dbx.ssh.missing" })] as unknown as InstalledPlugin["manifest"]["contributions"])]);
    const openPluginWorkbench = vi.fn();
    expect(executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ssh", "missing-command").error).toBeTruthy();
    expect(executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ssh", "open-local-terminal").error).toContain("missing workbench");
    expect(openPluginWorkbench).not.toHaveBeenCalled();
  });

  it("evaluates §5.3 conditions (equals/notEquals/oneOf, missing key = false)", () => {
    expect(evaluatePluginCommandConditions([{ key: "surface", operator: "equals", value: "tab" }], { surface: "tab" })).toBe(true);
    expect(evaluatePluginCommandConditions([{ key: "surface", operator: "notEquals", value: "tab" }], { surface: "tab" })).toBe(false);
    expect(evaluatePluginCommandConditions([{ key: "connection.state", operator: "oneOf", value: ["connected", "reconnecting"] }], { "connection.state": "connected" })).toBe(true);
    // 空条件组缺省 true；缺失 key 一律 false（§5.3）。
    expect(evaluatePluginCommandConditions([], {})).toBe(true);
    expect(evaluatePluginCommandConditions([{ key: "object.type", operator: "equals", value: "table" }], {})).toBe(false);
    // all 内隐式 AND。
    expect(
      evaluatePluginCommandConditions(
        [
          { key: "surface", operator: "equals", value: "tab" },
          { key: "readOnly", operator: "equals", value: false },
        ],
        { surface: "tab", readOnly: false },
      ),
    ).toBe(true);
    expect(
      evaluatePluginCommandConditions(
        [
          { key: "surface", operator: "equals", value: "tab" },
          { key: "readOnly", operator: "equals", value: true },
        ],
        { surface: "tab", readOnly: false },
      ),
    ).toBe(false);
  });

  it("gates execution by enablement against the context snapshot", () => {
    const command = (enablement: unknown) =>
      [
        { type: "workbench", id: "io.dbx.ssh.workbench", label: "SSH" },
        localTerminalCommand(),
        { type: "command", id: "gated", label: "Gated", enablement, action: { type: "open-workbench", workbench: "io.dbx.ssh.workbench", context: { plugin: { mode: "local-terminal" } } } },
      ] as unknown as InstalledPlugin["manifest"]["contributions"];
    const openPluginWorkbench = vi.fn();

    const pass = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", command({ all: [{ key: "surface", operator: "equals", value: "tab" }] } as unknown as InstalledPlugin["manifest"]["contributions"]))]);
    expect(executePluginCommand(pass, { openPluginWorkbench: vi.fn() } as never, "io.dbx.ssh", "gated").error).toBeUndefined();

    const blocked = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", command({ all: [{ key: "surface", operator: "equals", value: "panel" }] } as unknown as InstalledPlugin["manifest"]["contributions"]))]);
    const result = executePluginCommand(blocked, { openPluginWorkbench } as never, "io.dbx.ssh", "gated");
    expect(result.error).toContain("disabled by enablement");
    expect(openPluginWorkbench).not.toHaveBeenCalled();
  });

  it("listToolbarMenuCommands applies when visibility against the placement surface", () => {
    const menus = (value: string) => menusContribution([{ location: "appToolbar", command: "open-local-terminal", group: "navigation", order: 100, default_visible: true, when: { all: [{ key: "surface", operator: "equals", value }] } }]);
    const show = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", [localTerminalCommand(), menus("appToolbar")] as unknown as InstalledPlugin["manifest"]["contributions"])]);
    expect(show.listToolbarMenuCommands()).toHaveLength(1);
    const hide = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", [localTerminalCommand(), menus("panel")] as unknown as InstalledPlugin["manifest"]["contributions"])]);
    expect(hide.listToolbarMenuCommands()).toHaveLength(0);
  });

  it("finds the declared command targeting a workbench for entry routing", () => {
    const registry = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", [{ type: "workbench", id: "io.dbx.ssh.workbench", label: "SSH" }, localTerminalCommand()] as unknown as InstalledPlugin["manifest"]["contributions"])]);
    const command = registry.findCommandTargetingWorkbench("io.dbx.ssh", "io.dbx.ssh.workbench");
    expect(command?.id).toBe("open-local-terminal");
    expect(registry.findCommandTargetingWorkbench("io.dbx.ssh", "other.workbench")).toBeUndefined();
    expect(registry.findCommandTargetingWorkbench("other.plugin", "io.dbx.ssh.workbench")).toBeUndefined();
  });
});
