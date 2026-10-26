import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NameProvider } from "@/hooks/use-name";
import App from "./App";
import "./index.css";

// shadcn's dark theme hangs off a `.dark` class; follow the system setting.
const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={300}>
      <NameProvider>
        <App />
        <Toaster position="bottom-left" />
      </NameProvider>
    </TooltipProvider>
  </StrictMode>,
);
