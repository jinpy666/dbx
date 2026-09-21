// PR-A4 command registry + appSidebar placements (HOST_PLUGIN_UI_SPEC §4/§5).
// The host keeps a static command registry per installed plugin and renders
// placements from declared `menus` data only — it never scans workbenches to
// invent entries. Executing a command re-resolves the workbench reference and
// opens the plugin workbench with a host-authored context: the plugin payload
// rides under `context.plugin`, while workbenchId/restored/surface are
// injected here and can never be supplied by the plugin (§11 ownership).
import { onScopeDispose, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/backend/api";
import { uuid } from "@/lib/common/utils";
import { addPluginDockEntry } from "@/lib/plugins/pluginBottomDock";
import { createFrontendPluginRegistry, type FrontendPluginRegistry } from "@/lib/plugins/frontendPlugin";
import { useQueryStore } from "@/stores/queryStore";
import type { PluginCommandContribution } from "@/types/database";

export interface PluginToolbarCommandEntry {
  pluginId: string;
  pluginName: string;
  commandId: string;
  label: string;
  description?: string;
  icon?: string;
}

export interface PluginCommandExecutionResult {
  error?: string;
}

/** Re-checks the command and its workbench reference at execution time, then opens the workbench tab. */
export function executePluginCommand(registry: FrontendPluginRegistry, queryStore: ReturnType<typeof useQueryStore>, pluginId: string, commandId: string): PluginCommandExecutionResult {
  const command = registry.findCommand(pluginId, commandId)?.contribution;
  if (!command) return { error: `Unknown command '${pluginId}.${commandId}'` };
  const action = command.action;
  if (action.type !== "open-workbench") return { error: `Command '${pluginId}.${commandId}' has an unsupported action` };
  const workbench = registry.findWorkbench(pluginId, action.workbench);
  if (!workbench) return { error: `Command '${pluginId}.${commandId}' references missing workbench '${action.workbench}'` };
  // presentation: panel → 全局底部 Dock（§8.3）新增一个终端条目；tab（缺省）
  // → 工作台 tab。
  if (action.presentation === "panel") {
    addPluginDockEntry({
      pluginId,
      workbenchContributionId: action.workbench,
      kind: "command",
      commandId: command.id,
      title: command.label,
      icon: command.icon,
      commandContext: action.context ?? {},
    });
    return {};
  }
  // 宿主权威 context：从 action.context 出发重建，插件传入的保留字段
  // （workbenchId/restored/surface）不会透传；workbenchId 由宿主生成。
  const context = {
    ...(action.context ?? {}),
    workbenchId: uuid(),
    restored: false,
    surface: "tab",
  };
  // singleton（缺省）→ 复用既有实例 tab；new → forceNew 另起新实例。
  queryStore.openPluginWorkbench(pluginId, action.workbench, {
    title: command.label,
    context,
    forceNew: action.reuse === "new",
  });
  return {};
}

export function usePluginToolbarCommands() {
  const { locale } = useI18n();
  const entries = ref<PluginToolbarCommandEntry[]>([]);
  // shallowRef：Registry 是带私有字段的类实例，deep ref 的 UnwrapRef 会破坏
  // 其名义类型（TS 把它展开成纯结构对象导致不可赋值）。
  const registry = shallowRef<FrontendPluginRegistry | null>(null);

  async function refresh() {
    try {
      const installedPlugins = await api.listPlugins();
      const nextRegistry = createFrontendPluginRegistry(installedPlugins, locale.value);
      entries.value = nextRegistry.listToolbarMenuCommands().map(({ plugin, command }: { plugin: { manifest: { id: string; name: string } }; command: PluginCommandContribution }) => ({
        pluginId: plugin.manifest.id,
        pluginName: plugin.manifest.name,
        commandId: command.id,
        label: command.label,
        description: command.description,
        icon: command.icon,
      }));
      registry.value = nextRegistry;
    } catch (cause) {
      console.warn("[DBX][plugin:toolbar-entries]", cause);
      entries.value = [];
      registry.value = null;
    }
  }

  function open(entry: PluginToolbarCommandEntry): PluginCommandExecutionResult {
    if (!registry.value) return { error: "Plugin registry is not ready" };
    // 惰性取 store：仅在真正点击入口时才需要 pinia（挂载期无 store 依赖，
    // 纯侧栏宿主测试无需 Pinia 环境）。
    return executePluginCommand(registry.value, useQueryStore(), entry.pluginId, entry.commandId);
  }

  watch(locale, () => void refresh());
  // 安装/卸载/替换插件（插件中心广播 dbx:plugins-changed）或窗口重新聚焦时
  // 刷新入口，保证入口与已装插件清单一致。
  const onPluginsChanged = () => void refresh();
  window.addEventListener("dbx:plugins-changed", onPluginsChanged);
  window.addEventListener("focus", onPluginsChanged);
  onScopeDispose(() => {
    window.removeEventListener("dbx:plugins-changed", onPluginsChanged);
    window.removeEventListener("focus", onPluginsChanged);
  });
  void refresh();

  return { entries, refresh, open };
}
