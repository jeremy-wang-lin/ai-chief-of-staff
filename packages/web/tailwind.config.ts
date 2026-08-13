import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: { mono: "var(--mono)" },
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        surface2: "var(--surface2)",
        sunk: "var(--sunk)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        line: "var(--line)",
        line2: "var(--line2)",
        accent: "var(--accent)",
        "accent-soft": "var(--accent-soft)",
        ai: "var(--ai)",
        "ai-soft": "var(--ai-soft)",
        warn: "var(--warn)",
        "warn-soft": "var(--warn-soft)",
        danger: "var(--danger)",
        "danger-soft": "var(--danger-soft)",
      },
    },
  },
} satisfies Config;
