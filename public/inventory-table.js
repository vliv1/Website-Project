"use strict";

(function (root) {
  const columns = [["name", "Software"], ["publisher", "Publisher"], ["number", "Version"], ["status", "Status"]];
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

  function select(inventory, { query = "", status = "All", sort = "name", direction = "asc", page = 1, pageSize = 25 } = {}) {
    const needle = query.trim().toLowerCase();
    const allRows = inventory.flatMap(software => {
      const versions = software.versions || [];
      return (versions.length ? versions : [null]).map(version => ({
        software, version, name: software.name, publisher: software.publisher,
        number: version ? String(version.number) : "", status: version?.status || ""
      }));
    });
    const rows = allRows.filter(row =>
      (status === "All" || row.status === status) &&
      (!needle || [row.name, row.publisher, row.number].some(value => value.toLowerCase().includes(needle)))
    );
    const key = columns.some(([key]) => key === sort) ? sort : "name";
    const sign = direction === "desc" ? -1 : 1;
    rows.sort((a, b) => {
      // Empty software groups always follow populated values for this column.
      if (!a[key] && b[key]) return 1;
      if (a[key] && !b[key]) return -1;
      return sign * collator.compare(a[key], b[key]) ||
        collator.compare(a.name, b.name) || collator.compare(a.publisher, b.publisher) ||
        collator.compare(a.number, b.number) ||
        collator.compare(String(a.software.id), String(b.software.id)) ||
        collator.compare(String(a.version?.id || ""), String(b.version?.id || ""));
    });
    const size = [25, 50, 100].includes(Number(pageSize)) ? Number(pageSize) : 25;
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const currentPage = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
    const start = (currentPage - 1) * size;
    return { rows, visible: rows.slice(start, start + size), page: currentPage, pages, pageSize: size,
      total: rows.length, totalUnfiltered: allRows.length, start: rows.length ? start + 1 : 0,
      end: Math.min(start + size, rows.length) };
  }

  function create({ container, createDetails }) {
    const doc = container.ownerDocument;
    const state = { query: "", status: "All", sort: "name", direction: "asc", page: 1, pageSize: 25 };
    let inventory = [], error = "", result, openDetail = null;
    function element(tag, text = "", className = "") {
      const node = doc.createElement(tag);
      node.textContent = text;
      if (className) node.className = className;
      return node;
    }
    function button(text, action) {
      const node = element("button", text);
      node.type = "button";
      node.addEventListener("click", action);
      return node;
    }
    container.classList.add("inventory-grid");
    const toolbar = element("div", "", "inventory-table-toolbar");
    const summary = element("p", "", "inventory-table-summary");
    summary.setAttribute("role", "status");
    const sizeLabel = element("label", "Rows per page");
    const sizeSelect = element("select");
    sizeSelect.setAttribute("aria-label", "Rows per page");
    [25, 50, 100].forEach(size => {
      const option = element("option", String(size));
      option.value = String(size);
      sizeSelect.appendChild(option);
    });
    sizeSelect.value = "25";
    sizeSelect.addEventListener("change", () => { state.pageSize = Number(sizeSelect.value); state.page = 1; render(); });
    sizeLabel.appendChild(sizeSelect);
    toolbar.append(summary, sizeLabel);

    const scroller = element("div", "", "inventory-table-scroll");
    scroller.tabIndex = 0;
    scroller.setAttribute("role", "region");
    scroller.setAttribute("aria-label", "Software inventory table");
    const table = element("table", "", "inventory-table");
    table.appendChild(element("caption", "One row per version. Click a column heading to sort.", "inventory-table-caption"));
    const head = element("thead"), headRow = element("tr"), body = element("tbody");
    const headings = columns.map(([key, label]) => {
      const th = element("th");
      th.scope = "col";
      const control = button(label, () => {
        state.direction = state.sort === key && state.direction === "asc" ? "desc" : "asc";
        state.sort = key;
        state.page = 1;
        render();
      });
      th.appendChild(control);
      headRow.appendChild(th);
      return { th, control, key, label };
    });
    if (createDetails) {
      const actions = element("th", "Actions");
      actions.scope = "col";
      headRow.appendChild(actions);
    }
    head.appendChild(headRow);
    table.append(head, body);
    scroller.appendChild(table);
    const empty = element("p", "", "inventory-table-empty");
    const pagination = element("nav", "", "inventory-pagination");
    pagination.setAttribute("aria-label", "Inventory pagination");
    const previous = button("Previous", () => { state.page--; render(); });
    const next = button("Next", () => { state.page++; render(); });
    const pageLabel = element("span");
    previous.disabled = true;
    next.disabled = true;
    pagination.append(previous, pageLabel, next);
    container.replaceChildren(toolbar, scroller, empty, pagination);

    function closeDetails() {
      if (!openDetail) return;
      openDetail.row.remove();
      openDetail.button.setAttribute("aria-expanded", "false");
      openDetail = null;
    }

    function render() {
      closeDetails();
      result = select(inventory, state);
      state.page = result.page;
      body.replaceChildren();
      headings.forEach(({ th, control, key, label }) => {
        const active = state.sort === key;
        th.setAttribute("aria-sort", active ? (state.direction === "asc" ? "ascending" : "descending") : "none");
        control.textContent = `${label} ${active ? (state.direction === "asc" ? "↑" : "↓") : "↕"}`;
        control.setAttribute("aria-label", `Sort by ${label.toLowerCase()}, ${active && state.direction === "asc" ? "descending" : "ascending"}`);
      });
      result.visible.forEach((record, index) => {
        const row = element("tr");
        row.append(element("td", record.name), element("td", record.publisher), element("td", record.version ? record.number : "No versions recorded"));
        const statusCell = element("td");
        if (record.version) statusCell.appendChild(element("span", record.status, `inventory-status status-${record.status.toLowerCase()}`));
        else statusCell.textContent = "—";
        row.appendChild(statusCell);
        if (createDetails) {
          const actions = element("td");
          const detailsId = `${container.id}-details-${index}`;
          const manage = button("Manage", () => {
            const wasOpen = openDetail?.button === manage;
            closeDetails();
            if (wasOpen) return;
            const detailRow = element("tr", "", "inventory-detail-row");
            detailRow.id = detailsId;
            const cell = element("td");
            cell.colSpan = 5;
            cell.appendChild(createDetails(record));
            detailRow.appendChild(cell);
            row.after(detailRow);
            manage.setAttribute("aria-expanded", "true");
            openDetail = { row: detailRow, button: manage };
          });
          manage.setAttribute("aria-label", `Manage ${record.name}${record.version ? `, version ${record.number}` : ""}`);
          manage.setAttribute("aria-expanded", "false");
          manage.setAttribute("aria-controls", detailsId);
          actions.appendChild(manage);
          row.appendChild(actions);
        }
        body.appendChild(row);
      });
      const filtered = result.total !== result.totalUnfiltered ? ` (${result.totalUnfiltered} total)` : "";
      summary.textContent = error || (result.total ? `Showing ${result.start}–${result.end} of ${result.total} records${filtered}` : "0 matching records");
      empty.hidden = result.total > 0 && !error;
      empty.textContent = error || (inventory.length ? "No software records match your filters." : "No software records yet.");
      scroller.hidden = result.total === 0 || Boolean(error);
      pageLabel.textContent = `Page ${result.total ? result.page : 0} of ${result.total ? result.pages : 0}`;
      previous.disabled = Boolean(error) || result.page <= 1;
      next.disabled = Boolean(error) || result.page >= result.pages;
    }

    return {
      update(data, options = {}) {
        const query = options.query || "", status = options.status || "All";
        if (query !== state.query || status !== state.status) state.page = 1;
        Object.assign(state, { query, status });
        inventory = data;
        error = options.error || "";
        render();
      },
      getFilteredRows() { return select(inventory, state).rows; }
    };
  }

  const api = { select, create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.InventoryTable = api;
})(globalThis);
