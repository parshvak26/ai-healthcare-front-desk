// Hash routes, so GitHub Pages needs no 404 rewrite: "#/" is the call page (and the default for anything unknown),
// "#/staff" is the clinic staff screen. The demo connection and the call controller live above the routes, so moving
// between them never reloads the clinic or ends a browser call.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import CallPage from "./CallPage";
import { CallProvider } from "./lib/callController";
import { DemoProvider, useDemo } from "./lib/demoContext";
import { loadStaffScreen, prefetchStaffScreen, requestHeadingFocus } from "./lib/routes";
import type { Route } from "./lib/routes";

const StaffApp = lazy(loadStaffScreen);
const titles: Record<Route, string> = {
  call: "Talk to an AI receptionist · CareDesk demo",
  staff: "Clinic staff screen · CareDesk demo",
};

function routeFromHash(hash: string): Route {
  return /^#\/staff(?:[/?]|$)/.test(hash) ? "staff" : "call";
}

function useHashRoute() {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    return () => { window.removeEventListener("hashchange", onChange); window.removeEventListener("popstate", onChange); };
  }, []);
  return route;
}

function ReloadPrompt() {
  const { reloadRequired } = useDemo();
  if (!reloadRequired) return null;
  return <div className="cp-reload" role="alert">
    <span>This page is out of date — the demo was updated since you opened it.</span>
    <button type="button" onClick={() => window.location.reload()}>Reload</button>
  </div>;
}

function Routes() {
  const route = useHashRoute();
  const shown = useRef(route);

  useEffect(() => {
    document.title = titles[route];
    if (shown.current === route) return;
    shown.current = route;
    // A new screen: start at the top and move focus to its heading for screen readers and keyboard users.
    window.scrollTo(0, 0);
    requestHeadingFocus();
  }, [route]);

  useEffect(() => {
    if (route !== "call") return;
    const idle = (window as Window & { requestIdleCallback?: (fn: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
    const timer = idle ? idle(prefetchStaffScreen, { timeout: 6000 }) : window.setTimeout(prefetchStaffScreen, 4000);
    return () => { if (!idle) window.clearTimeout(timer); };
  }, [route]);

  return <>
    <ReloadPrompt />
    {route === "staff"
      ? <Suspense fallback={<div className="cp-route-loading" role="status">Opening the clinic staff screen…</div>}><StaffApp /></Suspense>
      : <CallPage />}
  </>;
}

export default function Root() {
  return <DemoProvider>
    <CallProvider>
      <Routes />
    </CallProvider>
  </DemoProvider>;
}
