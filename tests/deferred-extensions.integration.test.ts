import { existsSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import { pathToFileURL } from "node:url";
import {
  createDefaultImportModule,
  DEFERRED_PACKAGE_SPECS,
  resolveDeferredPackageEntry,
} from "../extensions/deferred-extensions.js";

const installedEntries = DEFERRED_PACKAGE_SPECS.map((spec) =>
  resolveDeferredPackageEntry(getAgentDir(), spec),
);
const hasInstalledEntries = installedEntries.every((entry) => existsSync(entry));
const integrationDescribe = hasInstalledEntries ? describe : describe.skip;

integrationDescribe("deferred extensions installed entries", () => {
  it("imports every entry without invoking its factory", async () => {
    const importModule = createDefaultImportModule();

    for (const entry of installedEntries) {
      const imported = await importModule(pathToFileURL(entry).href);
      expect(typeof imported).toBe("function");
    }
  });
});
