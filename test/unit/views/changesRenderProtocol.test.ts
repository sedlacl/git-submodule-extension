import { describe, expect, it } from "vitest";
import {
  ChangesRenderProtocol,
  shouldApplyChangesRender,
} from "../../../src/views/changesRenderProtocol.js";

describe("ChangesRenderProtocol", () => {
  it("keeps bootstrap pending until the matching final render is acknowledged", () => {
    const protocol = new ChangesRenderProtocol();
    const bootstrap = protocol.begin("bootstrap");
    expect(protocol.isPending()).toBe(true);
    expect(protocol.acknowledge(bootstrap)).toBe(false);

    const final = { generation: bootstrap.generation, renderState: "final" as const };
    expect(protocol.advance(final)).toBe(true);
    expect(protocol.isPending()).toBe(true);
    expect(protocol.acknowledge(final)).toBe(true);
    expect(protocol.isPending()).toBe(false);
  });

  it("does not let a stale generation clear newer loading progress", () => {
    const protocol = new ChangesRenderProtocol();
    const first = protocol.begin("bootstrap");
    const second = protocol.begin("bootstrap");

    expect(protocol.advance({ generation: first.generation, renderState: "final" })).toBe(false);
    expect(protocol.acknowledge({ generation: first.generation, renderState: "final" })).toBe(false);
    expect(protocol.isCurrent(second.generation)).toBe(true);
    expect(protocol.isPending()).toBe(true);
  });

  it("ends progress after the matching error render is acknowledged", () => {
    const protocol = new ChangesRenderProtocol();
    const loading = protocol.begin("loading");
    const error = { generation: loading.generation, renderState: "error" as const };

    expect(protocol.advance(error)).toBe(true);
    expect(protocol.acknowledge(error)).toBe(true);
    expect(protocol.isPending()).toBe(false);
  });

  it("rejects bootstrap that arrives after final for one generation", () => {
    expect(
      shouldApplyChangesRender(
        { generation: 7, renderState: "final" },
        { generation: 7, renderState: "bootstrap" },
      ),
    ).toBe(false);
    expect(
      shouldApplyChangesRender(
        { generation: 7, renderState: "final" },
        { generation: 8, renderState: "bootstrap" },
      ),
    ).toBe(true);
  });
});
