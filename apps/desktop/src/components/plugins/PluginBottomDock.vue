<script setup lang="ts">
// PR-A4/P2 global bottom panel dock (HOST_PLUGIN_UI_SPEC §8.3) — a generic host container:
// it only provides the panel frame (tab strip, drag-resize height, collapse/maximize/hide) and hosts any plugin's
// panel webviews, with zero plugin business inside; multi-terminal/shell selection/connection switching all live in the plugin
// the plugin's own panel page via the bridge openWorkbench, which adds another dock entry).
// Each entry owns a host-stable workbenchId; v-show keeps sessions alive while switching tabs.
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronUp, Maximize2, Minimize2, Plus, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import PluginIcon from "@/components/plugins/PluginIcon.vue";
import PluginWorkbenchHost from "@/components/plugins/PluginWorkbenchHost.vue";
import { activatePluginDockEntry, addPluginDockEntry, closePluginDockEntry, setDockMaximized, setDockVisible, usePluginBottomDock } from "@/lib/plugins/pluginBottomDock";
import { executePluginCommand } from "@/lib/plugins/pluginCommandRegistry";
import { createFrontendPluginRegistry } from "@/lib/plugins/frontendPlugin";
import { useQueryStore } from "@/stores/queryStore";
import * as api from "@/lib/backend/api";
import type { InstalledPlugin, PluginWorkbenchContribution } from "@/types/database";

const DOCK_HEIGHT_PX = 320;
const DOCK_MIN_HEIGHT_PX = 140;

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
window.addEventListener("dbx:plugins-changed", () => void loadPluginData());

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

// Generic "+": replays the command the active entry came from (no business semantics; multi-terminal/shell
// the plugin's own panel page opens additional dock entries via the bridge openWorkbench).
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

// Drag the top edge to resize the height (min 140px, up to 80% of the window).
const resizing = ref(false);
function startResize(event: PointerEvent) {
  event.preventDefault();
  resizing.value = true;
  const startY = event.clientY;
  const startHeight = dockHeight.value;
  const onMove = (moveEvent: PointerEvent) => {
    const next = startHeight - (moveEvent.clientY - startY);
    dockHeight.value = Math.min(Math.max(next, DOCK_MIN_HEIGHT_PX), Math.floor(window.innerHeight * 0.8));
  };
  const onUp = () => {
    resizing.value = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
</script>

<template>
  <div v-if="visible" data-plugin-bottom-dock class="relative z-10 flex shrink-0 flex-col overflow-hidden border-t bg-background" :style="{ height: maximized ? '70vh' : collapsed ? '2.25rem' : `${dockHeight}px` }">
    <div data-plugin-dock-resize-handle class="absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize hover:bg-primary/30" @pointerdown="startResize" />
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
      <span class="flex-1" />
      <Button v-if="activeCommand" variant="ghost" size="icon" class="h-7 w-7" :title="t('pluginDock.newTerminal')" :aria-label="t('pluginDock.newTerminal')" @click="rerunActiveCommand">
        <Plus class="h-4 w-4" />
      </Button>
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
