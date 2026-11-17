"use strict";

window.ProductIdentification = (() => {
  const el = id => document.getElementById(id);
  const base = "/api/admin/product-identification";
  const form = el("productChooser");
  const search = el("dictionarySearch");
  const select = el("dictionaryChoice");
  const status = el("dictionaryStatus");
  const save = el("saveProductMatch");
  const more = el("dictionaryMore");
  const refresh = el("refreshIdentification");
  const message = el("identificationMessage");
  const choices = new Map();
  let editing = null;
  let opener = null;
  let sequence = 0;
  let nextPage = null;
  let query = "";
  let timer;

  async function request(path, options) {
    const response = await fetch(base + path, { cache: "no-store", ...options });
    if (response.status === 401) throw new Error("Your session expired. Sign in again to continue.");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Unable to complete this request.");
    return body;
  }

  function clearChoices() {
    choices.clear();
    nextPage = null;
    select.replaceChildren(new Option("Choose a product…", ""));
    el("dictionaryResults").hidden = true;
    more.hidden = true;
    save.disabled = true;
    el("dictionaryReview").textContent = "";
  }

  function edit(product, button) {
    clearTimeout(timer);
    editing = product;
    opener = button;
    sequence++;
    clearChoices();
    status.textContent = "";
    el("chooserTitle").textContent = "Choose product for " + product.name;
    search.value = product.name;
    button.closest(".identification-entry").after(form);
    form.hidden = false;
    search.focus();
    search.select();
  }

  function row(product) {
    const entry = document.createElement("div");
    entry.className = "identification-entry";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = product.name;
    const detail = document.createElement("small");
    detail.textContent = product.family ? product.publisher + " · " + product.family : product.publisher;
    info.append(title, detail);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "admin-edit-button";
    button.textContent = product.family ? "Change match" : "Choose product";
    button.addEventListener("click", () => edit(product, button));
    entry.append(info, button);
    return entry;
  }

  function closeEditor() {
    sequence++;
    form.hidden = true;
    form.parentElement.closest(".identification-panel").append(form);
    editing = null;
    opener?.focus();
  }

  async function load(notice = "") {
    clearTimeout(timer);
    if (editing) closeEditor();
    refresh.disabled = true;
    try {
      const data = await request("/");
      if (editing) return;
      const unresolved = data.products.filter(p => p.unresolved);
      const mapped = data.products.filter(p => p.family);
      el("unresolvedProducts").replaceChildren(...unresolved.map(row));
      el("mappedProducts").replaceChildren(...mapped.map(row));
      el("savedMatches").hidden = !mapped.length;
      let summary = unresolved.length ? "" : "No products currently flagged.";
      if (data.pending) summary += " Awaiting identification checks: " + data.pending + ".";
      if (data.scanning) summary += " Scan in progress.";
      message.textContent = [notice, summary.trim()].filter(Boolean).join(" ");
      if (data.scanning && !editing) timer = setTimeout(() => load(), 10000);
    } catch (error) {
      message.textContent = [notice, error.message].filter(Boolean).join(" ");
    } finally {
      refresh.disabled = false;
    }
  }

  async function findChoices(append) {
    const generation = ++sequence;
    if (!append) {
      query = search.value.trim();
      clearChoices();
    }
    more.hidden = true;
    status.textContent = "Searching the NVD dictionary…";
    try {
      const params = new URLSearchParams({ q: query, start: append ? nextPage : 0 });
      const data = await request("/search?" + params);
      if (sequence !== generation) return;
      for (const candidate of data.choices) {
        if (choices.has(candidate.family)) continue;
        choices.set(candidate.family, candidate);
        select.add(new Option(candidate.publisher + " / " + candidate.name, candidate.family));
      }
      nextPage = data.next;
      el("dictionaryResults").hidden = !choices.size;
      status.textContent = choices.size ? "Review the publisher and product before saving." : "No active application found in these results.";
    } catch (error) {
      if (sequence !== generation) return;
      status.textContent = error.message;
    }
    more.hidden = nextPage === null;
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    findChoices(false);
  });
  search.addEventListener("input", () => {
    sequence++;
    clearChoices();
    status.textContent = "";
  });
  more.addEventListener("click", () => findChoices(true));
  select.addEventListener("change", () => {
    const choice = choices.get(select.value);
    save.disabled = !choice;
    el("dictionaryReview").textContent = choice
      ? editing.name + " will use " + choice.publisher + " / " + choice.name + " for all its recorded versions."
      : "";
  });
  el("cancelProductMatch").addEventListener("click", closeEditor);
  refresh.addEventListener("click", () => load());
  save.addEventListener("click", async () => {
    const choice = choices.get(select.value);
    if (!choice || !editing) return;
    const product = editing;
    sequence++;
    form.inert = true;
    refresh.disabled = true;
    const rows = document.querySelectorAll(".identification-entry button");
    rows.forEach(button => { button.disabled = true; });
    status.textContent = "Verifying and saving the match…";
    try {
      await request("/" + product.id, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choiceId: choice.id, family: choice.family, previousFamily: product.family,
          name: product.name, publisher: product.publisher })
      });
      await load("Match saved for " + product.name + ". Security Watch will use it the next time it scans this title.");
      refresh.focus();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      form.inert = false;
      refresh.disabled = false;
      rows.forEach(button => { button.disabled = false; });
    }
  });
  return { load };
})();
