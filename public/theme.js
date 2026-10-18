// Applies the theme chosen in this browser before the app loads, so dark
// mode never starts with a white flash. Same key and values as
// src/state/theme.ts; "system" (or nothing) leaves it to the OS.
try {
  const theme = window.localStorage.getItem("a0.theme");
  if (theme === "light" || theme === "dark")
    document.documentElement.setAttribute("data-theme", theme);
} catch {
  // Storage can be blocked; then the OS setting applies.
}
