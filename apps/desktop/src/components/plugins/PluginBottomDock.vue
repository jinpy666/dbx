<script setup lang="ts">
// PR-A4/P2 global bottom panel dock (HOST_PLUGIN_UI_SPEC §8.3) — a generic host container:
// it only provides the panel frame (tab strip, drag-resize height, collapse/maximize/hide) and hosts any plugin's
// panel webviews, with zero plugin business inside; multi-terminal/shell selection/connection switching all live in the plugin
// the plugin's own panel page via the bridge openWorkbench, which adds another dock entry).
// Each entry owns a host-stable workbenchId; v-show keeps sessions alive while switching tabs.
import { computed, onScopeDispose, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronUp, Maximize2, Minimize2, Plus, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import PluginIcon from "@/components/plugins/PluginIcon.vue";
import PluginWorkbenchHost from "@/components/plugins/PluginWorkbenchHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { activatePluginDockEntry, addPluginDockEntry, closePluginDockEntry, setDockMaximized, setDockVisible, usePluginBottomDock } from "@/lib/plugins/pluginBottomDock";
import { useDockResize } from "@/composables/useDockResize";
import { executePluginCommand } from "@/lib/plugins/pluginCommandRegistry";
import { createFrontendPluginRegistry } from "@/lib/plugins/frontendPlugin";
import { useQueryStore } from "@/stores/queryStore";
import * as api from "@/lib/backend/api";
import type { InstalledPlugin, PluginWorkbenchContribution } from "@/types/database";

const DOCK_HEIGHT_PX = 320;
const DOCK_MIN_HEIGHT_PX = 140;
// One bound for the drag ceiling and the maximize height: a dragged dock must
// never shrink when the maximize button is pressed.
const DOCK_MAX_VIEWPORT_RATIO = 0.8;

const { t } = useI18n();
const queryStore = useQueryStore();
const { entries, activeEntryId, visible, maximized } = usePluginBottomDock();
const collapsed = ref(false);
const dockHeight = ref(DOCK_HEIGHT_PX);
const plugins = ref<InstalledPlugin[]>([]);

const activeEntry = computed(() => entries.value.find((entry) => entry.id === activeEntryId.value) ?? null);
const activeCommand = computed(() => {
  const entry = activeEntry.value;
  if (!entry || entry.kind !== "command" || !entry.commandId) return null;
  return createFrontendPluginRegistry(plugins.value).findCommand(entry.pluginId, entry.commandId)?.contribution ?? null;
});

watch(entries, () => void loadPluginData(), { deep: true, immediate: true });
watch([activeEntry, activeCommand], () => void loadLaunchOptions());
const onPluginsChanged = () => void loadPluginData();
window.addEventListener("dbx:plugins-changed", onPluginsChanged);
onScopeDispose(() => window.removeEventListener("dbx:plugins-changed", onPluginsChanged));

async function loadPluginData() {
  if (!entries.value.length) {
    plugins.value = [];
    return;
  }
  try {
    plugins.value = await api.listPlugins();
  } catch {
    plugins.value = [];
  }
}

function definitionFor(pluginId: string): InstalledPlugin | undefined {
  return plugins.value.find((candidate) => candidate.manifest.id === pluginId);
}

// Generic "+" picker (extension-point driven, zero business in the host):
// - the command itself (replay),
// - dynamic entries from the declared sidecar options_action (e.g. shell types),
// - when connection_targets is on, the plugin's own saved connections.
const connectionStore = useConnectionStore();
const launchOptionEntries = ref<Array<{ key: string; label: string; description?: string; context?: Record<string, unknown> }>>([]);
const launchOptionsLoading = ref(false);

const activeAction = computed(() => (activeCommand.value?.action.type === "open-workbench" ? activeCommand.value.action : null));
const activePluginProviders = computed(() => {
  const pluginId = activeEntry.value?.pluginId;
  const plugin = pluginId ? definitionFor(pluginId) : undefined;
  return new Set((plugin?.manifest.contributions || []).filter((candidate) => candidate.type === "connection-provider").map((candidate) => candidate.id));
});

async function loadLaunchOptions() {
  const action = activeAction.value;
  const pluginId = activeEntry.value?.pluginId;
  launchOptionEntries.value = [];
  if (!action || !pluginId || !action.options_action) return;
  launchOptionsLoading.value = true;
  try {
    const result = await api.invokePlugin<{ entries?: Array<{ label: string; description?: string; context?: Record<string, unknown> }> }>(pluginId, action.options_action, {});
    launchOptionEntries.value = (result?.entries ?? []).map((entry, index) => ({ key: `opt:${index}`, label: entry.label, description: entry.description, context: entry.context }));
  } catch (cause) {
    console.warn("[DBX][plugin:dock] launch options unavailable", cause);
    launchOptionEntries.value = [];
  } finally {
    launchOptionsLoading.value = false;
  }
}

const connectionTargets = computed(() => {
  if (!activeAction.value?.connection_targets) return [];
  const providers = activePluginProviders.value;
  return connectionStore.connections.filter((connection) => providers.has(connection.plugin_connection_provider ?? "")).map((connection) => ({ key: `conn:${connection.id}`, label: connection.name || connection.id, connection }));
});

function onPlusAction(value: string) {
  if (value === "replay") {
    rerunActiveCommand();
    return;
  }
  if (value.startsWith("opt:")) {
    const index = Number(value.slice(4));
    const option = launchOptionEntries.value[index];
    if (!option) return;
    const entry = activeEntry.value;
    const command = activeCommand.value;
    if (!entry || !command) return;
    const id = addPluginDockEntry({
      pluginId: entry.pluginId,
      workbenchContributionId: entry.workbenchContributionId,
      kind: "command",
      commandId: command.id,
      title: option.label,
      icon: command.icon,
      commandContext: option.context ?? {},
    });
    activatePluginDockEntry(id);
    return;
  }
  if (value.startsWith("conn:")) {
    const connectionId = value.slice("conn:".length);
    const target = connectionTargets.value.find((candidate) => candidate.key === `conn:${connectionId}`);
    const connection = target?.connection;
    const entry = activeEntry.value;
    const command = activeCommand.value;
    if (!connection || !entry || !command) return;
    const id = addPluginDockEntry({
      pluginId: entry.pluginId,
      workbenchContributionId: entry.workbenchContributionId,
      kind: "connection",
      commandId: command.id,
      title: connection.name || connection.id,
      icon: activeCommand.value?.icon,
      commandContext: {
        connectionId: connection.id,
        providerId: connection.plugin_connection_provider,
        connectionType: connection.plugin_connection_type,
        connection: {
          id: connection.id,
          name: connection.name,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          readOnly: connection.read_only === true,
        },
      },
    });
    activatePluginDockEntry(id);
  }
}

function rerunActiveCommand() {
  const entry = activeEntry.value;
  const command = activeCommand.value;
  if (!entry || !command) return;
  const result = executePluginCommand(createFrontendPluginRegistry(plugins.value), queryStore, entry.pluginId, command.id);
  if (result.error) console.warn("[DBX][plugin:dock]", result.error);
}

// A dock-hosted webview asking for another panel via the bridge openWorkbench: the host rebuilds the authoritative
// context (dropping plugin-supplied reserved fields) and adds one generic panel entry.
function onPanelOpenWorkbench(entry: (typeof entries.value)[number], _contributionId: string, childContext?: Record<string, unknown>) {
  const payload = childContext && typeof childContext === "object" && !Array.isArray(childContext) ? { ...childContext } : {};
  delete payload.workbenchId;
  delete payload.restored;
  delete payload.surface;
  const id = addPluginDockEntry({
    pluginId: entry.pluginId,
    workbenchContributionId: entry.workbenchContributionId,
    kind: "command",
    title: entry.title,
    commandContext: payload,
  });
  activatePluginDockEntry(id);
}

// Hide the panel: terminal sessions survive (VS Code semantics); the toolbar icon restores it.
function hideDock() {
  collapsed.value = false;
  setDockMaximized(false);
  setDockVisible(false);
}

// Drag the top edge to resize the height (min 140px, up to the shared maximize
// bound). Dragging always exits maximized/collapsed: the start height is the
// currently rendered pixel height, so the transition is seamless. The
// composable owns pointer capture, rAF coalescing and listener cleanup — see
// useDockResize for why capture is load-bearing over the plugin iframes.
const dockRoot = ref<HTMLElement>();
const { startResize } = useDockResize({
  dockHeight,
  minHeight: DOCK_MIN_HEIGHT_PX,
  maxHeightRatio: DOCK_MAX_VIEWPORT_RATIO,
  dockElement: () => dockRoot.value ?? null,
});

function onResizeHandlePointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  // Leave maximized/collapsed before the drag measures the rendered height:
  // the composable starts from the currently rendered px height, so the
  // transition stays seamless.
  setDockMaximized(false);
  collapsed.value = false;
  startResize(event);
}

