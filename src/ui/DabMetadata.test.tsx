// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DabMetadata } from "./DabMetadata";

it("displays broadcast text as text and releases image URLs on switch/unmount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const create = vi.fn(() => "blob:local-slide"),
    revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  const host = document.createElement("div"),
    root = createRoot(host);
  const slide = {
    name: "station.png",
    transportId: 1,
    mimeType: "image/png" as const,
    data: new Uint8Array([1, 2, 3]),
  };
  try {
    await act(async () =>
      root.render(
        <DabMetadata
          metadata={{ text: "Artist <script>alert(1)</script>", slide }}
        />,
      ),
    );
    expect(host.textContent).toContain("Artist <script>alert(1)</script>");
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("img")?.getAttribute("src")).toBe(
      "blob:local-slide",
    );
    expect(create).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(<DabMetadata metadata={{ text: "Next song", slide }} />),
    );
    expect(create).toHaveBeenCalledOnce();
    await act(async () => root.render(<DabMetadata />));
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:local-slide");
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("Waiting for broadcast text");
    await act(async () => root.render(<DabMetadata metadata={{ slide }} />));
    await act(async () => root.unmount());
    expect(revoke).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
