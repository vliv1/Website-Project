"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const SoftwareCSV = require("../public/software-csv");

// Exercise file selection and submission without using the real admin database.
function page(send = async () => ({ status: 201, ok: true })) {
  const elements = new Map(), requests = [];
  let refreshed = 0;
  function element() {
    return {
      children: [], handlers: {}, files: [], disabled: false,
      appendChild(child) { this.children.push(child); },
      replaceChildren() { this.children = []; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      setAttribute() {}, removeAttribute() {}
    };
  }
  const get = id => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../public/admin-import"), "utf8"), {
    SoftwareCSV,
    document: { getElementById: get, createElement: element },
    window: { addEventListener() {} },
    makeElement(tag, text) { return { ...element(), textContent: text }; },
    fetch: async (url, options) => { requests.push({ url, options }); return send(); },
    loadAdminInventory: async () => { refreshed++; },
    loadAuditHistory: async () => { refreshed++; }
  });
  return {
    get, requests, refreshed: () => refreshed,
    async select(text, name = "inventory.csv", size = 100) {
      get("csvFile").files = [{ name, size, text: async () => text }];
      await get("csvFile").handlers.change();
    },
    submit: () => get("csvImportForm").handlers.submit({ preventDefault() {} })
  };
}

test("invalid files disable import, clear an earlier preview, and never send data", async () => {
  const ui = page();
  await ui.select("name,publisher,version\nApp,Vendor,1");
  assert.equal(ui.get("csvImportButton").disabled, false);
  await ui.select("name,publisher,version\nApp,,1");
  assert.equal(ui.get("csvImportButton").disabled, true);
  assert.equal(ui.get("csvPreview").hidden, true);
  assert.equal(ui.get("csvErrors").hidden, false);
  await ui.submit();
  assert.equal(ui.requests.length, 0);
});

test("enforces file extension and size before allowing an import", async () => {
  const ui = page();
  await ui.select("name,publisher,version\nApp,Vendor,1", "file.xlsx");
  assert.match(ui.get("csvImportMessage").textContent, /\.csv extension/);
  await ui.select("name,publisher,version\nApp,Vendor,1", "file.csv", SoftwareCSV.MAX_BYTES + 1);
  assert.match(ui.get("csvImportMessage").textContent, /too large/);
  assert.equal(ui.get("csvImportButton").disabled, true);
});

test("renders CSV values as text, imports only after submission, and refreshes inventory/audit", async () => {
  const ui = page();
  await ui.select("name,publisher,version\n<script>alert(1)</script>,Vendor,001");
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.get("csvPreviewBody").children[0].children[1].textContent, "<script>alert(1)</script>");
  await ui.submit();
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].url, "/api/software");
  assert.equal(JSON.parse(ui.requests[0].options.body).version, "001");
  assert.equal(ui.refreshed(), 2);
  assert.match(ui.get("csvImportMessage").textContent, /Import complete. 1 imported/);
  assert.equal(ui.get("csvImportButton").disabled, true);
  assert.equal(ui.get("csvFile").disabled, false);
});

test("pauses and retries remaining rows after a failed request", async () => {
  let call = 0;
  const ui = page(async () => {
    if (++call === 2) throw new Error("Disconnected");
    return { status: 201, ok: true };
  });
  await ui.select("name,publisher,version\nApp,Vendor,1\nApp,Vendor,2");
  await ui.submit();
  assert.match(ui.get("csvImportMessage").textContent, /Import paused. 1 imported/);
  assert.equal(ui.get("csvImportButton").disabled, false);
  assert.match(ui.get("csvImportButton").textContent, /Retry 1/);
  await ui.submit();
  assert.equal(ui.requests.length, 3);
  assert.equal(JSON.parse(ui.requests[2].options.body).version, "2");
  assert.match(ui.get("csvImportMessage").textContent, /Import complete/);
});
