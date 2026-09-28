"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "../lib/cn.js";

export interface LiveTextProps {
  /** Current text. Every change runs the exit/enter swap (see `.live-text` in tokens.css). */
  text: string;
  className?: string;
}

// The enter phase must apply before paint, but React warns about useLayoutEffect during SSR.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const SWAP_MS = 150;

/**
 * A value that swaps in place when polling changes it, the old text leaving upwards with a touch
 * of blur and the new one entering from below. Used for the live numbers and status words the
 * dashboard refreshes in the background, so a change is noticed without a flash or a layout shift.
 */
export function LiveText({ text, className }: LiveTextProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);

  // Phase 1: exit the old text, then commit the new one after one swap duration.
  useEffect(() => {
    if (text === shown) return;
    const el = ref.current;
    if (!el) return;
    el.classList.add("is-exit");
    const timer = window.setTimeout(() => setShown(text), SWAP_MS);
    return () => window.clearTimeout(timer);
  }, [text, shown]);

  // Phases 2–3: jump below without a transition, force a reflow, then release into place.
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el?.classList.contains("is-exit")) return;
    el.classList.remove("is-exit");
    el.classList.add("is-enter-start");
    void el.offsetHeight;
    el.classList.remove("is-enter-start");
  }, [shown]);

  return (
    <span ref={ref} className={cn("live-text", className)}>
      {shown}
    </span>
  );
}
