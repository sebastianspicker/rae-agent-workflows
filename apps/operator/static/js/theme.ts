/** Controls the Operator's local, presentation-only color theme. */

const storageKey = "rae-operator-theme";

type OperatorTheme = "light" | "dark";

function storedTheme(): OperatorTheme | null {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* A blocked storage area must not block the interface. */
  }
  return null;
}

function systemTheme(): OperatorTheme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The theme in effect: a stored choice, otherwise the operating system's live preference. */
function effectiveTheme(): OperatorTheme {
  const forced = document.documentElement.dataset.theme;
  if (forced === "light" || forced === "dark") return forced;
  return systemTheme();
}

/**
 * Reflects the effective theme on the toggle. The label stays "Dark theme" and aria-pressed
 * carries the state, so the control never announces a contradiction.
 */
function syncToggle(toggle: HTMLElement): void {
  const theme = effectiveTheme();
  toggle.setAttribute("aria-pressed", String(theme === "dark"));
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0e171c" : "#f2f5f6");
}

export function bindThemeToggle(): void {
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;
  toggle.setAttribute("aria-label", "Dark theme");
  // Only a stored choice pins the theme; without one the CSS media query follows the OS live.
  const saved = storedTheme();
  if (saved) document.documentElement.dataset.theme = saved;
  syncToggle(toggle);
  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener?.("change", () => syncToggle(toggle));
  toggle.addEventListener("click", () => {
    const theme: OperatorTheme = effectiveTheme() === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(storageKey, theme);
    } catch {
      /* The selected theme still applies for this session. */
    }
    document.documentElement.dataset.theme = theme;
    syncToggle(toggle);
  });
}
