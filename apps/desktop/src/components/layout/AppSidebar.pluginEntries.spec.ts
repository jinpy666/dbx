// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import AppSidebar from "./AppSidebar.vue";

// PR-A4 appSidebar 插件入口区：仅当插件声明 appSidebar placement 时渲染
// （无声明即无 chrome），行内展示命令 label + 插件来源提示，点击转交命令
// 执行器并回显错误。
const mocks = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  sidebarCommands: {
    entries: [] as Array<{ pluginId: string; pluginName: string; commandId: string; label: string; description?: string; icon?: string }>,
    refresh: vi.fn(),
    open: vi.fn(() => ({}) as { error?: string }),
  },
  toast: vi.fn(),
}));

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => (values && values.name ? `${key}:${values.name as string}` : key), locale: { value: "en" } }),
}));

vi.mock("@/lib/plugins/pluginCommandRegistry", () => ({
  usePluginSidebarCommands: () => mocks.sidebarCommands,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => mocks.store,
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/lib/backend/api", () => ({}));

// ConnectionTree 依赖整条 Pinia store 链，这里只验证入口区，替换为哑组件。
vi.mock("@/components/sidebar/ConnectionTree.vue", async () => {
  const { defineComponent } = await import("vue");
  return {
    default: defineComponent({ name: "ConnectionTreeStub", template: "<div data-connection-tree-stub />" }),
  };
});

Object.assign(mocks.store, {
  connections: [],
  sidebarLayout: { groups: [] },
  connectionMultiSelectActive: false,
  selectedTreeNodeIds: [],
  selectedTreeNodeId: null,
  treeSelectionAnchorId: null,
  refreshAllTree: vi.fn(),
  removeConnections: vi.fn(),
  disconnect: vi.fn().mockResolvedValue(undefined),
  createConnectionGroup: vi.fn(),
  moveConnectionToGroup: vi.fn(),
});

let host: ReturnType<typeof createApp> | null = null;
let container: HTMLElement | null = null;

function mountSidebar() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(
    defineComponent({
      render: () => h(AppSidebar, { sidebarWidth: 300 }),
    }),
  );
  app.mount(container);
  host = app;
  return container;
}

beforeEach(() => {
  mocks.sidebarCommands.entries = [];
  mocks.sidebarCommands.open.mockClear();
  mocks.toast.mockClear();
});

afterEach(() => {
  host?.unmount();
  host = null;
  container?.remove();
  container = null;
});

describe("AppSidebar plugin command entries (PR-A4)", () => {
  it("renders no plugin section when no appSidebar placements are declared", async () => {
    const root = mountSidebar();
    await nextTick();
    expect(root.querySelector("[data-plugin-sidebar-entries]")).toBeNull();
  });

  it("renders entries with label and plugin source, and executes on click", async () => {
    mocks.sidebarCommands.entries = [{ pluginId: "io.dbx.ssh", pluginName: "DBX SSH Terminal", commandId: "open-local-terminal", label: "Local terminal", icon: "assets/local-terminal.svg" }];
    const root = mountSidebar();
    await nextTick();
    const section = root.querySelector("[data-plugin-sidebar-entries]");
    expect(section).not.toBeNull();
    const button = section!.querySelector("button");
    expect(button!.textContent).toContain("Local terminal");
    expect(button!.getAttribute("title")).toBe("sidebar.pluginEntrySource:DBX SSH Terminal");
    (button as HTMLButtonElement).click();
    await nextTick();
    expect(mocks.sidebarCommands.open).toHaveBeenCalledWith(mocks.sidebarCommands.entries[0]);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("surfaces execution errors through the toast", async () => {
    mocks.sidebarCommands.entries = [{ pluginId: "io.dbx.ssh", pluginName: "DBX SSH Terminal", commandId: "open-local-terminal", label: "Local terminal" }];
    mocks.sidebarCommands.open.mockReturnValue({ error: "Command failed" });
    const root = mountSidebar();
    await nextTick();
    (root.querySelector("[data-plugin-sidebar-entries] button") as HTMLButtonElement).click();
    await nextTick();
    expect(mocks.toast).toHaveBeenCalledWith("Command failed", 5000);
  });
});
