const test = require("node:test");
const assert = require("node:assert/strict");

function loadModule() {
  const modulePath = require.resolve("../renderer/components/accordion-visibility");
  delete require.cache[modulePath];
  return require("../renderer/components/accordion-visibility");
}

test("computeAccordionScrollTop handles invalid inputs and top or bottom overflow cases", () => {
  const mod = loadModule();

  assert.equal(mod.computeAccordionScrollTop({}), null);
  assert.equal(
    mod.computeAccordionScrollTop({
      accordionRect: { top: 10, bottom: 20, height: 10 },
      containerRect: { top: 0, bottom: 10 },
      currentScrollTop: 0,
      topPadding: 8,
      bottomPadding: 8,
    }),
    null,
  );
  assert.equal(
    mod.computeAccordionScrollTop({
      accordionRect: { top: 10, bottom: 40, height: 30 },
      containerRect: { top: 0, bottom: 100 },
      currentScrollTop: 25,
      topPadding: 16,
      bottomPadding: 20,
    }),
    19,
  );
  assert.equal(
    mod.computeAccordionScrollTop({
      accordionRect: { top: 70, bottom: 120, height: 50 },
      containerRect: { top: 0, bottom: 100 },
      currentScrollTop: 30,
      topPadding: 16,
      bottomPadding: 20,
    }),
    70,
  );
  assert.equal(
    mod.computeAccordionScrollTop({
      accordionRect: { top: 5, bottom: 155, height: 150 },
      containerRect: { top: 0, bottom: 120 },
      currentScrollTop: 40,
      topPadding: 16,
      bottomPadding: 20,
    }),
    29,
  );
  assert.equal(
    mod.computeAccordionScrollTop({
      accordionRect: { top: 30, bottom: 60, height: 30 },
      containerRect: { top: 0, bottom: 120 },
      currentScrollTop: 10,
      topPadding: 16,
      bottomPadding: 20,
    }),
    null,
  );
});

test("ensureAccordionVisibleWithinContainer scrolls with scrollTo or scrollTop fallbacks", () => {
  const mod = loadModule();

  assert.equal(mod.ensureAccordionVisibleWithinContainer(null, null), false);

  const scrollCalls = [];
  const accordion = {
    getBoundingClientRect() {
      return { top: 110, bottom: 190, height: 80 };
    },
  };
  const containerWithScrollTo = {
    scrollTop: 20,
    getBoundingClientRect() {
      return { top: 0, bottom: 140 };
    },
    scrollTo(args) {
      scrollCalls.push(args);
    },
  };

  assert.equal(
    mod.ensureAccordionVisibleWithinContainer(accordion, containerWithScrollTo, {
      topPadding: 16,
      bottomPadding: 20,
      behavior: "instant",
    }),
    true,
  );
  assert.deepEqual(scrollCalls, [{ top: 90, behavior: "instant" }]);

  const containerWithoutScrollTo = {
    scrollTop: 5,
    getBoundingClientRect() {
      return { top: 0, bottom: 100 };
    },
  };

  assert.equal(
    mod.ensureAccordionVisibleWithinContainer(
      {
        getBoundingClientRect() {
          return { top: 0, bottom: 90, height: 90 };
        },
      },
      containerWithoutScrollTo,
      {
        topPadding: 20,
        bottomPadding: 10,
      },
    ),
    true,
  );
  assert.equal(containerWithoutScrollTo.scrollTop, -15);
});

