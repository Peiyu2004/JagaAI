import { useEffect, useRef, useState } from "react";
import { Mic, PhoneCall, PhoneOff, Send, Volume2 } from "lucide-react";
import { api, json } from "../api";
import { useApp } from "../context";
import type { GuardDispatch, VoiceCallDemo as Call } from "../types";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { results: { [index: number]: { [index: number]: { transcript: string } } } }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null; start: () => void; abort: () => void;
};
const recognitionApi = () => {
  const browser = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return browser.SpeechRecognition || browser.webkitSpeechRecognition;
};

export function VoiceCallDemo({ dispatch }: { dispatch: GuardDispatch }) {
  const { refresh } = useApp();
  const [open, setOpen] = useState(false);
  const [call, setCall] = useState<Call | null>(null);
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState("");
  const [audioNote, setAudioNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [audio, setAudio] = useState(true);
  const [remaining, setRemaining] = useState(90);
  const deadline = useRef(0);
  const recognition = useRef<Recognition | null>(null);
  const lastSpoken = useRef("");
  const transcript = useRef<HTMLOListElement | null>(null);
  const chinese = (call?.language || dispatch.voice_language) === "zh-CN";
  const active = !!call && !call.ended_at && remaining > 0;
  const receive = (next: Call) => {
    deadline.current = Date.now() + next.remaining_sec * 1000;
    setRemaining(Math.ceil(next.remaining_sec)); setCall(next);
  };
  const start = async () => {
    if (busy) return;
    setBusy(true); setError(""); setOpen(true);
    try {
      receive(await api<Call>(`/notifications/${dispatch.id}/voice-demo`, { method: "POST" }));
      void refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const send = async (speech = phrase, digits = "") => {
    if (!call || !active || busy) return;
    setBusy(true); setError("");
    recognition.current?.abort();
    window.speechSynthesis?.cancel();
    try {
      receive(await api<Call>(`/notifications/voice-demo/${call.id}/turn`, {
        method: "POST", body: json({turn: call.turns.length, speech, digits}),
      }));
      setPhrase(""); void refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const end = async () => {
    if (!call || busy) return;
    setBusy(true); recognition.current?.abort(); window.speechSynthesis?.cancel();
    try { receive(await api<Call>(`/notifications/voice-demo/${call.id}/end`, {method: "POST"})); void refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!call || call.ended_at) return;
    const clock = window.setInterval(() => {
      const seconds = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000));
      setRemaining(seconds);
      if (!seconds) { recognition.current?.abort(); window.speechSynthesis?.cancel(); }
    }, 250);
    const poll = window.setInterval(() => {
      api<Call>(`/notifications/voice-demo/${call.id}`).then(receive).catch(e => setError(e.message));
    }, 2000);
    return () => { clearInterval(clock); clearInterval(poll); };
  }, [call?.id, call?.ended_at]);
  useEffect(() => {
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
    const turn = call?.turns.at(-1);
    const key = call && turn ? `${call.id}:${turn.index}` : "";
    if (!open || !audio || !turn || key === lastSpoken.current || !remaining) return;
    lastSpoken.current = key;
    if (!window.speechSynthesis) { setAudioNote("Speech playback is unavailable. The full reply is shown below."); return; }
    const utterance = new SpeechSynthesisUtterance(turn.reply);
    utterance.lang = call!.language;
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find(item => item.lang.toLowerCase().startsWith(chinese ? "zh" : "en"));
    if (voices.length && !voice) {
      setAudioNote(chinese ? "No Mandarin voice is installed in this browser. Chinese replies are shown as text. Use the English rehearsal for spoken playback, or add a Mandarin browser voice." : "No English voice is available in this browser. The full reply is shown as text.");
      return;
    }
    if (voice) utterance.voice = voice;
    utterance.onstart = () => setAudioNote("");
    utterance.onerror = e => { if (e.error !== "canceled" && e.error !== "interrupted") setAudioNote("Speech playback failed. Read the reply below or try another browser voice."); };
    window.speechSynthesis.cancel(); window.speechSynthesis.speak(utterance);
  }, [call, open, audio, remaining]);
  useEffect(() => {
    if (!open) { recognition.current?.abort(); window.speechSynthesis?.cancel(); }
    return () => { recognition.current?.abort(); window.speechSynthesis?.cancel(); };
  }, [open]);
  const listen = () => {
    const Constructor = recognitionApi();
    if (!Constructor || !active) return;
    window.speechSynthesis?.cancel();
    const instance = new Constructor(); recognition.current = instance;
    instance.lang = call!.language; instance.continuous = false; instance.interimResults = false;
    instance.onresult = event => { setPhrase(event.results[0][0].transcript); };
    instance.onerror = event => { setError(`Microphone recognition unavailable (${event.error}). Type a phrase or use the sample buttons.`); };
    instance.onend = () => setListening(false);
    setError("");
    setListening(true);
    try { instance.start(); }
    catch { setListening(false); setError("Microphone could not start. Type a phrase below."); }
  };
  return <>
    <Button variant="outline" size="sm" disabled={busy} onClick={start}><PhoneCall size={14}/>Rehearse call</Button>
    <Dialog open={open} onOpenChange={setOpen} title="Simulated guard call" description="Local rehearsal. No phone is dialled. Questions and acceptance use the same logic as the real call.">
      <div className="gn-call">
        <div className="gn-call-header"><span className="gn-mode is-simulation">Simulation</span><strong role="timer" aria-label="Call time remaining">{call?.ended_at ? "Call ended" : `${remaining}s remaining`}</strong></div>
        <p className="gn-note">{dispatch.location} · {dispatch.primary_name} · {chinese ? "Mandarin Chinese" : "English"}</p>
        {call?.status === "acknowledged" && <p className="gn-accepted" role="status">{call.acknowledged_name} accepted. Saved as a simulation.</p>}
        <ol className="gn-call-transcript" aria-label="Call transcript" ref={transcript} aria-live="polite">
          {call?.turns.map(turn => <li key={turn.index}>
            {turn.input && <p className="gn-call-guard"><strong>Guard</strong>{turn.input}</p>}
            <p><strong>JagaAI</strong>{turn.reply}</p>
          </li>)}
        </ol>
        {call?.ended_at && <p className="gn-note" role="status">{call.end_reason === "time_limit" ? "90-second limit reached." : "The call has ended."} {call.status !== "acknowledged" && "No acceptance recorded. Pending notifications continue."}</p>}
        {error && <p className="gn-error" role="alert">{error}</p>}
        <div className="gn-actions"><label className="gn-check"><input type="checkbox" checked={audio} onChange={e => { setAudio(e.target.checked); lastSpoken.current = ""; if (!e.target.checked) window.speechSynthesis?.cancel(); }}/><span><Volume2 size={14}/> Speak replies</span></label></div>
        {audioNote && <p className="gn-note" role="status">{audioNote}</p>}
        {active && <>
          <div className="gn-call-samples" aria-label="Sample guard phrases">
            {(chinese ? ["在哪里？", "什么情况？", "收到"] : ["Where is it?", "What happened?", "Received"]).map(value => <Button key={value} variant="outline" size="sm" disabled={busy} onClick={() => send(value)}>{value}</Button>)}
          </div>
          <form className="gn-call-form" onSubmit={e => { e.preventDefault(); if (phrase.trim()) void send(); }}>
            <label htmlFor={"guard-speech-" + dispatch.id}>Guard reply / simulated speech transcript</label>
            <input id={"guard-speech-" + dispatch.id} value={phrase} maxLength={500} disabled={busy} onChange={e => setPhrase(e.target.value)} placeholder={chinese ? "例如：在哪里？／收到" : "For example: where is it? / received"}/>
            <div className="gn-actions"><Button type="submit" size="sm" disabled={busy || !phrase.trim()}><Send size={14}/>Send reply</Button><Button type="button" variant="outline" size="sm" disabled={busy || !recognitionApi() || listening} onClick={listen}><Mic size={14}/>{listening ? "Listening…" : "Use microphone"}</Button></div>
          </form>
          <p className="gn-note">Sample buttons and typed text simulate recognition. The microphone fills the text box; review it before sending. Browser recognition may use an online service. It does not test Twilio recognition.</p>
          <div className="gn-actions"><Button variant="outline" size="sm" disabled={busy} onClick={() => send("", "1")}>Press 1 to accept</Button><Button variant="ghost" size="sm" disabled={busy} onClick={end}><PhoneOff size={14}/>End call</Button></div>
        </>}
        <p className="gn-note">Closing this window keeps the 90-second clock running. Each rehearsal is saved in notification history.</p>
      </div>
    </Dialog>
  </>;
}
