// PR-A4/P2 global bottom dock (HOST_PLUGIN_UI_SPEC §8.3): one host-owned
// dock slot that hosts a plugin workbench as a floating bottom panel,
// available across every page. The dock keeps a STABLE workbenchId for its
// whole session so closing and reopening reattaches the same plugin scope
// (and the same local shell) instead of leaking PTYs — the reuse key
// includes the presentation, so tab and panel instances coexist.
import { ref } from "vue";
import { uuid } from "@/lib/common/utils";

export interface PluginBottomDockState {
  pluginId: string;
  workbenchContributionId: string;
  commandId: string;
  title: string;
  context: Record<string, unknown>;
}

const dockState = ref<PluginBottomDockState | null>(null);
// Dock 会话期内稳定的宿主权威 workbenchId：开关 Dock 复用同一 scope。
const dockWorkbenchId = uuid();

export function openPluginBottomDock(payload: { pluginId: string; workbenchContributionId: string; commandId: string; title: string; commandContext?: Record<string, unknown> }): void {
  dockState.value = {
    pluginId: payload.pluginId,
    workbenchContributionId: payload.workbenchContributionId,
    commandId: payload.commandId,
    title: payload.title,
    context: {
      ...(payload.commandContext ?? {}),
      workbenchId: dockWorkbenchId,
      restored: false,
      surface: "panel",
    },
  };
}

export function closePluginBottomDock(): void {
  dockState.value = null;
}

export function usePluginBottomDock() {
  return dockState;
}
