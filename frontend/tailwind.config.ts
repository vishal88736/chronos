import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: "#090A0F",
        surface: "#11131A",
        panel: "#0C0E14",
        elevated: "#151822",
        ink: "#E8EAF2",
        muted: "#8D93A6",
        faint: "#5C6275",
        accent: "#6366F1",
        cached: "#06B6D4",
        healing: "#F59E0B",
        healthy: "#10B981",
        danger: "#F43F5E",
        hairline: "rgba(255,255,255,0.08)",
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
        mono: [
          "JetBrains Mono Variable",
          "JetBrains Mono",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      boxShadow: {
        glass: "0 24px 80px rgba(0, 0, 0, 0.52), 0 2px 8px rgba(0, 0, 0, 0.32)",
        "glow-accent": "0 0 32px rgba(99, 102, 241, 0.24)",
        "glow-cyan": "0 0 24px rgba(6, 182, 212, 0.18)",
      },
      backgroundImage: {
        "dot-grid":
          "radial-gradient(rgba(255,255,255,0.055) 0.7px, transparent 0.7px)",
      },
      animation: {
        "fade-up": "fade-up 420ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "fade-in": "fade-in 320ms ease-out both",
        "pulse-soft": "pulse-soft 2.2s ease-in-out infinite",
        "sweep": "sweep 2.6s linear infinite",
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
