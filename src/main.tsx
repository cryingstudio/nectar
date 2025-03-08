import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./globals.css";
import NectarExtension from "./components/nectar-extension";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NectarExtension />
  </StrictMode>
);
