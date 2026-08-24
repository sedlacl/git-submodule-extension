export type ChangesRenderState = "loading" | "bootstrap" | "final" | "error";

const RENDER_STATE_RANK: Record<ChangesRenderState, number> = {
  loading: 0,
  bootstrap: 1,
  final: 2,
  error: 2,
};

export interface ChangesRenderVersion {
  generation: number;
  renderState: ChangesRenderState;
}

/** Shared generation/phase gate for provider progress and webview rendering. */
export class ChangesRenderProtocol {
  private current: ChangesRenderVersion = { generation: 0, renderState: "loading" };
  private pending = false;

  begin(renderState: "loading" | "bootstrap"): ChangesRenderVersion {
    this.current = { generation: this.current.generation + 1, renderState };
    this.pending = true;
    return this.version();
  }

  advance(version: ChangesRenderVersion): boolean {
    if (!this.canApply(version)) {
      return false;
    }
    this.current = { ...version };
    return true;
  }

  acknowledge(version: ChangesRenderVersion): boolean {
    if (
      !this.pending ||
      version.generation !== this.current.generation ||
      version.renderState !== this.current.renderState ||
      (version.renderState !== "final" && version.renderState !== "error")
    ) {
      return false;
    }
    this.pending = false;
    return true;
  }

  isCurrent(generation: number): boolean {
    return generation === this.current.generation;
  }

  isPending(): boolean {
    return this.pending;
  }

  version(): ChangesRenderVersion {
    return { ...this.current };
  }

  private canApply(version: ChangesRenderVersion): boolean {
    if (version.generation !== this.current.generation) {
      return false;
    }
    return RENDER_STATE_RANK[version.renderState] >= RENDER_STATE_RANK[this.current.renderState];
  }
}

export function shouldApplyChangesRender(
  current: ChangesRenderVersion,
  incoming: ChangesRenderVersion,
): boolean {
  return (
    incoming.generation > current.generation ||
    (incoming.generation === current.generation &&
      RENDER_STATE_RANK[incoming.renderState] >= RENDER_STATE_RANK[current.renderState])
  );
}
