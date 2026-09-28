/**
 * Pure geometry for the Sturdle mark (`SturdleMark`): a turtle seen from above. The carapace is
 * an oval with seven hexagonal scutes (a central column of three, two on each side), the head
 * points up, four flippers reach out at the diagonals, a short tail closes the bottom. Every
 * number here is in the mark's own 120×120 box; the component adds the motion with CSS.
 */

export const MARK_VIEWBOX = { width: 120, height: 120 } as const;

/** The centre of the carapace; scutes and flippers are placed relative to it. */
export const SHELL_CENTER = { x: 60, y: 67 } as const;

/** The mark's own colours, raw hex because they are SVG attributes (see DESIGN.md, "Mark"). */
export const MARK_COLORS = {
  shellDeep: "#1E3D30",
  shell: "#2F5A45",
  scute: "#3F8C69",
  rim: "#8A6A34",
  skin: "#2446C0",
  skinDeep: "#15297A",
  eye: "#1FC8B4",
} as const;

export interface Scute {
  cx: number;
  cy: number;
  r: number;
}

/** The seven scutes: the central column first, then the left and right pairs. */
export const SCUTES: readonly Scute[] = [
  { cx: 60, cy: 44, r: 13 },
  { cx: 60, cy: 67, r: 13 },
  { cx: 60, cy: 90, r: 13 },
  { cx: 39, cy: 55, r: 11 },
  { cx: 39, cy: 79, r: 11 },
  { cx: 81, cy: 55, r: 11 },
  { cx: 81, cy: 79, r: 11 },
];

export interface Flipper {
  /** Where the flipper joins the shell. */
  x: number;
  y: number;
  /** Rest rotation in degrees; the flipper is drawn along +x before rotating. */
  angle: number;
  /** Which end is the joint, so the CSS reach scales from it. */
  joint: "start" | "end";
}

/** Front left, front right, hind left, hind right. */
export const FLIPPERS: readonly Flipper[] = [
  { x: 34, y: 42, angle: -140, joint: "start" },
  { x: 86, y: 42, angle: -40, joint: "start" },
  { x: 34, y: 94, angle: 140, joint: "start" },
  { x: 86, y: 94, angle: 40, joint: "start" },
];

export const FLIPPER_SIZE = { length: 22, width: 7.5 } as const;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Outline of the carapace (SVG path d): an oval, slightly fuller at the top. */
export function shellPath(): string {
  return (
    "M60 25 C 83 25, 98 44, 98 67 C 98 91, 83 110, 60 110 " +
    "C 37 110, 22 91, 22 67 C 22 44, 37 25, 60 25 Z"
  );
}

/** A pointy-top regular hexagon (SVG path d) of circumradius `r` around (`cx`, `cy`). */
export function hexagonPath({ cx, cy, r }: Scute): string {
  const points = Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 180) * (60 * i - 90);
    return `${round2(cx + r * Math.cos(angle))} ${round2(cy + r * Math.sin(angle))}`;
  });
  return `M${points.join(" L")} Z`;
}

/** The six vertices of `hexagonPath`, for tests and for callers that need them as numbers. */
export function hexagonVertices({ cx, cy, r }: Scute): { x: number; y: number }[] {
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 180) * (60 * i - 90);
    return { x: round2(cx + r * Math.cos(angle)), y: round2(cy + r * Math.sin(angle)) };
  });
}

/** Whether a point lies inside the carapace oval (used to keep every scute on the shell). */
export function insideShell(x: number, y: number): boolean {
  const rx = 38;
  const ry = 42.5;
  const dx = (x - SHELL_CENTER.x) / rx;
  const dy = (y - SHELL_CENTER.y) / ry;
  return dx * dx + dy * dy <= 1;
}

/** The head as an SVG path d, pointing up from the shell's top edge. */
export function headPath(): string {
  return "M50 30 L50 18 C 50 11.5, 54.5 7, 60 7 C 65.5 7, 70 11.5, 70 18 L70 30 Z";
}

/** The tail as an SVG path d, hanging from the shell's bottom edge. */
export function tailPath(): string {
  return "M55 106 L60 118 L65 106 Z";
}
