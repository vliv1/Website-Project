


const loginForm = document.getElementById("loginForm");
const loginButton = document.getElementById("loginButton");
const errorMessage = document.getElementById("errorMessage");

loginForm.addEventListener("submit", async event => {
  event.preventDefault();

  errorMessage.textContent = "";
  loginButton.disabled = true;
  loginButton.textContent = "Signing in...";

  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;

  try {
    const response = await fetch("/api/admin/login", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result.error || "Unable to sign in"
      );
    }

    window.location.assign("/admin");
  } catch (error) {
    errorMessage.textContent = error.message;
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = "Sign In";
  }
});