// "+" picker menu: anchored below the + button, bottom-stuck inside the dock,
// growing upward with content (capped by the dock body), closed by selecting
// an item or clicking anywhere else.
const plusOpen = ref(false);
const plusRoot = ref<HTMLElement>();
function togglePlusMenu() {
  plusOpen.value = !plusOpen.value;
  if (plusOpen.value) void loadLaunchOptions();
}
function closePlusMenu() {
  plusOpen.value = false;
}
const onPlusMenuOutsidePointerDown = (event: PointerEvent) => {
  const root = plusRoot.value;
  if (plusOpen.value && root && !root.contains(event.target as Node)) closePlusMenu();
};
window.addEventListener("pointerdown", onPlusMenuOutsidePointerDown, true);
onScopeDispose(() => window.removeEventListener("pointerdown", onPlusMenuOutsidePointerDown, true));
</script>

<template>
  <!-- v-show, not v-if (HOST_PLUGIN_UI_SPEC §8.3): hiding the panel must only
       hide the UI — the entry webviews (and the user's dragged height) stay
       mounted and alive across hide/show. -->
  <div v-show="visible" ref="dockRoot" data-plugin-bottom-dock class="relative z-10 flex shrink-0 flex-col overflow-hidden border-t bg-background" :style="{ height: maximized ? `${DOCK_MAX_VIEWPORT_RATIO * 100}vh` : collapsed ? '2.25rem' : `${dockHeight}px` }">
    <div data-plugin-dock-resize-handle class="absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize hover:bg-primary/30" @pointerdown="onResizeHandlePointerDown" />
    <div class="flex h-9 shrink-0 items-center gap-1 border-b bg-muted/30 pl-2 pr-3">
      <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" data-plugin-dock-tabs>
        <button
          v-for="entry in entries"
          :key="entry.id"
          class="group flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs"
          :class="entry.id === activeEntryId ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'"
          :title="entry.title"
          @click="activatePluginDockEntry(entry.id)"
        >
          <PluginIcon :plugin-id="entry.pluginId" :icon="entry.icon" class="h-3.5 w-3.5 shrink-0" />
          <span class="max-w-40 truncate">{{ entry.title }}</span>
          <span class="ml-0.5 rounded p-0.5 opacity-0 transition-opacity hover:bg-background/80 group-hover:opacity-100" role="button" :aria-label="t('pluginDock.close')" @click.stop="closePluginDockEntry(entry.id)">
            <X class="h-3 w-3" />
          </span>
        </button>
      </div>
      <div v-if="activeCommand" ref="plusRoot" class="relative">
        <Tooltip :delay-duration="200">
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" :aria-label="t('pluginDock.newTerminal')" :aria-expanded="plusOpen" @click="togglePlusMenu">
              <Plus class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t("pluginDock.newTerminal") }}</TooltipContent>
        </Tooltip>
        <div v-if="plusOpen" data-plugin-dock-plus-menu class="absolute right-0 top-full z-30 mt-1 max-h-[50vh] w-64 overflow-y-auto rounded-md border bg-background p-1 shadow-lg" role="menu">
          <button class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted" role="menuitem" @click="onPlusAction('replay')">
            <Plus class="h-3.5 w-3.5 shrink-0" />
            <span class="truncate">{{ t("pluginDock.newTerminal") }}</span>
          </button>
          <button v-for="option in launchOptionEntries" :key="option.key" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted" role="menuitem" @click="onPlusAction(option.key)">
            <span class="truncate">{{ option.label }}</span>
          </button>
          <button v-for="target in connectionTargets" :key="target.key" class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted" role="menuitem" :title="target.connection.name" @click="onPlusAction(target.key)">
            <span class="truncate">{{ t("pluginDock.connectionTerminal") }} · {{ target.label }}</span>
          </button>
        </div>
      </div>
      <Tooltip :delay-duration="200">
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon" class="h-7 w-7" :title="maximized ? t('pluginDock.restore') : t('pluginDock.maximize')" :aria-label="maximized ? t('pluginDock.restore') : t('pluginDock.maximize')" @click="setDockMaximized(!maximized)">
            <Minimize2 v-if="maximized" class="h-3.5 w-3.5" />
            <Maximize2 v-else class="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{{ maximized ? t("pluginDock.restore") : t("pluginDock.maximize") }}</TooltipContent>
      </Tooltip>
      <Button variant="ghost" size="icon" class="h-7 w-7" :title="collapsed ? t('pluginDock.expand') : t('pluginDock.collapse')" :aria-label="collapsed ? t('pluginDock.expand') : t('pluginDock.collapse')" @click="collapsed = !collapsed">
        <ChevronUp v-if="collapsed" class="h-3.5 w-3.5" />
        <ChevronDown v-else class="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('pluginDock.hide')" :aria-label="t('pluginDock.hide')" @click="hideDock">
        <X class="h-3.5 w-3.5" />
      </Button>
    </div>
    <div class="min-h-0 flex-1 overflow-hidden">
      <div v-for="entry in entries" v-show="entry.id === activeEntryId && !collapsed" :key="entry.id" class="h-full w-full">
        <PluginWorkbenchHost
          v-if="definitionFor(entry.pluginId)"
          :plugin="definitionFor(entry.pluginId)!"
          :contribution="(definitionFor(entry.pluginId)!.manifest.contributions || []).find((candidate): candidate is PluginWorkbenchContribution => candidate.type === 'workbench' && candidate.id === entry.workbenchContributionId)!"
          :context="entry.context"
          @close-tab="closePluginDockEntry(entry.id)"
          @open-workbench="(_pluginId, contributionId, context) => onPanelOpenWorkbench(entry, contributionId, context)"
        />
      </div>
    </div>
  </div>
</template>
