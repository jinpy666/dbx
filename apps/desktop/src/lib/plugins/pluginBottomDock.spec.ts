// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type * as dockModule from "@/lib/plugins/pluginBottomDock";

async function loadModule(): Promise<typeof dockModule> {
  vi.resetModules();
  return await import("@/lib/plugins/pluginBottomDock");
}

describe("pluginBottomDock", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("numbers same-command entries beyond the highest live suffix, never duplicating after a close", async () => {
    const dock = await loadModule();
    const first = dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "local.terminal", title: "Local terminal" });
    const second = dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "local.terminal", title: "Local terminal" });
    dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "local.terminal", title: "Local terminal" });
    expect(dock.usePluginBottomDock().entries.value.map((entry) => entry.title)).toEqual(["Local terminal", "Local terminal 2", "Local terminal 3"]);

    // Close the middle entry, then open another: the new title must not
    // collide with the surviving "Local terminal 3".
    dock.closePluginDockEntry(second);
    const fourth = dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "local.terminal", title: "Local terminal" });
    expect(dock.usePluginBottomDock().entries.value.map((entry) => entry.title)).toEqual(["Local terminal", "Local terminal 3", "Local terminal 4"]);

    // Different commands number independently.
    dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "other.command", title: "Other" });
    const titles = dock.usePluginBottomDock().entries.value.map((entry) => entry.title);
    expect(titles[titles.length - 1]).toBe("Other");
    dock.closePluginDockEntry(first);
    dock.closePluginDockEntry(fourth);
  });

  it("keeps entries alive across hide/show and only clears the dock with its last entry", async () => {
    const dock = await loadModule();
    const state = dock.usePluginBottomDock();
    dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "local.terminal", title: "Local terminal" });
    expect(state.visible.value).toBe(true);

    dock.setDockVisible(false);
    expect(state.visible.value).toBe(false);
    expect(state.entries.value).toHaveLength(1);

    dock.setDockVisible(true);
    expect(state.visible.value).toBe(true);
    expect(state.entries.value).toHaveLength(1);

    dock.closePluginDockEntry(state.entries.value[0]!.id);
    expect(state.entries.value).toHaveLength(0);
    expect(state.visible.value).toBe(false);
    expect(state.activeEntryId.value).toBeNull();
  });

  it("activates a neighboring entry after closing the active one", async () => {
    const dock = await loadModule();
    const state = dock.usePluginBottomDock();
    const first = dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "local.terminal", title: "Local terminal" });
    const second = dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "local.terminal", title: "Local terminal" });
    expect(state.activeEntryId.value).toBe(second);

    dock.closePluginDockEntry(second);
    expect(state.activeEntryId.value).toBe(first);

    dock.closePluginDockEntry(first);
    expect(state.activeEntryId.value).toBeNull();
  });
});
