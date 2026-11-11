import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: "rgb(var(--canvas) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        panel: "rgb(var(--panel) / <alpha-value>)",
        "panel-strong": "rgb(var(--panel-strong) / <alpha-value>)",
        elevated: "rgb(var(--elevated) / <alpha-value>)",
        field: "rgb(var(--field) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        "ink-strong": "rgb(var(--ink-strong) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        faint: "rgb(var(--faint) / <alpha-value>)",
        tint: "rgb(var(--tint) / <alpha-value>)",
        shade: "rgb(var(--shade) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        "accent-fg": "rgb(var(--accent-fg) / <alpha-value>)",
        cached: "rgb(var(--cached) / <alpha-value>)",
        "cached-fg": "rgb(var(--cached-fg) / <alpha-value>)",
        healing: "rgb(var(--healing) / <alpha-value>)",
        "healing-fg": "rgb(var(--healing-fg) / <alpha-value>)",
        healthy: "rgb(var(--healthy) / <alpha-value>)",
        "healthy-fg": "rgb(var(--healthy-fg) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
        "danger-fg": "rgb(var(--danger-fg) / <alpha-value>)",
        hairline: "rgb(var(--hairline) / 0.08)",
      },
      fontFamily: {
        sans: [
          "Inter Variable",
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "Helvetica Neue",
          "sans-serif",
        ],
        display: [
          "Iowan Old Style",
          "Palatino Linotype",
          "Palatino",
          "Book Antiqua",
          "Georgia",
          "ui-serif",
          "serif",
        ],
        mono: [
          "JetBrains Mono Variable",
          "JetBrains Mono",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      boxShadow: {
        glass:
          "0 24px 80px rgb(var(--shadow) / 0.52), 0 2px 8px rgb(var(--shadow) / 0.32)",
        "glow-accent": "0 0 32px rgb(var(--accent) / 0.24)",
        "glow-cyan": "0 0 24px rgb(var(--cached) / 0.18)",
      },
      backgroundImage: {
        "dot-grid":
          "radial-gradient(rgb(var(--grid-dot) / 0.055) 0.7px, transparent 0.7px)",
      },
      animation: {
        "fade-up": "fade-up 420ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "fade-in": "fade-in 320ms ease-out both",
        "pulse-soft": "pulse-soft 2.2s ease-in-out infinite",
        sweep: "sweep 2.6s linear infinite",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
        sweep: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(250%)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
