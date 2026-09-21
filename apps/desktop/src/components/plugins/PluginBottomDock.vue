<script setup lang="ts">
// PR-A4/P2 全局底部 Dock（HOST_PLUGIN_UI_SPEC §8.3）：宿主通用容器，承载以
// presentation: panel 打开的插件工作台。全局悬浮于所有页面之上；关闭仅移除
// 面板，Dock 会话期内 workbenchId 稳定，重开经 local/session/list 接回同一
// scope（tab 与 panel 实例可并存，复用键含 presentation）。
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronUp, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import PluginIcon from "@/components/plugins/PluginIcon.vue";
import PluginWorkbenchHost from "@/components/plugins/PluginWorkbenchHost.vue";
import { closePluginBottomDock, usePluginBottomDock } from "@/lib/plugins/pluginBottomDock";
import * as api from "@/lib/backend/api";
import type { InstalledPlugin, PluginWorkbenchContribution } from "@/types/database";

const DOCK_HEIGHT_PX = 320;

const { t } = useI18n();
const dock = usePluginBottomDock();
const collapsed = ref(false);
const plugins = ref<InstalledPlugin[]>([]);

watch(
  dock,
  async (state) => {
    if (!state) return;
    try {
      plugins.value = await api.listPlugins();
    } catch {
      plugins.value = [];
    }
  },
  { immediate: true },
);

const definition = computed(() => (dock.value ? (plugins.value.find((plugin) => plugin.manifest.id === dock.value!.pluginId) ?? null) : null));
const workbench = computed(() => {
  const state = dock.value;
  if (!state || !definition.value) return null;
  return (definition.value.manifest.contributions || []).find((candidate): candidate is PluginWorkbenchContribution => candidate.type === "workbench" && candidate.id === state.workbenchContributionId) ?? null;
});
</script>

<template>
  <div v-if="dock" data-plugin-bottom-dock class="fixed inset-x-0 bottom-0 z-40 flex flex-col border-t bg-background shadow-[0_-10px_30px_rgba(0,0,0,0.28)]" :style="{ height: (collapsed ? 36 : DOCK_HEIGHT_PX) + 'px' }">
    <div class="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/30 px-3">
      <PluginIcon v-if="definition" :plugin-id="dock.pluginId" :icon="definition.manifest.icon" class="h-4 w-4 shrink-0" />
      <span class="min-w-0 truncate text-xs font-medium" data-plugin-dock-title>{{ dock.title }}</span>
      <span class="min-w-0 truncate text-[11px] text-muted-foreground">{{ t("sidebar.pluginEntrySource", { name: definition?.manifest.name ?? dock.pluginId }) }}</span>
      <span class="flex-1" />
      <Button variant="ghost" size="icon" class="h-6 w-6" :title="collapsed ? t('pluginDock.expand') : t('pluginDock.collapse')" :aria-label="collapsed ? t('pluginDock.expand') : t('pluginDock.collapse')" @click="collapsed = !collapsed">
        <ChevronUp v-if="collapsed" class="h-3.5 w-3.5" />
        <ChevronDown v-else class="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" class="h-6 w-6" :title="t('pluginDock.close')" :aria-label="t('pluginDock.close')" @click="closePluginBottomDock">
        <X class="h-3.5 w-3.5" />
      </Button>
    </div>
    <div v-show="!collapsed" class="min-h-0 flex-1 overflow-hidden">
      <PluginWorkbenchHost v-if="definition && workbench" :plugin="definition" :contribution="workbench" :context="dock.context" @close-tab="closePluginBottomDock" />
    </div>
  </div>
</template>
