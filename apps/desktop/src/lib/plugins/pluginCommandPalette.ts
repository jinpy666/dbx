// commandPalette surface（HOST_PLUGIN_UI_SPEC §5）：把插件 `menus` 贡献中
// location === "commandPalette" 的命令声明派生为 quick-open 条目，执行时统一走
// executePluginCommand 的宿主权威链路（命令/工作台重解析、context 注入都在那里）。
// 纯通用逻辑：label / 描述 / 来源全部来自清单声明，不含任何业务专属字段。
import { onScopeDispose, ref, shallowRef, watch } from "vue";
import * as api from "@/lib/backend/api";
import i18n from "@/i18n";
import { createFrontendPluginRegistry, type FrontendPluginRegistry } from "./frontendPlugin";
import { executePluginCommand, type PluginCommandExecutionResult } from "./pluginCommandRegistry";
import { useQueryStore } from "@/stores/queryStore";
import type { InstalledPlugin, PluginCommandContribution } from "@/types/database";
import type { QuickOpenItem } from "@/composables/useQuickOpen";

/** FrontendPluginRegistry.listPaletteMenuCommands() 的返回条目形状。 */
export interface PluginPaletteCommandEntry {
  plugin: InstalledPlugin;
  command: PluginCommandContribution;
  order: number;
}

/** 由 palette 声明派生 quick-open 条目：label 为命令文案，出处提示走 description 与右侧插件名徽标。 */
export function pluginCommandPaletteItems(entries: readonly PluginPaletteCommandEntry[]): QuickOpenItem[] {
  return entries.map(({ plugin, command }) => ({
    id: `plugin-command-${plugin.manifest.id}-${command.id}`,
    type: "plugin_command" as const,
    label: command.label,
    description: command.description || plugin.manifest.name,
    connectionId: "",
    pluginId: plugin.manifest.id,
    commandId: command.id,
    pluginName: plugin.manifest.name,
    // 搜索匹配：命令 label、描述与来源插件名都参与 quick-open 的匹配/拼音检索。
    searchText: [command.label, command.description, plugin.manifest.name].filter(Boolean).join(" "),
  }));
}

/**
 * 插件命令面板数据源：清单随已安装插件派生，安装/卸载/替换（插件中心广播
 * dbx:plugins-changed）、窗口重新聚焦或界面语言变化时刷新。执行时惰性取
 * queryStore（与 usePluginToolbarCommands 相同做法，纯宿主环境无需 Pinia）。
 */
export function usePluginCommandPalette() {
  const items = ref<QuickOpenItem[]>([]);
  // shallowRef：Registry 是带私有字段的类实例，deep ref 的 UnwrapRef 会破坏其名义类型。
  const registry = shallowRef<FrontendPluginRegistry | null>(null);

  async function refresh(): Promise<void> {
    try {
      const installedPlugins = await api.listPlugins();
      const nextRegistry = createFrontendPluginRegistry(installedPlugins, i18n.global.locale.value);
      registry.value = nextRegistry;
      items.value = pluginCommandPaletteItems(nextRegistry.listPaletteMenuCommands());
    } catch (cause) {
      console.warn("[DBX][plugin:palette-commands]", cause);
      registry.value = null;
      items.value = [];
    }
  }

  /** 执行 quick-open 中的一条插件命令；错误经返回值交调用方提示。 */
  function open(item: QuickOpenItem): PluginCommandExecutionResult {
    if (item.type !== "plugin_command" || !item.pluginId || !item.commandId) return { error: "Item is not a plugin command" };
    if (!registry.value) return { error: "Plugin registry is not ready" };
    return executePluginCommand(registry.value, useQueryStore(), item.pluginId, item.commandId);
  }

  watch(
    () => i18n.global.locale.value,
    () => void refresh(),
  );
  const onPluginsChanged = () => void refresh();
  window.addEventListener("dbx:plugins-changed", onPluginsChanged);
  window.addEventListener("focus", onPluginsChanged);
  onScopeDispose(() => {
    window.removeEventListener("dbx:plugins-changed", onPluginsChanged);
    window.removeEventListener("focus", onPluginsChanged);
  });
  void refresh();

  return { items, registry, refresh, open };
}
