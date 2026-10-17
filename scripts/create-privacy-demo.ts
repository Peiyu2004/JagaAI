/** Creates a labelled local QA case. Does not upload, approve or share any image. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const base='http://127.0.0.1:4000/api';
const existing=await readFile('data/privacy-demo/manifest.json','utf8').catch(()=>undefined);
if(existing){console.log(existing);process.exit(0)}
async function login(email:string){const r=await fetch(`${base}/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'JagaLocal!2026'})});if(!r.ok)throw Error('Local demo login failed');return r.headers.get('set-cookie')!.split(';')[0]}
async function post(route:string,cookie:string,body:any){const r=await fetch(`${base}${route}`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error(value.error);return value}
const resident=await login('resident@jaga.local'),manager=await login('manager@jaga.local');
const at=new Date().toISOString();
const report=await post('/reports',resident,{category:'maintenance',locationId:'loc_block',description:'[Privacy QA] Simulated screenshot handoff. Public test imagery is used; this is not a resident incident.',timeFrom:at,timeTo:at});
const incident=await post('/incidents',manager,{title:'[Privacy QA] Screenshot handoff',category:'maintenance',locationId:'loc_block',priority:'normal',reportId:report.id});
await post(`/incidents/${incident.id}/assignments`,manager,{assigneeId:'user_maintenance',instructions:'[Privacy QA] Test the local masking and resident screenshot workflow. No real inspection has taken place.'});
const result={createdAt:at,syntheticWorkflow:true,publicTestImagery:true,reportId:report.id,reportNumber:report.number,incidentId:incident.id};
await mkdir('data/privacy-demo',{recursive:true});await writeFile('data/privacy-demo/manifest.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
