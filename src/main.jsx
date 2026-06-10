import * as Sentry from "@sentry/react";

Sentry.init({
  dsn: "https://a3b2ef0204ce8d2473c6cfc96689881f@o4511541484257280.ingest.us.sentry.io/4511541494480896",
  environment: import.meta.env.MODE,
  tracesSampleRate: 1.0,
});

import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/dm-sans/800.css";
import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { registerSW } from "virtual:pwa-register";

registerSW({
  onOfflineReady() {
    console.log("[QuickPOS] Ready to work offline");
  },
});

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
