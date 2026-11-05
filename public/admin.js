
const adminEmail = document.getElementById("adminEmail");
const logoutButton = document.getElementById("logoutButton");

async function loadAdmin() {
  try {
    const response = await fetch("/api/admin/me", {
      credentials: "same-origin",
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("Unable to verify session");
    }

    const result = await response.json();

    if (!result.authenticated) {
      window.location.replace("/login.html");
      return;
    }

    adminEmail.textContent =
      `Signed in as: ${result.email}`;
  } catch {
    adminEmail.textContent =
      "Unable to verify administrator session.";
    logoutButton.disabled = true;
  }
}

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;

  try {
    const response = await fetch("/api/admin/logout", {
      method: "POST",
      credentials: "same-origin"
    });

    if (!response.ok) {
      throw new Error("Logout failed");
    }

    window.location.replace("/login.html");
  } catch {
    logoutButton.disabled = false;
    alert("Unable to sign out. Please try again.");
  }
});

loadAdmin();
