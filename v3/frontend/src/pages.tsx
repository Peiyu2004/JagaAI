import { lazy } from "react";

export const CommandPage = lazy(() => import("./pages/Command"));
export const AlertsPage = lazy(() => import("./pages/Alerts"));
export const AskPage = lazy(() => import("./pages/Ask"));
export const LeadsPage = lazy(() => import("./pages/Leads"));
export const IncidentsPage = lazy(() => import("./pages/Incidents"));
export const CamerasPage = lazy(() => import("./pages/Cameras"));
export const InsightsPage = lazy(() => import("./pages/Insights"));
export const SettingsPage = lazy(() => import("./pages/Settings"));
