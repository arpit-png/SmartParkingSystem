import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

// Scroll-reveal only hides content when JS is running.
document.documentElement.classList.add("js");
createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
