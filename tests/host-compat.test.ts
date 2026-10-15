import { describe, expect, it } from "vite-plus/test";
import {
  hostToolNames,
  isInteractiveSession,
  isProjectTrusted,
} from "../extensions/host-compat.js";

describe("host compatibility shims", () => {
  it("reads tool names from definitions and from plain names", () => {
    expect(hostToolNames([{ name: "read" }, "bash", { label: "no name" }, 7])).toEqual([
      "read",
      "bash",
    ]);
  });

  it("treats a host without a trust API as untrusted", () => {
    expect(isProjectTrusted({ cwd: "/tmp" })).toBe(false);
    expect(isProjectTrusted({ isProjectTrusted: () => true })).toBe(true);
    expect(isProjectTrusted({ isProjectTrusted: () => false })).toBe(false);
  });

  it("falls back to hasUI when the host exposes no mode", () => {
    expect(isInteractiveSession({ mode: "tui", hasUI: true })).toBe(true);
    expect(isInteractiveSession({ mode: "print", hasUI: true })).toBe(false);
    expect(isInteractiveSession({ hasUI: true })).toBe(true);
    expect(isInteractiveSession({ hasUI: false })).toBe(false);
    expect(isInteractiveSession({})).toBe(false);
  });
});
