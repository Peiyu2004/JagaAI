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
  ChevronRight,
  Menu,
  X,
  RefreshCw,
  ShieldCheck,
  ArrowRight,
  AlertCircle,
  Cpu,
  Activity,
  UserCheck,
  Eye,
  EyeOff,
  KeyRound,
  ChevronDown,
  Wifi,
  UserRound,
} from "lucide-react";
import { api, json, relativeTime, SESSION_EXPIRED, invalidateSession, getSessionRevision, checkSession } from "./api";
import type { Bootstrap, User, SearchPreset } from "./types";
import { AppContext } from "./context";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import { Brand, Field, VideoPlayer } from "./components/shared";
import { ViewBoundary, ViewLoading } from "./components/AsyncView";
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
  const signIn = async (nextEmail: string, nextPassword: string) => {
    setBusy(true);
    setMessage("");
    try {
      const r = await api<{ user: User }>("/auth/login", {
        method: "POST",
        body: json({ email: nextEmail, password: nextPassword }),
      });
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
  return (
    <div className="login-glass">
      <div className="glass-bg" aria-hidden="true">
        <LoginMap />
        <span className="orb orb-a" />
        <span className="orb orb-b" />
        <span className="orb orb-c" />
      </div>
      <header className="glass-top">
        <Brand />
        <span className="glass glass-status">
          <span className="kicker-dot" />
          Local workspace
        </span>
      </header>
      <main className="glass-main">
        <section className="glass-hero">
          <span className="glass glass-kicker">
            Township security workspace
          </span>
          <h1>
            A quieter control room.
            <br />
            <span>A clearer response.</span>
          </h1>
          <p>
            Cameras, resident leads and incident records in one private
            workspace. Every alert waits for a person to review it.
          </p>
          <span className="glass-flow-label">The workspace at a glance</span>
          <div className="login-preview" aria-hidden="true">
            <div className="login-preview-head">
              <span>
                <span className="preview-brand">JagaAI</span> Command centre
              </span>
              <span className="preview-live">
                <span /> Live
              </span>
            </div>
            <div className="login-preview-metrics">
              <span>
                <strong>4</strong> to review
              </span>
              <span>
                <strong>1</strong> urgent
              </span>
              <span>
                <strong>6 min</strong> median
              </span>
            </div>
            <div className="login-preview-row">
              <span className="preview-thumb">
                <span className="preview-dot" />
              </span>
              <span>
                <strong>Vehicle loitering</strong>
                <small>Kerb-side · 12 min ago</small>
              </span>
              <em className="preview-badge warn">High</em>
            </div>
            <div className="login-preview-row">
              <span className="preview-thumb">
                <span className="preview-dot blue" />
              </span>
              <span>
                <strong>Restricted entry</strong>
                <small>Perimeter Walk · 34 min ago</small>
              </span>
              <em className="preview-badge">Normal</em>
            </div>
            <div className="login-preview-row">
              <span className="preview-thumb">
                <span className="preview-dot green" />
              </span>
              <span>
                <strong>Resident lead resolved</strong>
                <small>Reply shared · 1 h ago</small>
              </span>
              <em className="preview-badge ok">Done</em>
            </div>
            <div className="login-preview-foot">
              Every alert waits for a person to review it.
            </div>
          </div>
        </section>
        <section className="glass glass-card">
          <form className="glass-form" onSubmit={submit}>
            <div className="glass-card-head">
              <h2>Sign in</h2>
              <p>For property managers and security supervisors.</p>
            </div>
            <Field label="Email address">
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password">
              <span className="password-input">
                <input
                  type={show ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  onClick={() => setShow(!show)}
                  aria-label={show ? "Hide password" : "Show password"}
                  aria-pressed={show}
                >
                  {show ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </span>
            </Field>
            {message && (
              <p className="glass-error" role="alert">
                <AlertCircle size={15} />
                {message}
              </p>
            )}
            <button type="submit" className="glass-btn" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
              <ArrowRight size={17} />
            </button>
            <button
              type="button"
              className="glass-demo"
              onClick={useDemo}
              disabled={busy}
            >
              <ShieldCheck size={16} />
              <span>
                Enter demo workspace
                <small>Prepared data · one click</small>
              </span>
              <ArrowRight size={16} />
            </button>
            <details className="glass-help">
              <summary>
                <KeyRound size={14} />
                Demo credentials
                <ChevronRight size={14} className="glass-help-chevron" />
              </summary>
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
            </details>
          </form>
          <div className="glass-divider">or</div>
          <a className="glass-resident" href="/resident">
            <span className="glass-resident-icon">
              <MessageSquare size={16} />
            </span>
            <span>
              Resident? Make a quick report
              <small>No staff account needed</small>
            </span>
            <ChevronRight size={16} />
          </a>
        </section>
      </main>
      <footer className="glass-foot">
        <ul>
          <li>
            <Cpu size={15} />
            Processed on local hardware
          </li>
          <li>
            <Activity size={15} />
            Behaviour, not identity
          </li>
          <li>
            <UserCheck size={15} />
            Human review on every alert
          </li>
        </ul>
        <span>
          <ShieldCheck size={14} />
          Recordings are analysed on this workspace's own hardware.
        </span>
      </footer>
    </div>
  );
}
function LoginMap() {
  return (
    <svg
      className="login-map"
      viewBox="0 0 600 900"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <g fill="none" stroke="currentColor">
        <path d="M-20 300H640" strokeWidth="14" opacity=".35" />
        <path d="M410-20V920" strokeWidth="18" opacity=".45" />
        <path
          d="M-20 615c140-50 240 30 380-20s200-70 280-30"
          strokeWidth="24"
          opacity=".45"
        />
        <g strokeWidth="1.5" opacity=".8">
          <rect x="440" y="40" width="125" height="80" rx="6" />
          <rect x="440" y="140" width="125" height="125" rx="6" />
          <rect x="440" y="335" width="70" height="95" rx="6" />
          <rect x="522" y="335" width="60" height="95" rx="6" />
          <rect x="440" y="450" width="142" height="110" rx="6" />
          <rect x="290" y="335" width="95" height="150" rx="6" />
          <rect x="290" y="40" width="95" height="225" rx="6" />
        </g>
      </g>
      <path
        d="M-10 770q160-60 310 0t310-15V910H-10Z"
        fill="currentColor"
        opacity=".3"
      />
      {[
        [410, 300],
        [480, 615],
        [337, 520],
      ].map(([x, y], i) => (
        <g key={i} className="map-point">
          <circle
            cx={x}
            cy={y}
            r="16"
            className="map-pulse"
            style={{ animationDelay: i * 0.9 + "s" }}
          />
          <circle cx={x} cy={y} r="4" />
        </g>
      ))}
    </svg>
  );
}
