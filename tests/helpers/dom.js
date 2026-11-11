"use strict";

// Small DOM fixture for exercising the real table controls without a database.
function createDocument() {
  const document = { elements: new Map(), getElementById(id) { return this.elements.get(id) || null; } };
  document.createElement = tag => {
    const attrs = {}, classes = new Set();
    const node = {
      tagName: tag.toUpperCase(), ownerDocument: document, children: [], handlers: {}, dataset: {},
      value: "", textContent: "", hidden: false, disabled: false,
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
        contains(name) { return classes.has(name); }
      },
      setAttribute(name, value) { attrs[name] = String(value); },
      getAttribute(name) { return attrs[name]; },
      removeAttribute(name) { delete attrs[name]; },
      addEventListener(name, callback) { this.handlers[name] = callback; },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      append(...children) { children.forEach(child => this.appendChild(child)); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); },
      after(sibling) { sibling.parentNode = this.parentNode; this.parentNode.children.splice(this.parentNode.children.indexOf(this) + 1, 0, sibling); },
      insertBefore(child, before) { child.parentNode = this; this.children.splice(this.children.indexOf(before), 0, child); },
      click() { return this.handlers.click?.(); },
      focus() {},
      querySelector() { return null; }
    };
    Object.defineProperty(node, "firstChild", { get() { return this.children[0]; } });
    return node;
  };
  document.body = document.createElement("body");
  return document;
}

function descendants(node, tag) {
  return node.children.flatMap(child => [
    ...(child.tagName === tag.toUpperCase() ? [child] : []), ...descendants(child, tag)
  ]);
}

module.exports = { createDocument, descendants };
