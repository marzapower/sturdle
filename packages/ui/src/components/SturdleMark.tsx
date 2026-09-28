"use client";

import type * as React from "react";
import { useEffect, useRef, useState } from "react";

import {
  FLIPPER_SIZE,
  FLIPPERS,
  headPath,
  hexagonPath,
  MARK_COLORS,
  MARK_VIEWBOX,
  SCUTES,
  shellPath,
  tailPath,
} from "../lib/sturdle-mark.js";

// The Sturdle mark: a turtle from above. It waits tucked in its shell until it scrolls into
// view, then head, flippers and tail come out once and settle. It is the only figurative
// drawing this package ships — see tokens.css for the `.sturdle-mark*` CSS it needs.

type MarkState = "tucked" | "out" | "rest" | "nod";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function Limbs() {
  return (
    <g fill={MARK_COLORS.skin}>
      {FLIPPERS.map((flipper, index) => (
        <g key={index} transform={`translate(${flipper.x} ${flipper.y}) rotate(${flipper.angle})`}>
          <ellipse
            className="sturdle-mark__limb"
            cx={FLIPPER_SIZE.length / 2}
            cy={0}
            rx={FLIPPER_SIZE.length / 2}
            ry={FLIPPER_SIZE.width / 2}
          />
        </g>
      ))}
      <path className="sturdle-mark__tail" d={tailPath()} />
    </g>
  );
}

function Head() {
  return (
    <g className="sturdle-mark__head">
      <path d={headPath()} fill={MARK_COLORS.skin} />
      <path d="M50 30 L50 26 L70 26 L70 30 Z" fill={MARK_COLORS.skinDeep} />
      <circle cx={55.5} cy={15} r={1.9} fill={MARK_COLORS.eye} />
      <circle cx={64.5} cy={15} r={1.9} fill={MARK_COLORS.eye} />
    </g>
  );
}

function Shell() {
  return (
    <g>
      <path d={shellPath()} fill={MARK_COLORS.shellDeep} />
      {SCUTES.map((scute, index) => (
        <path
          key={index}
          d={hexagonPath(scute)}
          fill={MARK_COLORS.shell}
          stroke={MARK_COLORS.scute}
          strokeWidth={1.4}
          strokeLinejoin="round"
        />
      ))}
      <path d={shellPath()} fill="none" stroke={MARK_COLORS.rim} strokeWidth={3} />
    </g>
  );
}

export interface SturdleMarkProps {
  className?: string;
  threshold?: number;
}

export function SturdleMark({ className, threshold = 0.5 }: SturdleMarkProps): React.JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const [state, setState] = useState<MarkState>("tucked");

  // Tucked until `threshold` of the SVG is on screen (half by default), then it comes out once
  // after a short beat. No fallback for a missing IntersectionObserver: that would need a
  // synchronous setState in the effect body, so an unsupported browser simply stays tucked.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !("IntersectionObserver" in window)) return;

    let timeoutId: number | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        timeoutId = window.setTimeout(() => {
          // Reduced motion: settle straight into rest — the "out" animation would never fire
          // `animationend` if it's disabled, so the turtle would stay tucked forever.
          setState(prefersReducedMotion() ? "rest" : "out");
        }, 150);
      },
      { threshold },
    );
    observer.observe(svg);

    return () => {
      observer.disconnect();
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [threshold]);

  const handleAnimationEnd = (event: React.AnimationEvent<SVGSVGElement>) => {
    if (event.target !== event.currentTarget) return;
    setState("rest");
  };

  const handleMouseEnter = () => {
    if (state !== "rest" || prefersReducedMotion()) return;
    setState("nod");
  };

  const stateClass =
    state === "tucked" || state === "out" || state === "nod" ? ` sturdle-mark--${state}` : "";

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${MARK_VIEWBOX.width} ${MARK_VIEWBOX.height}`}
      width={MARK_VIEWBOX.width}
      height={MARK_VIEWBOX.height}
      aria-hidden="true"
      className={`sturdle-mark${stateClass}${className ? ` ${className}` : ""}`}
      onAnimationEnd={handleAnimationEnd}
      onMouseEnter={handleMouseEnter}
    >
      <Limbs />
      <Head />
      <Shell />
    </svg>
  );
}
