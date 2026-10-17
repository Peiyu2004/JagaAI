import { useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, Loader2, Search, ShieldCheck, Video } from 'lucide-react';
import { api, post, label, localTime } from './api';
type Row = Record<string, any>;
const statuses: Record<string, string> = { not_requested: 'Not requested', queued: 'Queued', waiting_media: 'Waiting for recordings', waiting_analysis: 'Analysing recordings', waiting_index: 'Building search index', processing: 'Searching locally', completed: 'Ready for human review', failed: 'Needs attention', cancelled: 'Cancelled' };
export function ReportAIProgress({ state }: { state?: Row }) {
  if (!state || state.status === 'not_requested') return null;
  const messages: Record<string, string> = { queued: 'Your report is queued for a private evidence review.', analysing: 'Relevant recordings are being analysed locally.', indexing: 'Relevant evidence is being prepared for review.', searching: 'A private evidence search is in progress.', awaiting_review: 'Your report is awaiting staff review.', staff_review: 'The community team will review your report and available evidence.', linked_to_incident: 'Your report is linked to a case for follow-up.', cancelled: 'The evidence search has stopped. Follow the public case updates below.' };
  return <div className="report-ai-public"><ShieldCheck size={17} /><p>{messages[state.status] || 'Your report is being reviewed.'} Recordings are visible only to authorised staff.</p></div>;
}

