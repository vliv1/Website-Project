"use strict";

(() => {
  const sidebar = document.getElementById("adminSidebar");
  const toggle = document.getElementById("adminMenuToggle");
  const overlay = document.getElementById("adminSidebarOverlay");
  const mobile = window.matchMedia("(max-width: 900px)");
  let open = false;

  function setOpen(value, restoreFocus = false) {
    open = mobile.matches && value;
    sidebar.classList.toggle("open", open);
    overlay.classList.toggle("visible", open);
    sidebar.inert = mobile.matches && !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    if (restoreFocus) toggle.focus();
  }

  toggle.addEventListener("click", () => {
    setOpen(!open);
    if (open) sidebar.querySelector("a")?.focus();
  });
  overlay.addEventListener("click", () => setOpen(false, true));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && open) setOpen(false, true);
  });
  sidebar.querySelectorAll("a").forEach(link => {
    link.addEventListener("click", () => setOpen(false));
  });
  mobile.addEventListener("change", () => setOpen(false));
  setOpen(false);
})();
