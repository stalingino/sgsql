// macOS WebKit applies autocorrect, auto-capitalization, smart quotes/dashes and
// spellcheck to text fields by default. That silently mangles identifiers, SQL and
// cell values, so turn it off for every input/textarea/contenteditable in the window.
const ATTRS: Record<string, string> = {
  autocorrect: "off",
  autocapitalize: "off",
  autocomplete: "off",
  spellcheck: "false",
};

const SELECTOR = "input, textarea, [contenteditable]:not([contenteditable='false'])";

function apply(el: Element) {
  for (const [name, value] of Object.entries(ATTRS)) {
    // Respect an explicit autocomplete (e.g. "new-password") set by a component.
    if (name === "autocomplete" && el.hasAttribute(name)) continue;
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }
}

function scan(root: ParentNode) {
  if (root instanceof Element && root.matches(SELECTOR)) apply(root);
  root.querySelectorAll(SELECTOR).forEach(apply);
}

export function disableTextAssist() {
  scan(document);
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes") {
        if (m.target instanceof Element && m.target.matches(SELECTOR)) apply(m.target);
        continue;
      }
      m.addedNodes.forEach((n) => {
        if (n instanceof Element) scan(n);
      });
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["contenteditable"],
  });
  // Fallback for anything the observer missed: fix it up before the first keystroke.
  document.addEventListener(
    "focusin",
    (e) => {
      if (e.target instanceof Element && e.target.matches(SELECTOR)) apply(e.target);
    },
    true,
  );
}
