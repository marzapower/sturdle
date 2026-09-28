# @sturdle/ui

Design tokens and presentational React components for the Sturdle job console: status badges
and dots, the worker meter, the job timeline (one lane per attempt), step and log lists, the
fleet table, the activity chart, and the `SturdleMark` turtle mark.

Every component takes its data via props — no data fetching, no router, no query library — so
the package works in any React 19 host (Next.js, Vite, Remix). Styling is Tailwind v4,
CSS-first: import the tokens once and the utilities the components use resolve against them.

## Install

```bash
npm i @sturdle/ui react react-dom
```

`react` and `react-dom` (≥ 19) are peer dependencies.

## Usage

```css
/* app/globals.css */
@import "tailwindcss";
@import "@sturdle/ui/styles/tokens.css";
```

```tsx
import { JobDetailTimeline, StatusBadge, SturdleMark } from "@sturdle/ui";

export function JobHeader({ status }: { status: "completed" | "failed" }) {
  return (
    <header>
      <SturdleMark size={28} />
      <StatusBadge status={status} />
    </header>
  );
}
```

Entry points:

| Import                          | What it is                                                   |
| ------------------------------- | ------------------------------------------------------------ |
| `@sturdle/ui`                   | Every component, helper and view-model type                  |
| `@sturdle/ui/mark`              | `SturdleMark` alone (no chart dependency pulled in)          |
| `@sturdle/ui/mark-geometry`     | The mark's paths and palette (`shellPath`, `MARK_COLORS`, …) |
| `@sturdle/ui/styles/tokens.css` | The console tokens: one dark palette, `plume` as the accent  |

Components that need browser APIs (`ActivityChart`, `JobDetailTimeline`, `LiveText`, …) carry
the `"use client"` directive, so they can be imported from React Server Components directly.

## The console register

The tokens are deliberately monochrome: `ink` surfaces, `sand` text, one teal accent (`plume`),
and colour only where a job deviates from its normal course (`amber`, `carmine`, `moss`). There
is a single dark theme; the tokens are identical under `:root` and `.dark`. Keep it that way when
you embed the components: they are meant to read as instrument panels, not as a marketing page.

## Development

```bash
pnpm --filter @sturdle/ui typecheck
pnpm --filter @sturdle/ui build      # ESM + .d.ts into dist/, styles/ ships as-is
```

The components are exercised by the unit tests of their helpers (`src/lib/*.test.ts`).
