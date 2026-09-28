import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Gotcha: `twMerge` does not know this package's custom `fontSize` keys (`text-figure`,
 * `text-md`) are sizes — it groups them into the same conflict bucket as text-colour
 * utilities (`text-sand-100`, `text-carmine`, …), so a size class and a colour class landing
 * in the *same* `cn()` call can silently drop one, with no warning. Keep size and colour on
 * different elements (or in two separate, un-merged class strings) wherever a custom
 * `text-*` size and a text colour meet — see `Figure` for the shape this forces.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
