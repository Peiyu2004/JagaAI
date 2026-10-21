import { useEffect, useState, type FormEvent } from "react";
import { Plus, Check, X, UserCheck, Home, Phone, Mail, Clock3 } from "lucide-react";
import { useApp } from "../context";
import { api, json, relativeTime, roleLabel } from "../api";
import type { Account, Role } from "../types";
import { Panel, Field, Empty, Badge } from "../components/shared";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";

type AccountsResponse = { accounts: Account[]; manageable_roles: Role[] };
const blank = { name: "", email: "", phone: "", password: "", role: "guard" as Role };

export default function Accounts() {
  const { data, run } = useApp();
  const [result, setResult] = useState<AccountsResponse | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"staff" | "residents">("staff");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(blank);
  const load = () =>
    api<AccountsResponse>("/accounts")
      .then((r) => {
        setResult(r);
        setError("");
      })
      .catch((e) => setError(e.message));
  // Bootstrap refreshes on every account change, so reload with it.
  useEffect(() => {
    load();
  }, [data]);
  const accounts = result?.accounts || [];
  const pending = accounts.filter((a) => a.role === "resident" && a.status === "pending");
  const listed = accounts.filter((a) =>
    tab === "staff" ? a.role !== "resident" : a.role === "resident" && a.status !== "pending",
  );
  const manageable = new Set(result?.manageable_roles || []);
  const setStatus = (account: Account, status: "active" | "disabled", message: string) =>
    run(
      () => api("/accounts/" + account.id, { method: "PATCH", body: json({ status }) }),
      message,
    );
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(
      () => api("/accounts", { method: "POST", body: json(draft) }),
      `${roleLabel(draft.role)} account created`,
    );
    if (ok) {
      setCreating(false);
      setDraft(blank);
    }
  };
  return (
    <div className="role-page">
      {error && <div className="error-banner">{error}</div>}
      <Panel
        className="approval-panel"
        title={`Waiting for approval${pending.length ? ` · ${pending.length}` : ""}`}
      >
        <p className="panel-description">
          Residents register themselves at the sign-in page. Check the unit
          against your records before approving; they can sign in right after.
        </p>
        {pending.length ? (
          <ul className="approval-list">
            {pending.map((a) => (
              <li key={a.id}>
                <span className="set-avatar">{a.name[0]}</span>
                <span className="approval-person">
                  <strong>{a.name}</strong>
                  <small>
                    <Home size={12} /> Unit {a.unit || "—"}
                    <Phone size={12} /> {a.phone || "—"}
                    <Mail size={12} /> {a.email}
                  </small>
                  <small>
                    <Clock3 size={12} /> Registered {relativeTime(a.created_at)}
                  </small>
                </span>
                <span className="approval-actions">
                  <Button size="sm" onClick={() => setStatus(a, "active", `${a.name} approved`)}>
                    <Check size={14} /> Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setStatus(a, "disabled", `${a.name}'s registration was rejected`)}
                  >
                    <X size={14} /> Reject
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty
            compact
            icon={UserCheck}
            title="No registrations waiting"
            text="New resident sign-ups appear here for verification."
          />
        )}
      </Panel>
      <div className="role-toolbar">
        <div className="role-filters" role="tablist" aria-label="Account type">
          <button
            role="tab"
            aria-selected={tab === "staff"}
            className={tab === "staff" ? "active" : ""}
            onClick={() => setTab("staff")}
          >
            Staff
            <span>{accounts.filter((a) => a.role !== "resident").length}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === "residents"}
            className={tab === "residents" ? "active" : ""}
            onClick={() => setTab("residents")}
          >
            Residents
            <span>{accounts.filter((a) => a.role === "resident" && a.status !== "pending").length}</span>
          </button>
        </div>
        <Button
          onClick={() => {
            setDraft(blank);
            setCreating(true);
          }}
        >
          <Plus size={16} /> Create account
        </Button>
      </div>
      <Panel className="accounts-panel">
        {listed.length ? (
          <ul className="account-list">
            {listed.map((a) => (
              <li key={a.id} className={a.status === "disabled" ? "is-disabled" : ""}>
                <span className={"set-avatar " + (a.role === "admin" ? "is-admin" : "")}>{a.name[0]}</span>
                <span className="set-person">
                  <strong>
                    {a.name}
                    {a.id === data.user.id && <span className="you-label">You</span>}
                  </strong>
                  <small title={a.email}>
                    {a.email}
                    {a.unit && ` · Unit ${a.unit}`}
                  </small>
                </span>
                <Badge value={a.role}>{roleLabel(a.role)}</Badge>
                <Badge value={a.status} />
                <span className="account-action">
                  {a.id !== data.user.id && manageable.has(a.role) &&
                    (a.status === "active" ? (
                      <Button size="sm" variant="ghost" onClick={() => setStatus(a, "disabled", `${a.name} disabled`)}>
                        Disable
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setStatus(a, "active", `${a.name} enabled`)}>
                        Enable
                      </Button>
                    ))}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty compact title="No accounts yet" text="Create an account to give someone access." />
        )}
      </Panel>
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="Create an account"
        description="The person signs in at the same page as everyone else and lands in their own workspace."
      >
        <form className="stack-form" onSubmit={create}>
          <Field label="Role">
            <select
              value={draft.role}
              onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })}
            >
              {(["guard", "manager", "admin", "resident"] as Role[])
                .filter((r) => manageable.has(r))
                .map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Full name">
            <input
              required
              minLength={2}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <div className="form-pair">
            <Field label="Email">
              <input
                type="email"
                required
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              />
            </Field>
            <Field label="Phone">
              <input
                type="tel"
                value={draft.phone}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Temporary password" hint="At least 8 characters. Share it privately.">
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
            />
          </Field>
          <Button type="submit">Create account</Button>
        </form>
      </Dialog>
    </div>
  );
}