test("scheduleExpandedAccordionVisibility resolves the container and supports default scheduling", () => {
  const mod = loadModule();

  const scheduled = [];
  const accordion = {
    getBoundingClientRect() {
      return { top: 100, bottom: 160, height: 60 };
    },
  };
  const scrollContainer = {
    scrollTop: 10,
    getBoundingClientRect() {
      return { top: 0, bottom: 120 };
    },
    scrollTo(args) {
      scheduled.push(args);
    },
  };

  const customResult = mod.scheduleExpandedAccordionVisibility(accordion, {
    scrollContainer(currentAccordion) {
      assert.equal(currentAccordion, accordion);
      return scrollContainer;
    },
    settleDelayMs: -1,
    schedule(callback) {
      assert.equal(typeof callback, "function");
      return callback();
    },
  });

  assert.equal(customResult, true);
  assert.deepEqual(scheduled, [{ top: 70, behavior: "smooth" }]);

  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousSetTimeout = global.setTimeout;
  let timeoutCalls = 0;
  global.requestAnimationFrame = undefined;
  global.setTimeout = (callback) => {
    timeoutCalls += 1;
    callback();
    return 42;
  };

  try {
    const result = mod.scheduleExpandedAccordionVisibility(accordion, {
      scrollContainer,
      settleDelayMs: -1,
    });

    assert.equal(result, 42);
    assert.equal(timeoutCalls, 1);
  } finally {
    global.requestAnimationFrame = previousRequestAnimationFrame;
    global.setTimeout = previousSetTimeout;
  }
});

test("scheduleExpandedAccordionVisibility re-checks visibility after transitionend when layout settles later", () => {
  const mod = loadModule();
  const listeners = new Map();
  const scrollCalls = [];
  let rectState = "before";

  const accordion = {
    classList: {
      contains(name) {
        return name === "collapsed" ? false : false;
      },
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type, handler) {
      if (listeners.get(type) === handler) {
        listeners.delete(type);
      }
    },
    getBoundingClientRect() {
      if (rectState === "before") {
        return { top: 20, bottom: 140, height: 120 };
      }
      return { top: 160, bottom: 320, height: 160 };
    },
  };
  const scrollContainer = {
    scrollTop: 0,
    getBoundingClientRect() {
      return { top: 0, bottom: 200 };
    },
    scrollTo(args) {
      scrollCalls.push(args);
    },
  };

  const result = mod.scheduleExpandedAccordionVisibility(accordion, {
    scrollContainer,
    settleDelayMs: -1,
    schedule(callback) {
      return callback();
    },
  });

  assert.equal(result, false);
  assert.deepEqual(scrollCalls, []);

  rectState = "after";
  listeners.get("transitionend")?.({ propertyName: "max-height" });

  assert.deepEqual(scrollCalls, [{ top: 140, behavior: "smooth" }]);
});

test("scheduleExpandedAccordionVisibility falls back to a settle timeout when transitionend never fires", () => {
  const mod = loadModule();
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const scheduledTimeouts = [];
  const clearedTimeouts = [];
  const scrollCalls = [];
  let rectState = "before";

  global.setTimeout = (callback, delay) => {
    const entry = {
      id: scheduledTimeouts.length + 1,
      callback,
      delay,
    };
    scheduledTimeouts.push(entry);
    return entry.id;
  };
  global.clearTimeout = (id) => {
    clearedTimeouts.push(id);
  };

  try {
    const accordion = {
      classList: {
        contains(name) {
          return name === "collapsed" ? false : false;
        },
      },
      getBoundingClientRect() {
        if (rectState === "before") {
          return { top: 30, bottom: 150, height: 120 };
        }
        return { top: 150, bottom: 300, height: 150 };
      },
    };
    const scrollContainer = {
      scrollTop: 0,
      getBoundingClientRect() {
        return { top: 0, bottom: 200 };
      },
      scrollTo(args) {
        scrollCalls.push(args);
      },
    };

    const result = mod.scheduleExpandedAccordionVisibility(accordion, {
      scrollContainer,
      settleDelayMs: 275,
      schedule(callback) {
        return callback();
      },
    });

    assert.equal(result, false);
    assert.equal(scheduledTimeouts.length, 1);
    assert.equal(scheduledTimeouts[0].delay, 275);
    assert.deepEqual(scrollCalls, []);

    rectState = "after";
    scheduledTimeouts[0].callback();

    assert.deepEqual(scrollCalls, [{ top: 120, behavior: "smooth" }]);
    assert.deepEqual(clearedTimeouts, [1]);
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});
