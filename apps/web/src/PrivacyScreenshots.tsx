import { useEffect, useState, type ReactNode, type PointerEvent } from 'react';
import { Loader2, ShieldCheck, Undo2 } from 'lucide-react';
import { api, post, label, localTime } from './api';
import './privacy.css';
type Row = Record<string, any>;
type Mask = { x:number; y:number; w:number; h:number };

export function SharedScreenshots({ screenshots, renderPhoto }: { screenshots?:Row[]; renderPhoto:(id:string)=>ReactNode }) {
  if (!screenshots?.length) return null;
  return <section className="detail-section shared-screenshots"><h3><ShieldCheck size={18}/>Treatment screenshots</h3><p className="subtle">Reviewed copies with privacy masking.</p>{screenshots.map(s=><figure key={s.id}>{renderPhoto(s.mediaId)}<figcaption><strong>{s.caption}</strong><span className="subtle">Shared {localTime(s.sharedAt)}</span></figcaption></figure>)}</section>;
}

export function PrivacyScreenshots({ incident, onShared }: { incident:Row; onShared:()=>void }) {
  const [data,setData]=useState<Row>({drafts:[],shares:[]}), [error,setError]=useState(''), [busy,setBusy]=useState(false);
  const [preview,setPreview]=useState<Row|null>(null), [checked,setChecked]=useState(false), [caption,setCaption]=useState(''), [loaded,setLoaded]=useState(false);
  const [masks,setMasks]=useState<Mask[]>([]), [start,setStart]=useState<{x:number;y:number}|null>(null), [drawing,setDrawing]=useState<Mask|null>(null);
  const photos=(incident.evidence||[]).filter((e:Row)=>e.kind==='photo' && !e.unavailable);
  useEffect(()=>{ let active=true; const refresh=()=>api(`/incidents/${incident.id}/privacy`).then(x=>{if(active)setData(x)}).catch(e=>{if(active)setError(e.message)}); refresh(); const timer=setInterval(refresh,3000);return()=>{active=false;clearInterval(timer)}; },[incident.id]);
  const selected=data.drafts.find((d:Row)=>d.id===preview?.draftId);
  useEffect(()=>{if(preview && selected && (selected.revision!==preview.revision || selected.status!=='ready')) {setPreview(null);setMasks([]);setChecked(false)}},[selected?.revision,selected?.status]);
  async function refresh(){setData(await api(`/incidents/${incident.id}/privacy`))}
  async function action(work:()=>Promise<void>){setBusy(true);setError('');try{await work()}catch(e:any){setError(e.message)}finally{setBusy(false)}}
  async function open(draft:Row){await action(async()=>{
    setPreview(null);setLoaded(false);setChecked(false);setMasks([]);setCaption('');
    const viewed=await post(`/incidents/${incident.id}/privacy/${draft.id}/view`), access=await api(`/media/${viewed.mediaId}/access`);
    setPreview({...viewed,draftId:draft.id,url:access.url});
  })}
  function point(e:PointerEvent<HTMLDivElement>){const b=e.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),y:Math.max(0,Math.min(1,(e.clientY-b.top)/b.height))}}
  function rectangle(a:{x:number;y:number},b:{x:number;y:number}):Mask{return{x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.abs(a.x-b.x),h:Math.abs(a.y-b.y)}}
  if (!photos.length) return null;
  return <section className="privacy-screenshots detail-section"><div className="privacy-heading"><ShieldCheck size={19}/><h3>Share a privacy-masked screenshot</h3></div><p className="subtle">Faces and plates are covered locally. Check for missed details and add extra covers before sending a copy to residents linked to this case.</p>
    {photos.map((photo:Row)=>{const draft=data.drafts.find((d:Row)=>d.evidenceId===photo.id), published=draft&&data.shares.find((s:Row)=>s.draftId===draft.id&&s.status==='published');return <article className="privacy-photo" key={photo.id}>
      <div className="card-top"><strong>{photo.description||'Evidence photo'}</strong><span className="badge">{published?'Shared with residents':draft?label(draft.status):'Internal only'}</span></div>
      {draft?.lastError&&<p className="form-error">{draft.lastError} The original will not be sent.</p>}
      {draft&&['queued','processing'].includes(draft.status)&&<p className="retrieval-wait"><Loader2 size={16} className="spin"/>Preparing a local masked copy…</p>}
      {draft?.status==='ready'&&<><p className="subtle">Covered regions: {draft.counts?.face||0} face(s), {draft.counts?.plate||0} plate(s), {draft.counts?.manual||0} extra. No detected regions does not guarantee there are none.</p><button className="button secondary small" disabled={busy} onClick={()=>open(draft)}>Review masked screenshot</button></>}
      {draft?.status==='ready'&&!published&&<button className="button secondary small" disabled={busy} onClick={()=>action(async()=>{await post(`/incidents/${incident.id}/evidence/${photo.id}/privacy`,{retry:true});setPreview(null);setChecked(false);await refresh()})}>Rebuild local masking</button>}
      {(!draft||['failed','expired'].includes(draft.status))&&<button className="button secondary small" disabled={busy||draft?.status==='expired'} onClick={()=>action(async()=>{await post(`/incidents/${incident.id}/evidence/${photo.id}/privacy`,{retry:true});await refresh()})}>{draft?'Retry local masking':'Prepare masked screenshot'}</button>}
      {published&&<button className="button secondary small" disabled={busy} onClick={()=>action(async()=>{await post(`/incidents/${incident.id}/privacy/${draft.id}/withdraw`);await refresh();onShared()})}>Withdraw resident screenshot</button>}
      {preview&&preview.draftId===draft?.id&&selected&&<div className="privacy-review"><p className="privacy-help">Drag over the image to cover a missed detail. Automatic covers stay in place. On touchscreens, drag directly on the image.</p>
        <div className="privacy-canvas" aria-label="Masked screenshot; drag to add a cover" onPointerDown={e=>{if(!loaded||busy)return;e.currentTarget.setPointerCapture(e.pointerId);setStart(point(e));setDrawing(null);setChecked(false)}} onPointerMove={e=>{if(start)setDrawing(rectangle(start,point(e)))}} onPointerUp={e=>{if(!start)return;const r=rectangle(start,point(e));if(r.w>=.005&&r.h>=.005)setMasks(old=>[...old,r]);setStart(null);setDrawing(null)}} onPointerCancel={()=>{setStart(null);setDrawing(null)}}>
          <img src={preview.url} alt="Locally masked treatment screenshot" draggable={false} onLoad={()=>setLoaded(true)} onError={()=>{setLoaded(false);setError('Preview access expired. Open the masked screenshot again.')}}/>
          {[...masks,...(drawing?[drawing]:[])].map((r,i)=><span key={i} className="privacy-extra-cover" style={{left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.w*100}%`,height:`${r.h*100}%`}}/>)}</div>
        <div className="candidate-actions"><button className="button secondary small" disabled={busy||!masks.length} onClick={()=>setMasks(old=>old.slice(0,-1))}><Undo2 size={14}/>Undo extra cover</button><button className="button secondary small" disabled={busy||!loaded} onClick={()=>{setMasks([{x:0,y:0,w:1,h:1}]);setChecked(false)}}>Cover entire image</button>{masks.length>0&&<button className="button primary small" disabled={busy||masks.length+(selected.manualMasks?.length||0)>40} onClick={()=>action(async()=>{await post(`/incidents/${incident.id}/privacy/${selected.id}/masks`,{revision:selected.revision,manualMasks:[...(selected.manualMasks||[]),...masks]});setPreview(null);setMasks([]);setChecked(false);await refresh()})}>Apply {masks.length} extra cover(s)</button>}</div>
        {masks.length>0&&<p className="privacy-help">Apply your extra covers, then reopen the updated preview before sending.</p>}
        {!published&&<form onSubmit={e=>{e.preventDefault();action(async()=>{await post(`/incidents/${incident.id}/privacy/${selected.id}/share`,{revision:preview.revision,receipt:preview.receipt,reviewed:checked,caption});setPreview(null);await refresh();onShared()})}}><label className="field"><span>Resident screenshot caption</span><textarea required minLength={3} maxLength={1000} rows={2} value={caption} onChange={e=>setCaption(e.target.value)} placeholder="Explain the treatment result without naming unrelated people…"/></label><label className="candidate-check"><input type="checkbox" checked={checked} disabled={!loaded||masks.length>0} onChange={e=>setChecked(e.target.checked)}/>I checked this screenshot and covered unrelated faces, plates and other private details.</label><button className="button primary" disabled={busy||!loaded||!checked||masks.length>0||caption.trim().length<3}><ShieldCheck size={16}/>Send masked screenshot to residents</button></form>}
      </div>}
    </article>})}{error&&<p className="form-error" role="alert">{error}</p>}
  </section>;
}
