import { expect, it } from "vitest";
import { DEFAULT_WORKSPACE, readWorkspace } from "./WorkspaceLayout";
it("recovers safe appearance defaults from unavailable/malformed storage without receiver state", () => {
  expect(
    readWorkspace({
      getItem: () => {
        throw new Error("blocked");
      },
    }),
  ).toEqual(DEFAULT_WORKSPACE);
  expect(readWorkspace({ getItem: () => "{invalid" })).toEqual(
    DEFAULT_WORKSPACE,
  );
  expect(
    readWorkspace({
      getItem: () =>
        JSON.stringify({
          compact: "true",
          sourceCollapsed: true,
          channelCollapsed: 1,
          dockExpanded: false,
          source: "hackrf",
          running: true,
        }),
    }),
  ).toEqual({
    ...DEFAULT_WORKSPACE,
    sourceCollapsed: true,
    dockExpanded: false,
  });
});
