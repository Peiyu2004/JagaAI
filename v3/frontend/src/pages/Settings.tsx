import { useState, useEffect, type CSSProperties, type FormEvent } from "react";
import {
  Plus,
  Users,
  ShieldCheck,
  Save,
  Pencil,
  History,
  Info,
  Check,
  Minus,
  Clock3,
  Phone,
  Database,
  Search,
  Film,
} from "lucide-react";
import RubberSegment from "../components/RubberSegment";
import { useApp } from "../context";
import { api, json, dateTime, label } from "../api";
import type { Guard, User, Settings as SettingsType } from "../types";
import { Panel, Field, Empty, Badge } from "../components/shared";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
type Audit = {
  id: string;
  actor_id: string;
  action: string;
  target: string;
  details: unknown;
  created_at: string;
};
type SettingsResponse = {
  settings: SettingsType;
  guards: Guard[];
  users?: User[];
  audit_logs?: Audit[];
};
export default function Settings() {
  const { data, run } = useApp();
  const [tab, setTab] = useState("team");
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState("");
  const [days, setDays] = useState(data.settings.retention_days);
  const [threshold, setThreshold] = useState(data.settings.search_threshold);
  const [dialog, setDialog] = useState<"guard" | "user" | null>(null);
  const [editGuard, setEditGuard] = useState("");
  const [name, setName] = useState("");
  const [shift, setShift] = useState("19:00–07:00");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("supervisor");
  const admin = data.user.role === "admin";
  const load = () =>
    api<SettingsResponse>("/settings")
      .then((r) => {
        setSettings(r);
        setError("");
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [data]);
  const openGuard = (guard?: Guard) => {
    setEditGuard(guard?.id || "");
    setName(guard?.name || "");
    setShift(guard?.shift || "19:00–07:00");
    setPhone(guard?.phone || "");
    setDialog("guard");
  };
  const addUser = () => {
    setName("");
    setEmail("");
    setPassword("");
    setRole("supervisor");
    setDialog("user");
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(
      () =>
        dialog === "guard"
          ? api("/guards" + (editGuard ? "/" + editGuard : ""), {
              method: editGuard ? "PATCH" : "POST",
              body: json({ name, shift, phone }),
            })
          : api("/users", {
              method: "POST",
              body: json({ name, email, password, role }),
            }),
      dialog === "guard" ? "Guard roster saved" : "Staff account created",
    );
    if (ok) {
      setDialog(null);
      load();
    }
  };
  const savePolicy = (e: FormEvent) => {
    e.preventDefault();
    if (
      days < data.settings.retention_days &&
      !window.confirm(
        `Shortening retention to ${days} days can expire existing recordings immediately. Continue?`,
      )
    )
      return;
    run(
      () =>
        api("/settings", {
          method: "PATCH",
          body: json({ retention_days: days, search_threshold: threshold }),
        }),
      "Data policy saved",
    );
  };
  const policyDirty =
    days !== data.settings.retention_days ||
    threshold !== data.settings.search_threshold;
  const guards = settings?.guards || data.guards;
  const matrixCell = (value: string) =>
    value === "Yes" ? (
      <span className="set-yes">
        <Check size={13} strokeWidth={2.6} /> Yes
      </span>
    ) : value === "No" ? (
      <span className="set-no">
        <Minus size={13} /> No
      </span>
    ) : (
      <span className="set-partial">{value}</span>
    );
  return (
    <div className="set-page">
      <div className="set-bar">
        <RubberSegment
          semantics="tabs"
          aria-label="Settings category"
          className="set-switch"
          value={tab}
          onChange={setTab}
          items={[
            { value: "team", label: "Team & access", icon: <Users />, controls: "settings-team" },
            { value: "policy", label: "Data policy", icon: <Database />, controls: "settings-policy" },
            ...(admin
              ? [{ value: "audit", label: "Audit log", icon: <History />, controls: "settings-audit" }]
              : []),
          ]}
        />
        <span className="set-role">
          <ShieldCheck size={15} />
          Signed in as <strong>{admin ? "Administrator" : "Supervisor"}</strong>
        </span>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {tab === "team" && (
        <div
          className={"set-grid set-reveal" + (admin ? "" : " is-single")}
          role="tabpanel"
          id="settings-team"
          aria-label="Team & access"
        >
          <Panel
            className="set-card set-roster"
            title="Duty roster"
            action={
              admin ? (
                <Button size="sm" variant="outline" onClick={() => openGuard()}>
                  <Plus size={15} /> Add guard
                </Button>
              ) : (
                <Badge value="supervisor">View only</Badge>
              )
            }
          >
            <p className="panel-description">
              Assignment records for radio or phone coordination. Guards do not
              have login accounts.
            </p>
            {guards.length ? (
              <ul className="set-people">
                {guards.map((g) => (
                  <li key={g.id}>
                    <span className="set-avatar">{g.name[0]}</span>
                    <span className="set-person">
                      <strong>{g.name}</strong>
                      <small>
                        <Clock3 size={12} /> {g.shift}
                      </small>
                    </span>
                    <a
                      className="set-phone"
                      href={"tel:" + g.phone}
                      aria-label={`Call ${g.name}, ${g.phone}`}
                    >
                      <Phone size={13} />
                      <span>{g.phone}</span>
                    </a>
                    {admin && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={"Edit " + g.name}
                        onClick={() => openGuard(g)}
                      >
                        <Pencil size={14} /> Edit
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty
                compact
                icon={Users}
                title="No guards in the roster"
                text="Add a name, shift and contact number before assigning incidents."
              />
            )}
          </Panel>
          {admin && (
            <Panel
              className="set-card set-staff"
              title="Staff accounts"
              action={
                <Button size="sm" variant="outline" onClick={addUser}>
                  <Plus size={15} /> Add staff
                </Button>
              }
            >
              <p className="panel-description">
                Administrators manage workspace access. Supervisors handle daily
                security operations.
              </p>
              <ul className="set-people">
                {settings?.users?.map((u) => (
                  <li key={u.id}>
                    <span className={"set-avatar " + (u.role === "admin" ? "is-admin" : "")}>
                      {u.name[0]}
                    </span>
                    <span className="set-person">
                      <strong>
                        {u.name}
                        {u.id === data.user.id && (
                          <span className="you-label">You</span>
                        )}
                      </strong>
                      <small title={u.email}>{u.email}</small>
                    </span>
                    <Badge value={u.role}>
                      {u.role === "admin" ? "Administrator" : "Supervisor"}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel className="set-card set-access" title="Who can do what">
            <div className="access-matrix-wrap">
              <table className="access-matrix">
                <caption className="sr-only">
                  Role permissions in this workspace
                </caption>
                <thead>
                  <tr>
                    <th>Capability</th>
                    <th>Administrator</th>
                    <th>Supervisor</th>
                    <th>Resident</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Review alerts and footage", "Yes", "Yes", "No"],
                    ["Handle resident leads", "Yes", "Yes", "Own report only"],
                    ["Assign guards and update incidents", "Yes", "Yes", "No"],
                    ["Manage people and data policy", "Yes", "No", "No"],
                  ].map(([capability, adminCan, supervisorCan, residentCan]) => (
                    <tr key={capability}>
                      <td>{capability}</td>
                      <td>{matrixCell(adminCan)}</td>
                      <td>{matrixCell(supervisorCan)}</td>
                      <td>{matrixCell(residentCan)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="access-grid">
              <div>
                <ShieldCheck size={20} />
                <h3>Staff workspace</h3>
                <p>
                  Admins and supervisors can review footage, handle leads and
                  update incidents. Viewing private recordings is audited.
                </p>
              </div>
              <div>
                <Users size={20} />
                <h3>Resident reporting</h3>
                <p>
                  Residents see only their own report status and public replies.
                  They cannot access cameras, recordings or management records.
                </p>
              </div>
            </div>
          </Panel>
        </div>
      )}
      {tab === "policy" && (
        <div
          className="set-policy set-reveal"
          role="tabpanel"
          id="settings-policy"
          aria-label="Data policy"
        >
          <Panel
            className="set-card"
            title="Recording retention & search"
            action={
              policyDirty ? (
                <span className="set-dirty">Unsaved changes</span>
              ) : (
                <span className="panel-subtle">Saved</span>
              )
            }
          >
            <form className="policy-form" onSubmit={savePolicy}>
              <Field
                label="Recording retention (days)"
                hint="Expired recordings and their derived tracks, events and keyframes are removed. Human review decisions are kept."
              >
                <span className="set-range">
                  <input
                    type="range"
                    min="1"
                    max="365"
                    value={days}
                    disabled={!admin}
                    aria-label="Recording retention in days"
                    style={{ "--p": `${((days - 1) / 364) * 100}%` } as CSSProperties}
                    onChange={(e) => setDays(Number(e.target.value))}
                  />
                  <input
                    type="number"
                    min="1"
                    max="365"
                    required
                    value={days}
                    disabled={!admin}
                    onChange={(e) => setDays(Number(e.target.value))}
                  />
                </span>
              </Field>
              <div className={"policy-impact" + (days < data.settings.retention_days ? " is-warn" : "")}>
                <Info size={15} />
                <span>
                  This workspace holds {data.videos.length} recording
                  {data.videos.length === 1 ? "" : "s"}. Lowering the retention
                  period can expire existing footage and its derived frames
                  immediately; human review decisions are kept.
                </span>
              </div>
              <Field
                label="Search match threshold"
                hint="Descriptions below this threshold are kept out of confirmed search results and may be offered for manual review."
              >
                <span className="set-range">
                  <input
                    type="range"
                    min="0.1"
                    max="1"
                    step="0.01"
                    value={threshold}
                    disabled={!admin}
                    aria-label="Search match threshold"
                    style={{ "--p": `${((threshold - 0.1) / 0.9) * 100}%` } as CSSProperties}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                  />
                  <input
                    type="number"
                    min="0.1"
                    max="1"
                    step="0.01"
                    required
                    value={threshold}
                    disabled={!admin}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                  />
                </span>
              </Field>
              {admin ? (
                <div className="set-actions">
                  <Button type="submit" disabled={!policyDirty}>
                    <Save size={16} /> Save data policy
                  </Button>
                  {policyDirty && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setDays(data.settings.retention_days);
                        setThreshold(data.settings.search_threshold);
                      }}
                    >
                      Reset
                    </Button>
                  )}
                </div>
              ) : (
                <div className="info-strip">
                  <Info size={16} />
                  Only administrators can change data policies.
                </div>
              )}
            </form>
          </Panel>
          <aside className="set-card set-facts" aria-label="Current policy">
            <span className="set-eyebrow">In force now</span>
            <div className="set-fact">
              <Database size={18} />
              <div>
                <strong>{data.settings.retention_days} days</strong>
                <small>Recordings are kept, then removed with their frames</small>
              </div>
            </div>
            <div className="set-fact">
              <Search size={18} />
              <div>
                <strong>{data.settings.search_threshold.toFixed(2)}</strong>
                <small>Minimum match score for confirmed search results</small>
              </div>
            </div>
            <div className="set-fact">
              <Film size={18} />
              <div>
                <strong>
                  {data.videos.length} recording{data.videos.length === 1 ? "" : "s"}
                </strong>
                <small>Currently held in this workspace</small>
              </div>
            </div>
            <p className="set-facts-note">
              <ShieldCheck size={14} />
              Human review decisions are always kept, even after footage expires.
            </p>
          </aside>
        </div>
      )}
      {tab === "audit" && admin && (
        <div className="set-reveal" role="tabpanel" id="settings-audit" aria-label="Audit log">
          <Panel
            className="set-card"
            title="Audit log"
            action={
              <span className="panel-subtle">
                {settings?.audit_logs?.length || 0} recent entries
              </span>
            }
          >
            {settings?.audit_logs?.length ? (
              <div className="table-wrap">
                <table className="set-audit">
                  <thead>
                    <tr>
                      <th>When (MYT)</th>
                      <th>Actor</th>
                      <th>Action</th>
                      <th>Record</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settings.audit_logs.map((log) => {
                      const actor =
                        settings.users?.find((u) => u.id === log.actor_id)?.name ||
                        log.actor_id ||
                        "System";
                      return (
                        <tr key={log.id}>
                          <td className="mono">{dateTime(log.created_at)}</td>
                          <td>
                            <span className="set-actor">
                              <span className="set-avatar is-small">{actor[0]}</span>
                              {actor}
                            </span>
                          </td>
                          <td>
                            <span className="set-action">{label(log.action)}</span>
                          </td>
                          <td className="audit-target" title={log.target}>
                            {log.target}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                icon={History}
                title="No audit activity yet"
                text="Private footage views and changes to key records are recorded here."
              />
            )}
          </Panel>
        </div>
      )}
      <Dialog
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={
          dialog === "user"
            ? "Add a staff account"
            : editGuard
              ? "Edit guard record"
              : "Add a guard"
        }
        description={
          dialog === "user"
            ? "Create access for a property manager or security supervisor."
            : "A roster record for incident assignment. This does not create a login."
        }
      >
        <form className="stack-form" onSubmit={submit}>
          <Field label="Full name">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {dialog === "guard" ? (
            <>
              <Field label="Shift">
                <input
                  required
                  value={shift}
                  onChange={(e) => setShift(e.target.value)}
                  placeholder="19:00–07:00"
                />
              </Field>
              <Field label="Phone">
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+60…"
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Email">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label="Initial password">
                <input
                  type="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Field label="Role">
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="supervisor">Supervisor</option>
                  <option value="admin">Administrator</option>
                </select>
              </Field>
            </>
          )}
          <Button type="submit">
            {dialog === "user" ? "Create staff account" : "Save guard record"}
          </Button>
        </form>
      </Dialog>
    </div>
  );
}