export function ReportRetrieval({ report, members, incidents, renderPlayer, onDispatched }: {
  report: Row; members: Row[]; incidents: Row[]; renderPlayer: (video: Row) => ReactNode; onDispatched: (incident: Row) => void;
}) {
  const [data, setData] = useState<Row | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Row | null>(null), [receipts, setReceipts] = useState<Record<string, string>>({});
  const [note, setNote] = useState(''), [reviewed, setReviewed] = useState(false), [excluded, setExcluded] = useState<Record<string, boolean>>({});
  const [incidentId, setIncidentId] = useState(report.incidentId || '');
  useEffect(() => {
    let active = true;
    const refresh = () => api(`/reports/${report.id}/retrieval`).then(result => { if (active) setData(result); }).catch(e => { if (active) setError(e.message); });
    refresh(); const timer = setInterval(refresh, 4000);
    return () => { active = false; clearInterval(timer); };
  }, [report.id]);
  async function refresh() { setData(await api(`/reports/${report.id}/retrieval`)); }
  async function action(work: () => Promise<void>) { setBusy(true); setError(''); try { await work(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }
  async function view(candidate: Row) { await action(async () => {
    const result = await post(`/reports/${report.id}/candidates/${candidate.id}/view`);
    setReceipts(old => ({ ...old, [candidate.id]: result.receipt })); setNote(''); setReviewed(false); setPreview({ ...result, candidateId: candidate.id });
  }); }
  async function review(candidate: Row, decision: string) { await action(async () => {
    if (!reviewed || note.trim().length < 3) throw Error('Confirm that you reviewed the clip and add a review note.');
    await post(`/reports/${report.id}/candidates/${candidate.id}/review`, { decision, note, reviewed: true, receipt: receipts[candidate.id] });
    setPreview(null); setNote(''); setReviewed(false); await refresh();
  }); }
  const job = data?.job, candidates: Row[] = data?.candidates || [];
  const approved = candidates.filter(c => c.reviewStatus === 'approved' && !c.expiredAt), selected = approved.filter(c => !excluded[c.id]);
  const running = job && ['queued', 'processing', 'waiting_media', 'waiting_analysis', 'waiting_index'].includes(job.status);
  const closed = ['resolved', 'rejected'].includes(report.status);
  const stage = data?.dispatch ? 'Work order dispatched' : job?.status === 'completed' && candidates.length && !candidates.some(c => c.reviewStatus === 'pending_review' && !c.expiredAt) ? 'Review complete' : statuses[job?.status || 'not_requested'];
  return <section className="report-retrieval"><div className="retrieval-heading"><div><span className="eyebrow">PRIVATE EVIDENCE REVIEW</span><h3><Search size={18} />Report → footage → response</h3></div><span className={`badge badge-${job?.status || 'neutral'}`}>{stage}</span></div>
    <p className="subtle">This report automatically searches recordings from cameras registered at its location, within the reported time. AI suggests candidates; you decide which evidence is relevant.</p>
    {job && <div className="retrieval-scope"><strong>Search window</strong><span>{localTime(job.scope.timeFrom, { year: 'numeric', second: '2-digit' })} → {localTime(job.scope.timeTo, { year: 'numeric', second: '2-digit' })} · Malaysia time</span>{job.coverage && <span>{job.coverage.totalVideos || 0} recording(s) · {job.coverage.indexedSegments || 0} indexed segment(s){job.partial ? ' · incomplete coverage' : ''}</span>}</div>}
    {running && <p className="retrieval-wait"><Loader2 size={16} className="spin" />{job.message || 'The local worker is preparing this report’s evidence search.'}</p>}
    {job?.lastError && <p className="form-error">{job.lastError}</p>}
    {!running && !data?.dispatch && <button className="button secondary small" disabled={busy || closed} onClick={() => action(async () => { await post(`/reports/${report.id}/retrieval`); setPreview(null); setReceipts({}); await refresh(); })}><Search size={15} />{job ? 'Run retrieval again' : 'Start private retrieval'}</button>}
    {candidates.length > 0 && <p className="retrieval-notice">Closest candidate clips, not confirmed matches. Review the visible facts and limitations. Similarity is a ranking score, not evidence of intent or responsibility.</p>}
    {candidates.map(c => <article className="report-candidate" key={c.id}><div className="card-top"><strong>{Math.round(c.startSec * 10) / 10}–{Math.round(c.endSec * 10) / 10}s · {localTime(c.absoluteStartAt, { second: '2-digit' })}</strong><span className="badge">{c.expiredAt ? 'Outside retention' : label(c.reviewStatus)}</span></div>
      <p>{c.summary || 'The source recording has expired; the review history is retained.'}</p>{c.uncertainties?.length > 0 && <p className="visual-uncertainty">Visibility limits: {c.uncertainties.join(' ')}</p>}
      {!c.expiredAt && <div className="candidate-actions"><button className="button secondary small" disabled={busy} onClick={() => view(c)}><Video size={15} />View bounded clip</button><span className="subtle">{typeof c.score === 'number' ? `Similarity ${c.score.toFixed(3)} · ranking only` : ''}</span></div>}
      {c.reviewNote && <p className="human-review-note"><CheckCircle2 size={15} />Human review: {c.reviewNote}</p>}
      {c.reviewStatus === 'approved' && !c.expiredAt && !data?.dispatch && <label className="candidate-check"><input type="checkbox" checked={!excluded[c.id]} onChange={e => setExcluded(old => ({ ...old, [c.id]: !e.target.checked }))} />Attach this approved clip to the case</label>}
      {preview && preview.candidateId === c.id && <div className="candidate-viewer">{renderPlayer(preview.video)}{c.reviewStatus === 'pending_review' && <><label className="field"><span>Human review note</span><textarea aria-label="Human review note" value={note} onChange={e => setNote(e.target.value)} rows={3} maxLength={2000} placeholder="What can you see, and why is this clip relevant or unrelated?" /></label><label className="candidate-check"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />I have reviewed this clip and its visibility limits.</label><div className="candidate-actions"><button className="button primary small" disabled={busy || !reviewed || note.trim().length < 3} onClick={() => review(c, 'approve')}>Approve as relevant evidence</button><button className="button secondary small" disabled={busy || !reviewed || note.trim().length < 3} onClick={() => review(c, 'dismiss')}>Dismiss candidate</button></div></>}</div>}
    </article>)}
    {job?.status === 'completed' && !candidates.length && <p className="retrieval-notice">No candidate clips were available in the searched coverage. This does not show that the reported issue did not happen. You can handle the report manually using the actions below.</p>}
    {data?.dispatch ? <div className="review-note"><CheckCircle2 size={19} /><div><strong>Reviewed evidence linked and work order dispatched</strong><p>The assigned team can access only the approved case clips.</p><button className="text-button" onClick={() => { const incident = incidents.find(i => i.id === data.dispatch.incidentId); if (incident) onDispatched(incident); else api(`/incidents/${data.dispatch.incidentId}`).then(onDispatched).catch(e => setError(e.message)); }}>Open linked incident</button></div></div> : approved.length > 0 && <form className="reviewed-dispatch" onSubmit={e => { e.preventDefault(); const fields = new FormData(e.currentTarget); action(async () => {
      if (!selected.length) throw Error('Select at least one human-approved clip.');
      const result = await post(`/reports/${report.id}/dispatch`, { candidateIds: selected.map(c => c.id), incidentId: report.incidentId || incidentId || undefined,
        title: fields.get('title') || undefined, category: report.category, priority: fields.get('priority'), assigneeId: fields.get('assigneeId'), instructions: fields.get('instructions') });
      await refresh(); onDispatched(result.incident);
    }); }}><h3>Link evidence & dispatch</h3><p className="subtle">{selected.length} approved clip(s) selected. Choose a case and the responsible team member.</p><label className="field"><span>Incident</span><select value={incidentId} disabled={Boolean(report.incidentId)} onChange={e => setIncidentId(e.target.value)}><option value="">Create a new incident</option>{incidents.filter(i => i.locationId === report.locationId && ['open', 'assigned', 'in_progress'].includes(i.status)).map(i => <option key={i.id} value={i.id}>{i.title}</option>)}</select></label>
      {!incidentId && !report.incidentId && <label className="field"><span>New incident title</span><input name="title" required minLength={5} maxLength={180} defaultValue={`${label(report.category)} follow-up · ${report.number || 'resident report'}`} /></label>}
      <div className="form-grid"><label className="field"><span>Assign property / security staff</span><select name="assigneeId" required defaultValue=""><option value="">Select the responsible person</option>{['maintenance', 'guard'].map(role => <optgroup key={role} label={role === 'maintenance' ? 'Property team' : 'Security team'}>{members.filter(m => m.role === role && m.membershipStatus === 'active').map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</optgroup>)}</select></label><label className="field"><span>Priority</span><select name="priority" defaultValue="normal"><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option><option value="low">Low</option></select></label></div>
      <label className="field"><span>Work instructions (team only)</span><textarea name="instructions" required minLength={3} maxLength={2000} rows={3} placeholder="Describe what the assigned team should inspect or do…" /></label><button className="button primary" disabled={busy || !selected.length || closed}>{busy ? <Loader2 size={16} className="spin" /> : <ShieldCheck size={16} />}Link approved clips & dispatch</button></form>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
