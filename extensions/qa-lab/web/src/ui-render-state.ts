export function captureRenderState(root: HTMLElement) {
  const focusedElement = root.contains(document.activeElement) ? document.activeElement : null;
  const focusedId = focusedElement?.id || null;
  const tabBar = root.querySelector<HTMLElement>("nav.tab-bar");
  const focusedTab =
    focusedElement instanceof HTMLButtonElement && focusedElement.parentElement === tabBar
      ? focusedElement.dataset.tab
      : null;
  const tabScrollLeft = tabBar?.scrollLeft ?? 0;
  return { focusedId, focusedTab, tabScrollLeft };
}

export function restoreRenderState(
  root: HTMLElement,
  snapshot: ReturnType<typeof captureRenderState>,
) {
  const { focusedId, focusedTab, tabScrollLeft } = snapshot;
  // The six tabs use data-tab identities. Synchronous focus handlers can reveal
  // a tab even with preventScroll, so restore the user's viewport after focus.
  const tabBar = root.querySelector<HTMLElement>("nav.tab-bar");
  if (focusedTab) {
    tabBar
      ?.querySelector<HTMLButtonElement>(`button[data-tab="${CSS.escape(focusedTab)}"]`)
      ?.focus({ preventScroll: true });
  } else if (focusedId) {
    const el = root.querySelector<HTMLElement>(`#${CSS.escape(focusedId)}`);
    if (el && "focus" in el) {
      el.focus();
    }
  }
  if (tabBar) {
    tabBar.scrollLeft = tabScrollLeft;
  }
}
