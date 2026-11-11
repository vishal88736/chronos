"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import clsx from "clsx";

type Theme = "dark" | "light";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const current = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    setTheme(current);
  }, []);

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem("chronos-theme", next);
    } catch {
      // Private browsing can reject localStorage; the active theme still applies.
    }
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    themeMeta?.setAttribute("content", next === "light" ? "#F6F7FB" : "#090A0F");
  }

  const target = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="group flex h-7 w-7 items-center justify-center rounded-full border border-tint/[0.08] bg-tint/[0.025] text-muted transition-all duration-200 hover:border-tint/[0.16] hover:bg-tint/[0.06] hover:text-ink"
      aria-label={`Switch to ${target} theme`}
      title={`Switch to ${target} theme`}
    >
      <span className="relative flex h-[13px] w-[13px] items-center justify-center">
        <Sun
          size={13}
          strokeWidth={1.9}
          className={clsx(
            "absolute transition-all duration-300",
            theme === "dark" ? "rotate-0 scale-100 text-healing" : "-rotate-90 scale-50 opacity-0",
          )}
        />
        <Moon
          size={12.5}
          strokeWidth={1.9}
          className={clsx(
            "absolute transition-all duration-300",
            theme === "light" ? "rotate-0 scale-100 text-accent-fg" : "rotate-90 scale-50 opacity-0",
          )}
        />
      </span>
    </button>
  );
}
