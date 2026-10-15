declare module "@earendil-works/pi-coding-agent" {
  interface ToolDefinition {
    /** pi 0.99. Absent from the 0.87 types this package typechecks against. */
    exposure?: "direct" | "model-only" | "codemode" | "deferred" | "hidden";
  }
}

export {};
