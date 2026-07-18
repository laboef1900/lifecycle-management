/**
 * Escape/keyboard helpers shared by keyboard-driven navigation — the global
 * shortcuts handler and the Settings page's Esc-to-go-back. Kept framework-
 * agnostic (plain DOM) so both a React `onKeyDown` and a document-level
 * listener can use them.
 */

/**
 * True when the event target is a text-entry control. Esc there usually means
 * "cancel this edit / dismiss autocomplete", not a page-level action.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * True when a dismissible overlay is currently open anywhere in the document —
 * a Radix Dialog/DropdownMenu/Select-popup or the cmdk palette. Radix portals
 * overlay *content* to `document.body` with an ARIA popup role that only exists
 * while the overlay is open, so querying those roles is a version-independent
 * signal (the same reasoning `isEscapeTargetInsidePanel` in cluster-panel.tsx
 * records) — we never reach into Radix internals.
 *
 * Unlike the panel (which scopes Escape by DOM containment because its focus
 * trap keeps the target *inside* the panel), the Settings page has no focus
 * trap and is commonly entered with focus on `<body>`; detecting the overlay by
 * its presence in the document — rather than by the Escape target — is what
 * lets Esc still go back from body while a real open overlay still suppresses
 * it. `combobox` is deliberately excluded: a Select *trigger* carries that role
 * permanently even when closed; its open popup is a `listbox`.
 */
export function isOverlayOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]',
    ) !== null
  );
}
