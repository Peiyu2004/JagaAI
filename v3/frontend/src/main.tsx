import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import GuardResponse from "./GuardResponse";
import "./index.css";
import "./design-v4.css";
import "./readability.css";
import "./login.css";
import "./system.css";
import "./theme-light.css";
import "./workspace.css";
import "./notifications.css";
import "./roles.css";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {location.pathname.startsWith("/guard") ? <GuardResponse /> : <App />}
  </React.StrictMode>,
);
