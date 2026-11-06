
const sidebar = document.getElementById("sidebar");
const overlay = document.getElementById("sidebarOverlay");
const toggle = document.getElementById("menuToggle");
const navLinks = document.querySelectorAll(".nav-link");

function closeMenu() {
  sidebar.classList.remove("open");
  overlay.classList.remove("visible");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Open navigation");
}

toggle.addEventListener("click", () => {
  const isOpen = sidebar.classList.toggle("open");
  overlay.classList.toggle("visible", isOpen);
  toggle.setAttribute("aria-expanded", String(isOpen));
  toggle.setAttribute(
    "aria-label",
    isOpen ? "Close navigation" : "Open navigation"
  );
});

overlay.addEventListener("click", closeMenu);

document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeMenu();
});

navLinks.forEach(link => {
  link.addEventListener("click", event => {
    const page = link.dataset.page;

    if (page === "pending") {
      event.preventDefault();
      document.getElementById("statusFilter").value =
        "Pending";
      document.getElementById("statusFilter")
        .dispatchEvent(new Event("change"));
      document.getElementById("inventory")
        .scrollIntoView({ behavior: "smooth" });
    } else if (page === "inventory") {
      document.getElementById("statusFilter").value =
        "All";
      document.getElementById("statusFilter")
        .dispatchEvent(new Event("change"));
    }

    navLinks.forEach(item =>
      item.classList.toggle("active", item === link)
    );

    closeMenu();
  });
});

// ===== Light / Dark Mode =====

const themeToggle = document.getElementById("themeToggle");
const themeIcon = document.getElementById("themeIcon");
const themeLabel = document.getElementById("themeLabel");

const THEME_KEY = "softTrackTheme";

function applyTheme(theme) {
  const isDark = theme === "dark";

  document.documentElement.classList.toggle(
    "dark-mode",
    isDark
  );

  themeIcon.textContent = isDark ? "☀️" : "🌙";
  themeLabel.textContent = isDark ? "Light Mode" : "Dark Mode";

  themeToggle.setAttribute(
    "aria-label",
    isDark ? "Switch to light mode" : "Switch to dark mode"
  );
  themeToggle.setAttribute("aria-pressed", String(isDark));
}

let savedTheme = null;

try {
  savedTheme = localStorage.getItem(THEME_KEY);
} catch (error) {
  console.warn("Theme preference unavailable:", error);
}

const systemPrefersDark = window.matchMedia(
  "(prefers-color-scheme: dark)"
).matches;

applyTheme(
  savedTheme === "dark" || savedTheme === "light"
    ? savedTheme
    : systemPrefersDark ? "dark" : "light"
);

themeToggle.addEventListener("click", () => {
  const isDark = document.documentElement.classList
    .contains("dark-mode");

  const nextTheme = isDark ? "light" : "dark";

  applyTheme(nextTheme);

  try {
    localStorage.setItem(THEME_KEY, nextTheme);
  } catch (error) {
    console.warn("Could not save theme preference:", error);
  }
});
