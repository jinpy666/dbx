// PR-A4/P2 global bottom dock (HOST_PLUGIN_UI_SPEC §8.3) — VS Code-style
// terminal panel: N docked terminal entries (local shells + SSH connection
// sessions of plugin-backed connections), switchable from the tab strip,
// alive across pages. Each entry owns a host-generated workbenchId (= entry
// id) that stays stable for the entry's lifetime, so switching tabs keeps
// sessions alive and reopening never leaks PTYs. The reuse key includes the
// presentation: dock (panel) instances and tab instances coexist.
import { ref } from "vue";
import { uuid } from "@/lib/common/utils";

export interface PluginDockEntry {
  /** 宿主生成的稳定实例 id，同时作为该条目 workbench 的 workbenchId。 */
  id: string;
  pluginId: string;
  workbenchContributionId: string;
  kind: "command" | "connection";
  /** 来源命令短 id（kind=command 时存在），供通用「+」重放。 */
  commandId?: string;
  title: string;
  icon?: string;
  /** 宿主权威 context：workbenchId=id、restored=false、surface="panel"。 */
  context: Record<string, unknown>;
}

const dockEntries = ref<PluginDockEntry[]>([]);
const activeEntryId = ref<string | null>(null);
const dockVisible = ref(false);
const dockMaximized = ref(false);

export interface AddPluginDockEntryPayload {
  pluginId: string;
  workbenchContributionId: string;
  kind: PluginDockEntry["kind"];
  commandId?: string;
  title: string;
  icon?: string;
  commandContext?: Record<string, unknown>;
}

/** Creates (and activates) a dock terminal entry; returns its stable id. */
export function addPluginDockEntry(payload: AddPluginDockEntryPayload): string {
  const id = uuid();
  dockEntries.value.push({
    id,
    pluginId: payload.pluginId,
    workbenchContributionId: payload.workbenchContributionId,
    kind: payload.kind,
    commandId: payload.commandId,
    title: payload.title,
    icon: payload.icon,
    context: {
      ...(payload.commandContext ?? {}),
      workbenchId: id,
      restored: false,
      surface: "panel",
    },
  });
  activeEntryId.value = id;
  dockVisible.value = true;
  return id;
}

export function activatePluginDockEntry(id: string): void {
  if (dockEntries.value.some((entry) => entry.id === id)) {
    activeEntryId.value = id;
    dockVisible.value = true;
  }
}

/** Removes one terminal entry (its scope is reclaimed with the host bridge teardown). */
export function closePluginDockEntry(id: string): void {
  const index = dockEntries.value.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  dockEntries.value.splice(index, 1);
  if (activeEntryId.value === id) {
    const neighbor = dockEntries.value[index - 1] ?? dockEntries.value[index] ?? null;
    activeEntryId.value = neighbor?.id ?? null;
  }
  if (!dockEntries.value.length) dockVisible.value = false;
}

/** Hides/shows the panel without killing the terminal sessions. */
export function setDockVisible(visible: boolean): void {
  if (visible && !dockEntries.value.length) return;
  dockVisible.value = visible;
}

export function setDockMaximized(maximized: boolean): void {
  dockMaximized.value = maximized;
}

export function usePluginBottomDock() {
  return { entries: dockEntries, activeEntryId, visible: dockVisible, maximized: dockMaximized };
}
