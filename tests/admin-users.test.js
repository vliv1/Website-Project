"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const express = require("express");
const argon2 = require("argon2");

function setup() {
  let account, pending;
  const statements = [];
  const client = {
    release() {},
    async query(sql, values = []) {
      statements.push(sql);
      if (sql === "BEGIN") pending = account;
      if (sql === "COMMIT") account = pending;
      if (sql === "ROLLBACK") pending = null;
      if (sql.startsWith("SELECT id FROM")) return {rowCount: account ? 1 : 0};
      if (sql.startsWith("INSERT")) {
        pending = { id: "sample-admin", email: values[0], password_hash: values[1], created_at: "2026-11-17T12:00:00Z" };
        const {password_hash, ...safe} = pending;
        return {rows:[safe]};
      }
      if (sql.startsWith("SELECT id, email")) {
        assert.ok(!sql.includes("password_hash"));
        if (!account) return {rows:[]};
        const {password_hash, ...safe} = account;
        return {rows:[safe]};
      }
      return {rows:[], rowCount:0};
    }
  };
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve("../routes/admin-users"), "utf8"), {
    module, console, require: name => name === "express" ? express : name === "argon2" ? argon2 :
      {connect: async()=>client, query:client.query}
  });
  const router = module.exports(
    (req,res,next)=>req.origin === "same" ? next() : res.status(403).json({}),
    (_req,_res,next)=>next()
  );
  function request(method,body,origin="same") {
    return new Promise((resolve,reject)=>{
      let code=200;
      router.handle({method,url:"/",headers:{},body,origin},{
        set(){},status(value){code=value;return this;},json(data){resolve({code,data});}
      },reject);
    });
  }
  return {request,statements,account:()=>account};
}

test("administrator creation hashes the password in the format used by login and returns only safe fields", async()=>{
  const h=setup(), password="A long sample password for verification";
  const body={email:"  New.Admin@Example.test ",password,confirmPassword:password};
  const result=await h.request("POST",body);
  assert.equal(result.code,201);
  assert.equal(result.data.email,"new.admin@example.test");
  assert.equal(result.data.password_hash,undefined);
  assert.equal(await argon2.verify(h.account().password_hash,password),true);
  assert.notEqual(h.account().password_hash,password);
  assert.equal((await h.request("POST",body)).code,409);
  assert.equal(h.statements.at(-1),"ROLLBACK");
  assert.equal((await h.request("GET")).data[0].password_hash,undefined);
});

test("administrator creation rejects cross-origin requests and invalid fields before accessing the database",async()=>{
  const h=setup();
  const body={email:"user@example.test",password:"long test password",confirmPassword:"long test password"};
  assert.equal((await h.request("POST",body,"other")).code,403);
  for(const patch of [{email:"invalid"},{email:null},{password:"short"},{password:"a".repeat(1025)},{confirmPassword:"different"}]) {
    assert.equal((await h.request("POST",{...body,...patch})).code,400);
  }
  assert.equal(h.statements.length,0);
});
