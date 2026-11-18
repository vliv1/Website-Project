"use strict";

window.AdminUsers = (() => {
  const form = document.getElementById("createAdminUser");
  const email = document.getElementById("newAdminEmail");
  const password = document.getElementById("newAdminPassword");
  const confirm = document.getElementById("confirmAdminPassword");
  const submit = document.getElementById("createAdminUserButton");
  const refresh = document.getElementById("refreshAdminUsers");
  const message = document.getElementById("adminUserMessage");
  const listMessage = document.getElementById("adminUsersListMessage");
  const list = document.getElementById("adminUsersList");
  let busy = false;

  async function request(options) {
    const response = await fetch("/api/admin/users", {
      credentials: "same-origin", cache: "no-store", ...options
    });
    if (response.status === 401) throw new Error("Your session expired. Sign in again to continue.");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to complete the request.");
    return data;
  }

  async function load() {
    refresh.disabled = true;
    listMessage.textContent = "Loading administrator accounts…";
    try {
      const users = await request();
      if (!Array.isArray(users)) throw new Error("Unable to load administrator accounts.");
      list.replaceChildren();
      for (const user of users) {
        const item = document.createElement("li");
        const name = document.createElement("strong");
        name.textContent = user.email;
        const created = document.createElement("span");
        const date = new Date(user.created_at);
        created.textContent = Number.isNaN(date.getTime()) ? "" : "Created " + date.toLocaleDateString();
        item.append(name, created);
        list.appendChild(item);
      }
      listMessage.textContent = users.length + (users.length === 1 ? " administrator" : " administrators");
    } catch (error) {
      listMessage.textContent = error.message;
    } finally {
      refresh.disabled = busy;
    }
  }

  refresh.addEventListener("click", load);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    if (password.value !== confirm.value) {
      message.textContent = "The passwords do not match.";
      confirm.focus();
      return;
    }
    busy = true;
    submit.disabled = true;
    refresh.disabled = true;
    form.inert = true;
    message.textContent = "Creating administrator…";
    try {
      const created = await request({
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.value, password: password.value, confirmPassword: confirm.value })
      });
      form.reset();
      message.textContent = "Administrator created for " + created.email + ". They can now sign in to the admin dashboard.";
      await load();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      password.value = "";
      confirm.value = "";
      busy = false;
      form.inert = false;
      submit.disabled = false;
      refresh.disabled = false;
    }
  });
  return { load };
})();
