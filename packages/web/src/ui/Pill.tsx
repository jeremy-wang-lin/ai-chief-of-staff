import type { ReactNode } from "react";

const TONES = {
  accent: "bg-accent-soft text-accent",
  ai: "bg-ai-soft text-ai",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  mute: "bg-surface2 text-muted",
} as const;

export type PillTone = keyof typeof TONES;

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2.5 text-[11.5px] font-semibold leading-relaxed ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function priorityTone(p: "P0" | "P1" | "P2" | "P3"): PillTone {
  return p === "P0" || p === "P1" ? "danger" : p === "P2" ? "warn" : "mute";
}
