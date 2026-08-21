class FakeClassList {
  constructor(initial = []) {
    this.classes = new Set(initial);
  }

  add(...names) {
    names.filter(Boolean).forEach((name) => this.classes.add(name));
  }

  remove(...names) {
    names.filter(Boolean).forEach((name) => this.classes.delete(name));
  }

  contains(name) {
    return this.classes.has(name);
  }

  toggle(name, force) {
    if (force === undefined) {
      if (this.classes.has(name)) {
        this.classes.delete(name);
        return false;
      }
      this.classes.add(name);
      return true;
    }

    if (force) {
      this.classes.add(name);
      return true;
    }

    this.classes.delete(name);
    return false;
  }

  toString() {
    return [...this.classes].join(" ");
  }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.textContent = "";
    this.innerHTML = "";
    this.disabled = false;
    this.value = "";
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.onclick = null;
    this.classList = new FakeClassList();
    this.focused = false;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  get className() {
    return this.classList.toString();
  }

  set className(value) {
    const names = String(value || "")
      .split(/\s+/)
      .filter(Boolean);
    this.classList = new FakeClassList(names);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentElement) {
      return;
    }
    this.parentElement.children = this.parentElement.children.filter(
      (child) => child !== this,
    );
    this.parentElement = null;
  }

  focus() {
    this.focused = true;
  }

  async click(event = {}) {
    const handlers = this.listeners.get("click") || [];
    for (const handler of handlers) {
      await handler({
        currentTarget: this,
        target: this,
        preventDefault() {},
        stopPropagation() {},
        ...event,
      });
    }

    if (typeof this.onclick === "function") {
      await this.onclick({
        currentTarget: this,
        target: this,
        preventDefault() {},
        stopPropagation() {},
        ...event,
      });
    }
  }
}

module.exports = {
  FakeClassList,
  FakeElement,
};
