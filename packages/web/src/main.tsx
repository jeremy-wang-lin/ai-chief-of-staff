import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRoot } from "./App";
import { AuthGate } from "./AuthGate";
import { HomePage } from "./pages/Home";
import { TasksPage } from "./pages/Tasks";
import { NotesPage } from "./pages/Notes";
import { RadarPage } from "./pages/Radar";
import { ProjectsPage } from "./pages/Projects";
import { BriefingsPage } from "./pages/Briefings";
import "./index.css";

const router = createBrowserRouter([
  {
    element: <AppRoot />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/tasks/:id?", element: <TasksPage /> },
      { path: "/notes/:id?", element: <NotesPage /> },
      { path: "/radar/:id?", element: <RadarPage /> },
      { path: "/projects/:id?", element: <ProjectsPage /> },
      { path: "/briefings", element: <BriefingsPage /> },
    ],
  },
]);

const qc = new QueryClient();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <AuthGate>
        <RouterProvider router={router} />
      </AuthGate>
    </QueryClientProvider>
  </React.StrictMode>,
);
