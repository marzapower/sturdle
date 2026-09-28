import { describe, expect, it } from "vitest";

import {
  FLIPPERS,
  hexagonPath,
  hexagonVertices,
  insideShell,
  MARK_VIEWBOX,
  SCUTES,
  SHELL_CENTER,
  shellPath,
} from "./sturdle-mark.js";

describe("hexagonPath", () => {
  it("draws six vertices and closes", () => {
    const d = hexagonPath({ cx: 60, cy: 60, r: 10 });
    expect(d.match(/L/g)).toHaveLength(5);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
  });

  it("is pointy-top: the first vertex sits straight above the centre", () => {
    const [top] = hexagonVertices({ cx: 60, cy: 60, r: 10 });
    expect(top).toEqual({ x: 60, y: 50 });
  });

  it("keeps every vertex at distance r from the centre", () => {
    for (const { x, y } of hexagonVertices({ cx: 30, cy: 40, r: 12 })) {
      expect(Math.hypot(x - 30, y - 40)).toBeCloseTo(12, 1);
    }
  });
});

describe("SCUTES", () => {
  it("has a central column of three and two pairs at the sides", () => {
    const central = SCUTES.filter((s) => s.cx === SHELL_CENTER.x);
    expect(central).toHaveLength(3);
    expect(SCUTES).toHaveLength(7);
  });

  it("is symmetric around the shell's vertical axis", () => {
    for (const scute of SCUTES) {
      const mirrored = SCUTES.find(
        (s) => s.cy === scute.cy && s.r === scute.r && s.cx === 2 * SHELL_CENTER.x - scute.cx,
      );
      expect(mirrored).toBeDefined();
    }
  });

  it("keeps every scute vertex on the carapace", () => {
    for (const scute of SCUTES) {
      for (const { x, y } of hexagonVertices(scute)) {
        expect(insideShell(x, y)).toBe(true);
      }
    }
  });
});

describe("FLIPPERS and shell", () => {
  it("places four flippers, mirrored left and right", () => {
    expect(FLIPPERS).toHaveLength(4);
    // Mirroring across the vertical axis maps a rotation of a degrees onto 180 - a.
    const norm = (deg: number) => ((deg % 360) + 360) % 360;
    for (const flipper of FLIPPERS) {
      const mirrored = FLIPPERS.find(
        (f) =>
          f.y === flipper.y &&
          f.x === 2 * SHELL_CENTER.x - flipper.x &&
          norm(f.angle) === norm(180 - flipper.angle),
      );
      expect(mirrored).toBeDefined();
    }
  });

  it("keeps the carapace inside the mark's box", () => {
    const numbers =
      shellPath()
        .match(/-?\d+(\.\d+)?/g)
        ?.map(Number) ?? [];
    for (const n of numbers) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(MARK_VIEWBOX.height);
    }
  });
});
