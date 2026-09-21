import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFrontendPluginRegistry } from "./frontendPlugin";
import { executePluginCommand } from "./pluginCommandRegistry";
import { closePluginBottomDock, usePluginBottomDock } from "./pluginBottomDock";
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
    closePluginBottomDock();
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
    expect(usePluginBottomDock().value).toBeNull();
  });

  it("opens the global bottom dock for panel presentations with a stable host workbenchId", () => {
    const registry = createFrontendPluginRegistry([
      installedPlugin("io.dbx.ssh", [
        { type: "workbench", id: "io.dbx.ssh.workbench", label: "SSH" },
        localTerminalCommand({ presentation: "panel", context: { plugin: { mode: "local-terminal" }, workbenchId: "plugin-forged", surface: "tab" } }),
      ] as unknown as InstalledPlugin["manifest"]["contributions"]),
    ]);
    const openPluginWorkbench = vi.fn();
    const first = executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ssh", "open-local-terminal");
    expect(first.error).toBeUndefined();
    const dock = usePluginBottomDock().value;
    expect(dock).not.toBeNull();
    expect(dock!.pluginId).toBe("io.dbx.ssh");
    expect(dock!.workbenchContributionId).toBe("io.dbx.ssh.workbench");
    expect(dock!.context.plugin).toEqual({ mode: "local-terminal" });
    // 插件伪造的保留字段被宿主权威值覆盖；Dock 会话期内 workbenchId 稳定。
    const firstWorkbenchId = dock!.context.workbenchId;
    expect(firstWorkbenchId).not.toBe("plugin-forged");
    expect(dock!.context.restored).toBe(false);
    expect(dock!.context.surface).toBe("panel");
    executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ssh", "open-local-terminal");
    expect(usePluginBottomDock().value!.context.workbenchId).toBe(firstWorkbenchId);
    expect(openPluginWorkbench).not.toHaveBeenCalled();
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

  it("finds the declared command targeting a workbench for entry routing", () => {
    const registry = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", [{ type: "workbench", id: "io.dbx.ssh.workbench", label: "SSH" }, localTerminalCommand()] as unknown as InstalledPlugin["manifest"]["contributions"])]);
    const command = registry.findCommandTargetingWorkbench("io.dbx.ssh", "io.dbx.ssh.workbench");
    expect(command?.id).toBe("open-local-terminal");
    expect(registry.findCommandTargetingWorkbench("io.dbx.ssh", "other.workbench")).toBeUndefined();
    expect(registry.findCommandTargetingWorkbench("other.plugin", "io.dbx.ssh.workbench")).toBeUndefined();
  });
});
