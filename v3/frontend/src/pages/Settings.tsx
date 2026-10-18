import { tabKeys } from "../components/tabKeys";
import { useState, useEffect, type FormEvent } from "react";
import {
  Plus,
  Users,
  ShieldCheck,
  Save,
  Pencil,
  History,
  Info,
} from "lucide-react";
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
  return (
    <>
      <div className="tabs" role="tablist" onKeyDown={tabKeys} aria-label="Settings category">
        {[
          ["team", "Team & access"],
          ["policy", "Data policy"],
          ...(admin ? [["audit", "Audit log"]] : []),
        ].map(([id, title]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            role="tab"
            aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
          >
            {title}
          </button>
        ))}
      </div>
      {error && <div className="error-banner">{error}</div>}
      {tab === "team" && (
        <>
          <Panel
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
            {(settings?.guards || data.guards).length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Shift</th>
                      <th>Phone</th>
                      {admin && (
                        <th>
                          <span className="sr-only">Actions</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {(settings?.guards || data.guards).map((g) => (
                      <tr key={g.id}>
                        <td>
                          <span className="table-person">
                            <span className="avatar">{g.name[0]}</span>
                            <strong>{g.name}</strong>
                          </span>
                        </td>
                        <td>{g.shift}</td>
                        <td>
                          <a href={"tel:" + g.phone}>{g.phone}</a>
                        </td>
                        {admin && (
                          <td>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openGuard(g)}
                            >
                              <Pencil size={14} /> Edit
                            </Button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
              title="Staff accounts"
              action={
                <Button size="sm" variant="outline" onClick={addUser}>
                  <Plus size={15} /> Add staff account
                </Button>
              }
            >
              <p className="panel-description">
                Administrators manage workspace access. Supervisors handle daily
                security operations.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settings?.users?.map((u) => (
                      <tr key={u.id}>
                        <td>
                          <strong>{u.name}</strong>
                          {u.id === data.user.id && (
                            <span className="you-label">You</span>
                          )}
                        </td>
                        <td>{u.email}</td>
                        <td>
                          <Badge value={u.role}>
                            {u.role === "admin"
                              ? "Administrator"
                              : "Supervisor"}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
          <Panel title="Access boundaries">
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
                  ].map(([capability, admin, supervisor, resident]) => (
                    <tr key={capability}>
                      <td>{capability}</td>
                      <td>{admin}</td>
                      <td>{supervisor}</td>
                      <td>{resident}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="access-grid">
              <div>
                <ShieldCheck size={22} />
                <h3>Staff workspace</h3>
                <p>
                  Admins and supervisors can review footage, handle leads and
                  update incidents. Viewing private recordings is audited.
                </p>
              </div>
              <div>
                <Users size={22} />
                <h3>Resident reporting</h3>
                <p>
                  Residents see only their own report status and public replies.
                  They cannot access cameras, recordings or management records.
                </p>
              </div>
            </div>
          </Panel>
        </>
      )}
      {tab === "policy" && (
        <Panel title="Recording retention & search">
          <form className="policy-form" onSubmit={savePolicy}>
            <Field
              label="Recording retention (days)"
              hint="Expired recordings and their derived tracks, events and keyframes are removed. Human review decisions are kept."
            >
              <input
                type="number"
                min="1"
                max="365"
                required
                value={days}
                disabled={!admin}
                onChange={(e) => setDays(Number(e.target.value))}
              />
            </Field>
            <div className="policy-impact">
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
            </Field>
            {admin ? (
              <Button type="submit">
                <Save size={16} /> Save data policy
              </Button>
            ) : (
              <div className="info-strip">
                <Info size={16} />
                Only administrators can change data policies.
              </div>
            )}
          </form>
        </Panel>
      )}
      {tab === "audit" && admin && (
        <Panel
          title="Audit log"
          action={<span className="panel-subtle">Most recent activity</span>}
        >
          {settings?.audit_logs?.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When (MYT)</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Record</th>
                  </tr>
                </thead>
                <tbody>
                  {settings.audit_logs.map((log) => (
                    <tr key={log.id}>
                      <td className="mono">{dateTime(log.created_at)}</td>
                      <td>
                        {settings.users?.find((u) => u.id === log.actor_id)
                          ?.name ||
                          log.actor_id ||
                          "System"}
                      </td>
                      <td>{label(log.action)}</td>
                      <td className="audit-target" title={log.target}>
                        {log.target}
                      </td>
                    </tr>
                  ))}
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
    </>
  );
}
