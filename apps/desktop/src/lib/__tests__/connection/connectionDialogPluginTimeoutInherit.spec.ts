import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

describe("ConnectionDialog plugin connection timeout inheritance", () => {
  const submitFn = dialogSource.slice(dialogSource.indexOf("function connectionConfigForSubmit"));
  const pluginBranch = submitFn.slice(0, submitFn.indexOf("} else {"));

  it("keeps the connect timeout inherit flag when submitting plugin connections", () => {
    // buildPluginConnectionConfig rebuilds the config from scratch and drops
    // the inherit flags; without this mirror the store normalizes the absent
    // flag back to the persisted scope and the Advanced-tab radio reverts.
    expect(pluginBranch).toContain("config.connect_timeout_inherit = form.value.connect_timeout_inherit;");
  });

  it("keeps the query timeout inherit flag when submitting plugin connections", () => {
    expect(pluginBranch).toContain("config.query_timeout_inherit = form.value.query_timeout_inherit;");
  });

  it("still forces connect inheritance off for providers declaring their own handshake timeout field", () => {
    // The resolvedPluginConnectTimeout override must run after the generic
    // mirror so a provider-declared connect_timeout_secs stays the single
    // source of truth and the host RPC deadline cannot inherit the global.
    const mirrorIndex = pluginBranch.indexOf("config.connect_timeout_inherit = form.value.connect_timeout_inherit;");
    const overrideIndex = pluginBranch.indexOf("config.connect_timeout_inherit = false;");
    expect(mirrorIndex).toBeGreaterThan(-1);
    expect(overrideIndex).toBeGreaterThan(mirrorIndex);
  });
});
