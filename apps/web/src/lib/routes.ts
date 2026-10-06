// Route names and links shared by the router and the pages ("#/" call page, "#/staff" clinic staff screen).
export type Route = "call" | "staff";

export const routeHref: Record<Route, string> = { call: "#/", staff: "#/staff" };

/** The staff screen is its own chunk, so the call page loads less JavaScript. */
export const loadStaffScreen = () => import("../App");

let staffPrefetched = false;
/** Downloads the staff screen ahead of a click (hover, focus, or idle time on the call page). */
export function prefetchStaffScreen() {
  if (staffPrefetched) return;
  staffPrefetched = true;
  loadStaffScreen().catch(() => { staffPrefetched = false; });
}

// After moving between routes, focus goes to the new screen's heading (#page-heading). The staff screen is a lazy
// chunk, so its heading may not exist yet: the request stays pending until that screen mounts and takes it.
let headingFocusPending = false;

function focusHeading() {
  const heading = document.getElementById("page-heading");
  if (!heading) return false;
  heading.focus({ preventScroll: true });
  headingFocusPending = false;
  return true;
}

export function requestHeadingFocus() {
  headingFocusPending = true;
  window.requestAnimationFrame(() => { if (headingFocusPending) focusHeading(); });
}

/** Called by a screen when it mounts: takes a pending focus request, if any. */
export function takeHeadingFocus() {
  if (headingFocusPending) focusHeading();
}
