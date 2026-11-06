
const sidebar = document.getElementById("sidebar");
const overlay = document.getElementById("sidebarOverlay");
const toggle = document.getElementById("menuToggle");
const navLinks = document.querySelectorAll(".nav-link");


function closeMenu() {
  if (!sidebar || !overlay || !toggle) return;

  sidebar.classList.remove("open");
  overlay.classList.remove("visible");

  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Open navigation");
}



if (sidebar && overlay && toggle) {
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
}


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
  const statusFilter =
    document.getElementById("statusFilter");

  if (statusFilter) {
    statusFilter.value = "All";
    statusFilter.dispatchEvent(
      new Event("change")
    );
  }
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

  
if (themeIcon) {
  themeIcon.textContent = isDark ? "☀️" : "🌙";
}

if (themeLabel) {
  themeLabel.textContent =
    isDark ? "Light Mode" : "Dark Mode";
}

if (themeToggle) {
  themeToggle.setAttribute(
    "aria-label",
    isDark ? "Switch to light mode" : "Switch to dark mode"
  );

  themeToggle.setAttribute(
    "aria-pressed",
    String(isDark)
  );
}

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


if (themeToggle) {
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
}



const lightModeBtn = document.getElementById("lightModeBtn");
const darkModeBtn = document.getElementById("darkModeBtn");

function updateAppearanceButtons() {
  const isDark = document.documentElement.classList.contains("dark-mode");

  if (lightModeBtn) {
    lightModeBtn.setAttribute("aria-pressed", String(!isDark));
  }

  if (darkModeBtn) {
    darkModeBtn.setAttribute("aria-pressed", String(isDark));
  }
}

function saveAppearanceTheme(theme) {
  applyTheme(theme);

  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch (error) {
    console.warn("Could not save theme preference:", error);
  }

  updateAppearanceButtons();
}

if (lightModeBtn) {
  lightModeBtn.addEventListener("click", () => {
    saveAppearanceTheme("light");
  });
}

if (darkModeBtn) {
  darkModeBtn.addEventListener("click", () => {
    saveAppearanceTheme("dark");
  });
}

updateAppearanceButtons();
