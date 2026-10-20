import {
  useState,
  useEffect,
  useCallback,
  useRef,
  lazy,
  Suspense,
  type FormEvent,
} from "react";
import {
  LayoutDashboard,
  Bell,
  Search,
  MessageSquare,
  FolderKanban,
  Camera,
  ChartNoAxesCombined,
  Settings,
  LogOut,
  Menu,
  X,
  RefreshCw,
  ShieldCheck,
  AlertCircle,
  Cpu,
  Activity,
  ChevronDown,
  Wifi,
  UserRound,
} from "lucide-react";
import { api, json, relativeTime, SESSION_EXPIRED, invalidateSession, getSessionRevision, checkSession } from "./api";
import type { Bootstrap, User, SearchPreset } from "./types";
import { AppContext } from "./context";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { Brand, VideoPlayer } from "./components/shared";
import { ViewBoundary, ViewLoading } from "./components/AsyncView";
import { LoginWall } from "./components/LoginWall";
import TechText from "./components/reactbits/TechText";
import {
  DetectionFrame,
  type DetectionFrameState,
} from "./components/login/DetectionFrame";
import {
  CommandPage,
  AlertsPage,
  AskPage,
  LeadsPage,
  IncidentsPage,
  CamerasPage,
  InsightsPage,
  SettingsPage,
} from "./pages";
const Resident = lazy(() => import("./Resident"));
const nav = [
  { id: "command", name: "Command centre", icon: LayoutDashboard },
  { id: "alerts", name: "Alerts", icon: Bell },
  { id: "ask", name: "Ask JagaAI", icon: Search },
  { id: "leads", name: "Resident leads", icon: MessageSquare },
  { id: "incidents", name: "Incidents", icon: FolderKanban },
  { id: "cameras", name: "Cameras", icon: Camera },
  { id: "insights", name: "Insights", icon: ChartNoAxesCombined },
  { id: "settings", name: "Settings", icon: Settings },
];
const titles: Record<string, [string, string]> = {
  command: ["Command centre", "A clear view of what needs your attention."],
  alerts: ["Review alerts", "Verify the evidence before you take action."],
  ask: ["Ask JagaAI", "Find the moment. Understand the context."],
  leads: ["Resident leads", "Turn a small observation into a clear response."],
  incidents: [
    "Incident workspace",
    "One record, from the first report to resolution.",
  ],
  cameras: [
    "Cameras & coverage",
    "Manage your recordings, zones and behaviour rules.",
  ],
  insights: [
    "Security insights",
    "Understand activity and improve your response.",
  ],
  settings: [
    "Workspace settings",
    "Manage your team, access and data policies.",
  ],
};
export default function App() {
  const [user, setUser] = useState<User | null | undefined>();
  const [sessionKey, setSessionKey] = useState(0);
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");
  const initialHash = location.hash.slice(1).split("/");
  const [page, setPage] = useState(initialHash[0] || "command");
  const [alertTarget, setAlertTarget] = useState(
    initialHash[0] === "alerts" ? initialHash[1] || "" : "",
  );
  const [mobile, setMobile] = useState(false);
  const [toast, setToast] = useState("");
  const [connected, setConnected] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");
  const [globalQuery, setGlobalQuery] = useState("");
  const [preset, setPreset] = useState<SearchPreset | undefined>();
  const [media, setMedia] = useState<{ id: string; at: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const resident = location.pathname.startsWith("/resident");
  const notify = useCallback((message: string) => setToast(message), []);
  const changeUser = useCallback((next: User | null, message = "") => {
    invalidateSession();
    setUser(next);
    setSessionKey((key) => key + 1);
    setData(null);
    setMedia(null);
    setPreset(undefined);
    setGlobalQuery("");
    setAlertTarget("");
    setToast("");
    setUpdatedAt("");
    setConnected(false);
    setMobile(false);
    setError(message);
  }, []);
  useEffect(() => {
    const expired = () => changeUser(null, "Your session has expired. Please sign in again.");
    window.addEventListener(SESSION_EXPIRED, expired);
    return () => window.removeEventListener(SESSION_EXPIRED, expired);
  }, [changeUser]);
  const refresh = useCallback(async () => {
    const revision = getSessionRevision();
    try {
      const next = await api<Bootstrap>("/bootstrap");
      if (revision !== getSessionRevision()) return;
      setData(next);
      setUser(next.user);
      setUpdatedAt(new Date().toISOString());
      setError("");
    } catch (e) {
      if (revision === getSessionRevision()) throw e;
    }
  }, []);
  useEffect(() => {
    const revision = getSessionRevision();
    api<{ user: User | null }>("/auth/me")
      .then((r) => { if (revision === getSessionRevision()) setUser(r.user); })
      .catch((e) => {
        if (revision !== getSessionRevision()) return;
        setError(e.message);
        setUser(null);
      });
  }, []);
  useEffect(() => {
    if (user && user.role !== "resident" && !resident)
      refresh().catch((e) => setError(e.message));
  }, [user?.id, resident, refresh]);
  useEffect(() => {
    if (!user || user.role === "resident" || resident) return;
    const stream = new EventSource("/api/stream");
    stream.onopen = () => setConnected(true);
    stream.onerror = () => {
      setConnected(false);
      void checkSession().catch(() => { /* A temporary network error is not a sign-out. */ });
    };
    const update = () => {
      refresh().catch((e) => setError(e.message));
    };
    stream.addEventListener("refresh", update);
    return () => {
      stream.close();
      setConnected(false);
    };
  }, [user?.id, resident, refresh]);
  useEffect(() => {
    const handler = () => {
      const parts = location.hash.slice(1).split("/");
      setPage(parts[0] || "command");
      setAlertTarget(parts[0] === "alerts" ? parts[1] || "" : "");
      setMobile(false);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target as HTMLElement)?.closest("input,textarea")) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape") {
        setMobile(false);
        document
          .querySelectorAll("details.topbar-menu[open]")
          .forEach((d) => d.removeAttribute("open"));
      }
    };
    const onClick = (e: MouseEvent) => {
      document.querySelectorAll("details.topbar-menu[open]").forEach((d) => {
        if (!d.contains(e.target as Node)) d.removeAttribute("open");
      });
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, []);
  const closeMenus = () =>
    document
      .querySelectorAll("details.topbar-menu[open]")
      .forEach((d) => d.removeAttribute("open"));
  const go = (next: string) => {
    closeMenus();
    location.hash = next;
    setPage(next);
    if (next !== "alerts") setAlertTarget("");
    setMobile(false);
  };
  const openAlert = (id: string) => {
    closeMenus();
    location.hash = "alerts/" + id;
    setPage("alerts");
    setAlertTarget(id);
    setMobile(false);
    window.scrollTo({ top: 0 });
  };
  const run = async (task: () => Promise<unknown>, success?: string) => {
    try {
      await task();
      await refresh();
      if (success) notify(success);
      return true;
    } catch (e) {
      notify(
        e instanceof Error ? e.message : "The request could not be completed.",
      );
      return false;
    }
  };
  const logout = async () => {
    closeMenus();
    try {
      await api("/auth/logout", { method: "POST" });
      changeUser(null);
    } catch (e) {
      notify((e as Error).message);
    }
  };
  if (resident) return (
    <ViewBoundary key={sessionKey}>
      <Suspense fallback={<ViewLoading entry />}>
        <Resident user={user} setUser={changeUser} sessionError={error} />
      </Suspense>
    </ViewBoundary>
  );
  if (user === undefined)
    return (
      <div className="loading-screen">
        <Brand />
        <RefreshCw className="spin" size={20} />
        <p>Opening your workspace…</p>
      </div>
    );
  if (!user) return <StaffLogin error={error} onLogin={changeUser} />;
  if (user.role === "resident")
    return (
      <div className="loading-screen">
        <Brand />
        <h1>Resident session</h1>
        <p>This account has access to your own reports only.</p>
        <Button asChild>
          <a href="/resident">Open my reports</a>
        </Button>
        <Button variant="ghost" onClick={logout}>
          Sign out
        </Button>
      </div>
    );
  if (!data)
    return (
      <div className="loading-screen">
        <Brand />
        <h1>{error ? "Workspace unavailable" : "Preparing your workspace"}</h1>
        <p>{error || "Loading your property, cameras and records…"}</p>
        <Button onClick={() => refresh().catch((e) => setError(e.message))}>
          <RefreshCw size={16} /> Retry connection
        </Button>
        <Button variant="ghost" onClick={logout}>
          Sign out
        </Button>
      </div>
    );
  const activePage = nav.some((n) => n.id === page) ? page : "command";
  const title = titles[activePage];
  const selectedVideo = data.videos.find((v) => v.id === media?.id);
  return (
    <AppContext.Provider
      value={{
        data,
        refresh,
        run,
        go,
        openAlert,
        alertTarget,
        search: (value) => {
          setPreset(value);
          go("ask");
        },
        play: (id, at = 0) => setMedia({ id, at }),
        notify,
      }}
    >
      <a
        href="#main"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <div className="app-shell">
        <aside className={"sidebar " + (mobile ? "sidebar-open" : "")} aria-label="Workspace navigation and account">
          <a
            href="#command"
            className="brand-link"
          >
            <Brand />
          </a>
          <div className="property-switch">
            <span className="property-avatar">S</span>
            <span>
              <strong>Serenia City</strong>
              <small>Security</small>
            </span>
            <span className="property-status">Demo</span>
          </div>
          <nav aria-label="Workspace">
            {nav.map(({ id, name, icon: Icon }) => (
              <a
                key={id}
                href={"#" + id}
                className={"nav-item " + (id === activePage ? "active" : "")}
                aria-current={id === activePage ? "page" : undefined}
              >
                <Icon size={19} />
                <span>{name}</span>
                {id === "alerts" && data.summary.alert_count > 0 && (
                  <b>{data.summary.alert_count}</b>
                )}
                {id === "leads" && data.summary.new_leads > 0 && (
                  <b>{data.summary.new_leads}</b>
                )}
              </a>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="privacy-note">
              <ShieldCheck size={19} />
              <span>
                Private by design
                <small>Local-only, no face recognition</small>
              </span>
            </div>
            <div className="account">
              <span className="avatar">
                {user.name
                  .split(" ")
                  .map((n) => n[0])
                  .slice(0, 2)
                  .join("")}
              </span>
              <span>
                <strong>{user.name}</strong>
                <small>
                  {user.role === "admin"
                    ? "Workspace admin"
                    : "Security supervisor"}
                </small>
              </span>
              <button onClick={logout} aria-label="Sign out">
                <LogOut size={17} />
              </button>
            </div>
          </div>
        </aside>
        {mobile && (
          <button
            className="mobile-backdrop"
            onClick={() => setMobile(false)}
            aria-label="Close navigation"
          />
        )}
        <div className="workspace">
          <header className="topbar">
            <button
              className="mobile-menu"
              onClick={() => setMobile(!mobile)}
              aria-label={mobile ? "Close navigation" : "Open navigation"}
            >
              {mobile ? <X size={21} /> : <Menu size={21} />}
            </button>
            <div className="topbar-context">
              <strong>Serenia City</strong>
              <span>Night shift · Security workspace</span>
            </div>
            <form
              className="global-search"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                const value = globalQuery.trim();
                if (!value) return;
                setPreset({ query: value });
                go("ask");
                setGlobalQuery("");
              }}
            >
              <Search size={16} />
              <input
                ref={searchRef}
                value={globalQuery}
                onChange={(e) => setGlobalQuery(e.target.value)}
                placeholder="Search recordings or ask JagaAI…"
                aria-label="Search recordings or ask JagaAI"
              />
              <kbd>/</kbd>
            </form>
            <div className="topbar-right">
              <span className="demo-pill" title="This workspace uses prepared demo records">
                Demo data
              </span>
              <details className="topbar-menu status-menu">
                <summary
                  className={"status-trigger " + (connected ? "is-live" : "")}
                  title={
                    connected
                      ? "Live updates connected"
                      : "Live updates reconnecting"
                  }
                  aria-label={
                    connected
                      ? "System status: live updates connected"
                      : "System status: live updates reconnecting"
                  }
                >
                  <span className="status-dot" />
                  <span className="status-label">
                    {connected ? "Live" : "Reconnecting"}
                  </span>
                  <ChevronDown size={14} />
                </summary>
                <div className="menu-popover status-popover">
                  <div className="popover-head">
                    <strong>System status</strong>
                    <small>Updated {relativeTime(updatedAt)}</small>
                  </div>
                  <div className="status-line">
                    <Wifi size={16} />
                    <span>
                      Live updates
                      <small>Alert and lead changes stream in</small>
                    </span>
                    <b className={connected ? "ok" : "warn"}>
                      {connected ? "Connected" : "Retrying"}
                    </b>
                  </div>
                  <div className="status-line">
                    <Activity size={16} />
                    <span>
                      Analysis queue
                      <small>Recordings waiting for the local worker</small>
                    </span>
                    <b className={data.summary.pending_video_count ? "warn" : "ok"}>
                      {data.summary.pending_video_count
                        ? `${data.summary.pending_video_count} waiting`
                        : "Up to date"}
                    </b>
                  </div>
                  <div className="status-line">
                    <Camera size={16} />
                    <span>
                      Cameras
                      <small>Configured sources and recordings</small>
                    </span>
                    <b>{data.cameras.length} configured</b>
                  </div>
                  <div className="status-line">
                    <Cpu size={16} />
                    <span>
                      Local AI
                      <small>Search and descriptions run on this machine</small>
                    </span>
                    <b className="muted">Local only</b>
                  </div>
                  <div className="popover-foot">
                    <ShieldCheck size={13} /> No cloud dependency · No face
                    recognition
                  </div>
                </div>
              </details>
              <details className="topbar-menu account-menu">
                <summary className="account-trigger">
                  <span className="avatar">
                    {user.name
                      .split(" ")
                      .map((n) => n[0])
                      .slice(0, 2)
                      .join("")}
                  </span>
                  <ChevronDown size={14} />
                </summary>
                <div className="menu-popover account-popover">
                  <div className="account-head">
                    <strong>{user.name}</strong>
                    <small>
                      {user.role === "admin"
                        ? "Workspace administrator"
                        : "Security supervisor"}
                    </small>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      go("settings");
                      document
                        .querySelectorAll("details.topbar-menu[open]")
                        .forEach((d) => d.removeAttribute("open"));
                    }}
                  >
                    <UserRound size={15} /> Workspace settings
                  </button>
                  <button type="button" onClick={logout}>
                    <LogOut size={15} /> Sign out
                  </button>
                </div>
              </details>
            </div>
          </header>
          <main id="main" tabIndex={-1}>
            <div className="page-heading">
              <div>
                <h1>{title[0]}</h1>
                <p>{title[1]}</p>
              </div>
              <span className="page-updated">
                <span className={"live-dot " + (connected ? "" : "off")} />
                Updated {relativeTime(updatedAt)}
              </span>
            </div>
            {error && (
              <div className="error-banner" role="alert">
                <AlertCircle size={17} />
                {error}
              </div>
            )}
            <ViewBoundary key={activePage}>
              <Suspense fallback={<ViewLoading />}>
            {activePage === "command" && <CommandPage />}
            {activePage === "alerts" && <AlertsPage />}
            {activePage === "ask" && <AskPage preset={preset} />}
            {activePage === "leads" && <LeadsPage />}
            {activePage === "incidents" && <IncidentsPage />}
            {activePage === "cameras" && <CamerasPage />}
            {activePage === "insights" && <InsightsPage />}
            {activePage === "settings" && <SettingsPage />}
                <span hidden data-page-ready={activePage} />
              </Suspense>
            </ViewBoundary>
            <footer className="page-footer">
              <span>
                JagaAI · Local development workspace. Sample property setup;
                analysis uses only uploaded recordings.
              </span>
              <span>Asia/Kuala_Lumpur</span>
            </footer>
          </main>
        </div>
      </div>
      <Dialog
        open={!!media}
        onOpenChange={(open) => {
          if (!open) setMedia(null);
        }}
        title="Original recording"
        description="Private footage. Viewing is recorded in the audit log."
      >
        {selectedVideo ? (
          <VideoPlayer video={selectedVideo} at={media?.at} />
        ) : (
          <p className="muted">This recording is no longer available.</p>
        )}
      </Dialog>
      {toast && (
        <div className="toast" role="status">
          <ShieldCheck size={18} />
          <span>{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </AppContext.Provider>
  );
}
function StaffLogin({
  error,
  onLogin,
}: {
  error: string;
  onLogin: (user: User) => void;
}) {
  const [email, setEmail] = useState("admin@jagaai.local");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(error);
  const [focusTarget, setFocusTarget] = useState<
    "email" | "password" | "submit" | null
  >(null);
  const [frameState, setFrameState] = useState<DetectionFrameState>("hidden");
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const emailRowRef = useRef<HTMLLabelElement>(null);
  const passwordRowRef = useRef<HTMLDivElement>(null);
  const fieldsRef = useRef<HTMLDivElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  // Editing a field clears the error frame. Declared before the message effect
  // so an initial error is not cleared on mount.
  useEffect(() => {
    setFrameState((s) => (s === "error" ? "focus" : s));
  }, [email, password]);
  useEffect(() => {
    if (message) setFrameState("error");
  }, [message]);
  const exitTransition = () =>
    new Promise<void>((resolve) => {
      const root = rootRef.current;
      if (
        !root ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        resolve();
        return;
      }
      setFrameState("success");
      window.setTimeout(() => root.classList.add("jl-exiting"), 220);
      window.setTimeout(resolve, 600);
    });
  const signIn = async (nextEmail: string, nextPassword: string) => {
    setBusy(true);
    setMessage("");
    try {
      const r = await api<{ user: User }>("/auth/login", {
        method: "POST",
        body: json({ email: nextEmail, password: nextPassword }),
      });
      await exitTransition();
      onLogin(r.user);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    signIn(email, password);
  };
  const useDemo = () => {
    const demoEmail = "admin@jagaai.local";
    const demoPassword = "JagaAI-demo-2026!";
    setEmail(demoEmail);
    setPassword(demoPassword);
    signIn(demoEmail, demoPassword);
  };
  const focusOn = (target: "email" | "password" | "submit") => () => {
    setFocusTarget(target);
    setFrameState("focus");
  };
  // Moving between framed controls glides the frame; leaving them hides it.
  const blur = (e: { relatedTarget: EventTarget | null }) => {
    const next = e.relatedTarget;
    if (!(next instanceof HTMLElement && next.dataset.jlFrame)) {
      setFocusTarget(null);
    }
  };
  const frame: {
    target: HTMLElement | null;
    label: string;
    state: DetectionFrameState;
  } =
    frameState === "success"
      ? { target: cardRef.current, label: "VERIFIED", state: "success" }
      : busy
        ? { target: submitRef.current, label: "VERIFYING", state: "busy" }
        : frameState === "error"
          ? { target: fieldsRef.current, label: "CHECK DETAILS", state: "error" }
          : focusTarget === "email"
            ? { target: emailRowRef.current, label: "EMAIL · 0.99", state: "focus" }
            : focusTarget === "password"
              ? {
                  target: passwordRowRef.current,
                  label: "PASSWORD · 0.99",
                  state: "focus",
                }
              : focusTarget === "submit"
                ? { target: submitRef.current, label: "SIGN IN", state: "focus" }
                : { target: null, label: "", state: "hidden" };
  const hour = new Date().getHours();
  const greeting =
    hour >= 5 && hour <= 11
      ? "Good morning."
      : hour >= 12 && hour <= 17
        ? "Good afternoon."
        : "Good evening.";
  return (
    <div className="jl-root" ref={rootRef}>
      <LoginWall />
      <section className="jl-stage">
        <div className="jl-mark" role="img" aria-label="JagaAI">
          <TechText
            text="JagaAI"
            fontFamily='"IBM Plex Sans", "Segoe UI", sans-serif'
            fontWeight={600}
            fontSize={220}
            letterSpacing={-0.04}
            color="#EAF0FB"
            accentColor="#F5B544"
            align="center"
            reveal="letter"
            lineStyle="dashed"
            dashLength={4}
            dashGap={3}
            strokeWidth={1.5}
            specks={10}
            selection
            labels
            draggable
            bounce={0.35}
            sweep
            speed={0.8}
            clickKick
            intro="assemble"
            introDuration={1.6}
            guides={false}
            reach={200}
            softness={0.7}
          />
        </div>
        <h1 className="jl-tagline">Every frame, understood.</h1>
      </section>
      <div className="jl-card" ref={cardRef}>
        <span className="jl-corner tl" aria-hidden="true" />
        <span className="jl-corner tr" aria-hidden="true" />
        <span className="jl-corner bl" aria-hidden="true" />
        <span className="jl-corner br" aria-hidden="true" />
        <p className="jl-kicker jl-s0">Serenia City · Security</p>
        <h2 className="jl-greeting jl-s1">{greeting}</h2>
        <p className="jl-sub jl-s2">Sign in to start your shift.</p>
        <form className="jl-form" onSubmit={submit}>
          <div className="jl-fields jl-s3" ref={fieldsRef}>
            <label className="jl-field" htmlFor="jl-email" ref={emailRowRef}>
              <span className="jl-caption">Email</span>
              <input
                id="jl-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-jl-frame="email"
                onFocus={focusOn("email")}
                onBlur={blur}
              />
            </label>
            <div className="jl-field" ref={passwordRowRef}>
              <label className="jl-caption" htmlFor="jl-password">
                Password
              </label>
              <span className="jl-field-input">
                <input
                  id="jl-password"
                  type={show ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  data-jl-frame="password"
                  onFocus={focusOn("password")}
                  onBlur={blur}
                />
                <button
                  type="button"
                  className="jl-toggle"
                  onClick={() => setShow(!show)}
                  aria-label={show ? "Hide password" : "Show password"}
                  aria-pressed={show}
                  data-jl-frame="password"
                  onFocus={focusOn("password")}
                  onBlur={blur}
                >
                  {show ? "Hide" : "Show"}
                </button>
              </span>
            </div>
          </div>
          {message && (
            <p className="jl-error" role="alert">
              {message}
            </p>
          )}
          <button
            type="submit"
            className="jl-btn jl-s4"
            disabled={busy}
            ref={submitRef}
            data-jl-frame="submit"
            onFocus={focusOn("submit")}
            onBlur={blur}
          >
            {busy ? "Signing in…" : "Sign in"}
            <span className="jl-arrow" aria-hidden="true">
              →
            </span>
          </button>
          <div className="jl-demo-row jl-s5">
            <button
              type="button"
              className="jl-demo"
              onClick={useDemo}
              disabled={busy}
            >
              Use demo account
              <span className="jl-arrow" aria-hidden="true">
                →
              </span>
            </button>
            <details className="jl-help">
              <summary>
                Demo credentials
                <span className="jl-plus" aria-hidden="true" />
              </summary>
              <div className="jl-help-body">
                <p>
                  Admin: admin@jagaai.local
                  <br />
                  Supervisor: supervisor@jagaai.local
                  <br />
                  Initial password: <code>JagaAI-demo-2026!</code>
                </p>
                <p>
                  Use the password set by your administrator if the initial
                  password was changed.
                </p>
                <p className="jl-credit">
                  <a
                    href="https://mevadata.org/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Demo footage: MEVA dataset (Kitware, IARPA) · CC BY 4.0
                  </a>
                </p>
              </div>
            </details>
          </div>
        </form>
        <hr className="jl-rule jl-s6" />
        <a className="jl-resident jl-s7" href="/resident">
          Resident? Make a report
          <span className="jl-arrow" aria-hidden="true">
            →
          </span>
        </a>
        <div
          className="jl-privacy jl-s8"
          role="group"
          aria-label="No face recognition. Human review on every alert. Private by design."
        >
          <span className="jl-privacy-bullet" aria-hidden="true" />
          <span className="jl-ticker" aria-hidden="true">
            <span>No face recognition</span>
            <span>Human review on every alert</span>
            <span>Private by design</span>
          </span>
          <span className="jl-ticker-static" aria-hidden="true">
            No face recognition · Human review on every alert · Private by
            design
          </span>
        </div>
        <DetectionFrame
          target={frame.target}
          state={frame.state}
          label={frame.label}
          container={cardRef.current}
        />
      </div>
      <div className="jl-veil" aria-hidden="true" />
    </div>
  );
}
