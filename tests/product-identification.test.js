"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const code = fs.readFileSync(require.resolve("../routes/product-identification"), "utf8");
const watchModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(require.resolve("../routes/security-watch"), "utf8"), {
  module: watchModule, process: { env: {} }, setInterval: () => ({ unref() {} }),
  require: key => key === "express" ? { Router: () => ({ get() {} }) } : {}
});
const helpers = watchModule.exports.identification;
const choiceId = "384d97be-0984-42fa-8b65-a077538f8c50";
const id = "399dfbfb-adbe-479c-89dc-992369408bd4";
const family = "cpe:2.3:a:mozilla:firefox";
const entry = { cpeNameId: choiceId, deprecated: false, cpeName: family + ":128:*:*:*:*:*:*:*" };

function fixture(records, updateCount = 1) {
  const routes = new Map(), queries = [];
  const sameOrigin = () => {};
  const router = { use() {}, get(path, handler) { routes.set(path, handler); },
    put(path, guard, handler) { assert.equal(guard, sameOrigin); routes.set(path, handler); } };
  const module = { exports: {} };
  const db = { query(sql, values) { queries.push({ sql, values }); return { rowCount: updateCount }; } };
  vm.runInNewContext(code, { module, require: key => key === "express" ? { Router: () => router } : db });
  module.exports({ ...helpers, requestNvd: () => ({ products: records.map(cpe => ({ cpe })), startIndex: 0, totalResults: records.length }) }, sameOrigin);
  const response = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
  return { queries, response, call: (path, req) => routes.get(path)(req, response) };
}

test("search groups active application versions and excludes deprecated entries and other CPE parts", async () => {
  const f = fixture([entry, {...entry, cpeName: family + ":129:*:*:*:*:*:*:*"},
    {...entry, deprecated: true, cpeName: entry.cpeName.replace("firefox", "retired")},
    {...entry, cpeName: entry.cpeName.replace(":a:", ":o:")}]);
  await f.call("/search", {query: {q: "Firefox"}});
  assert.equal(f.response.data.choices.length, 1);
  assert.equal(f.response.data.choices[0].family, family);
});

test("saving rechecks the active dictionary identity and rejects stale concurrent changes", async () => {
  const body = { choiceId, family, previousFamily: null, name: "Classroom Browser", publisher: "IT Services" };
  for (const record of [{...entry, deprecated: true}, {...entry, cpeName: entry.cpeName.replace("firefox", "thunderbird")}]) {
    const f = fixture([record]);
    await f.call("/:id", {params:{id}, body});
    assert.equal(f.response.code, 409);
    assert.equal(f.queries.length, 0);
  }
  const f = fixture([entry], 0);
  await f.call("/:id", {params:{id}, body});
  assert.match(f.queries[0].sql, /nvd_family IS NOT DISTINCT FROM \$3 AND name = \$4 AND publisher = \$5/);
  assert.deepEqual([...f.queries[0].values], [id, family, null, body.name, body.publisher]);
  assert.equal(f.response.code, 409);
});
