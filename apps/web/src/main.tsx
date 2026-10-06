import ReactDOM from "react-dom/client";
import { StrictMode } from "react";
import Root from "./Router";
import "./call.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
