import { useEffect, useState } from "react";
import { Check, MapPin, ShieldCheck, Clock3, RefreshCw } from "lucide-react";
import { dateTime, label } from "./api";
import { Brand } from "./components/shared";
import { Button } from "./components/ui/button";

type GuardNotice = {
  title: string; location: string; priority: string; event_at: string; status: string;
  mode: string; reason: string; guard_name: string; acknowledged_name: string; acknowledged_at: string | null;
};

export default function GuardResponse() {
  const [notice, setNotice] = useState<GuardNotice | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [link] = useState(() => {
    const [dispatch_id, guard_id, token] = location.hash.slice(1).split("/");
    return {dispatch_id, guard_id, token};
  });
  const request = async (accept = false) => {
    if (!link.dispatch_id || !link.guard_id || !link.token) { setError("This guard notification link is incomplete. Open the link in your notification."); return; }
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/guard/" + (accept ? "accept" : "notification"), {method: "POST", credentials: "omit", headers: {"Content-Type": "application/json"}, body: JSON.stringify(link)});
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : "This notification could not be loaded.");
      setNotice(body);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => { request(); }, []);
  const accepted = notice?.status === "acknowledged";
  const open = notice && ["active", "unacknowledged"].includes(notice.status);
  return <main className="guard-page"><div className="guard-wrap"><Brand/>
    <section className="guard-notice" aria-label="Guard response">
      <div className={"guard-symbol " + (accepted ? "is-accepted" : "")}><ShieldCheck size={30}/></div>
      <h1>{accepted ? "Acceptance recorded" : "Security attendance request"}</h1>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {!notice && !error && <p role="status">Loading your notification…</p>}
      {notice && <>
        {notice.mode === "simulate" && <div className="gn-simulation">Simulation only. This is a practice notification.</div>}
        {accepted ? <div className="guard-success" role="status"><Check size={21}/><div><strong>{notice.acknowledged_name} accepted this request.</strong><p>{dateTime(notice.acknowledged_at || undefined)} MYT</p></div></div> : <p className="guard-greeting">For {notice.guard_name}. Review the location and confirm you can attend.</p>}
        <div className="guard-event"><span className={"gn-state gn-state-" + (open ? "active" : notice.status)}>{label(notice.priority)} priority</span><h2>{notice.title}</h2><p><MapPin size={18}/>{notice.location}</p><p><Clock3 size={18}/>{dateTime(notice.event_at)} MYT</p></div>
        {open ? <form onSubmit={e => { e.preventDefault(); if (confirmed && !busy) request(true); }}><p className="gn-note">The event still needs verification. Follow your site's security procedure and report back to the control room.</p><label className="gn-check"><input required type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/><span>I am {notice.guard_name} and can attend this location.</span></label><Button type="submit" disabled={busy || !confirmed}>{busy ? "Recording…" : notice.mode === "simulate" ? "Accept practice request" : "Accept & attend"}</Button></form> : !accepted && <p className="gn-note" role="status">{notice.reason || "This notification is no longer open. Contact the control room."}</p>}
      </>}
      <Button variant="ghost" disabled={busy} onClick={() => request()}><RefreshCw size={15}/>Refresh status</Button>
    </section><p className="guard-footer">JagaAI · Property security<br/>Keep this personal notification link private.</p>
  </div></main>;
}
