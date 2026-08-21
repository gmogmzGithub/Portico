// DOM utility helpers
function $(selector, parent = document) {
  return parent.querySelector(selector);
}

function $$(selector, parent = document) {
  return Array.from(parent.querySelectorAll(selector));
}

function createElement(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (key === 'className') {
      el.className = value;
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      el.setAttribute(key, value);
    }
  });
  children.forEach(child => {
    if (typeof child === 'string') {
      el.appendChild(document.createTextNode(child));
    } else {
      el.appendChild(child);
    }
  });
  return el;
}

function removeAllChildren(element) {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

function show(element) {
  if (element) element.style.display = '';
}

function hide(element) {
  if (element) element.style.display = 'none';
}

function toggle(element) {
  if (element) {
    element.style.display = element.style.display === 'none' ? '' : 'none';
  }
}

function addClass(element, ...classes) {
  if (element) element.classList.add(...classes);
}

function removeClass(element, ...classes) {
  if (element) element.classList.remove(...classes);
}

function hasClass(element, className) {
  return element ? element.classList.contains(className) : false;
}

function toggleClass(element, className) {
  if (element) element.classList.toggle(className);
}

function on(element, event, handler, options) {
  if (element) element.addEventListener(event, handler, options);
}

function off(element, event, handler, options) {
  if (element) element.removeEventListener(event, handler, options);
}

function once(element, event, handler) {
  on(element, event, handler, { once: true });
}

function delegate(parent, selector, event, handler) {
  on(parent, event, (e) => {
    const target = e.target.closest(selector);
    if (target) handler.call(target, e);
  });
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    $, $$, createElement, removeAllChildren,
    show, hide, toggle,
    addClass, removeClass, hasClass, toggleClass,
    on, off, once, delegate
  };
}