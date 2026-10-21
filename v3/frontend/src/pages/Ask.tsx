import { useState, useEffect, useRef, type CSSProperties, type FormEvent } from "react";
import {
  Search,
  ArrowUpRight,
  SlidersHorizontal,
  CircleHelp,
  Film,
  ShieldCheck,
  Info,
  X,
  Footprints,
  Shirt,
  Languages,
  Ban,
  Sparkles,
  MapPin,
  Activity,
  Eye,
  Lock,
} from "lucide-react";
import { useApp } from "../context";
import { api, json, localInput, toUTC, duration } from "../api";
import type { SearchPreset, SearchResult, Related } from "../types";
import { Panel, Field, Empty, EventRow } from "../components/shared";
import { useReveal } from "../components/useReveal";
import { Button } from "../components/ui/button";
export default function Ask({ preset }: { preset?: SearchPreset }) {
  const { data, play } = useApp();
  const [query, setQuery] = useState("");
  const [locationId, setLocationId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [conditionsApplied, setConditionsApplied] = useState(false);
  const requestId = useRef(0);
  const pageRef = useRef<HTMLDivElement>(null);
  useReveal(pageRef);
  const request = useRef<AbortController | null>(null);
  const [resultQuery, setResultQuery] = useState("");
  const search = async (values?: SearchPreset, apply = false) => {
    const current =
      values ||
      (apply || conditionsApplied
        ? {
            query,
            location_id: locationId || null,
            time_from: from ? toUTC(from) : null,
            time_to: to ? toUTC(to) : null,
          }
        : { query });
    if (!current.query.trim()) return;
    if (apply) setConditionsApplied(true);
    const id = ++requestId.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const next = await api<SearchResult>("/search", {
        method: "POST",
        body: json(current),
        signal: controller.signal,
      });
      if (id !== requestId.current || controller.signal.aborted) return;
      setResult(next);
      setResultQuery(current.query);
      setLocationId(next.interpreted.location_id || "");
      setFrom(
        next.interpreted.time_from
          ? localInput(next.interpreted.time_from)
          : "",
      );
      setTo(
        next.interpreted.time_to ? localInput(next.interpreted.time_to) : "",
      );
    } catch (e) {
      if (id === requestId.current && !controller.signal.aborted)
        setError((e as Error).message);
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  };
  useEffect(
    () => () => {
      requestId.current++;
      request.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (preset) {
      setConditionsApplied(true);
      setQuery(preset.query);
      setLocationId(preset.location_id || "");
      setFrom(preset.time_from ? localInput(preset.time_from) : "");
      setTo(preset.time_to ? localInput(preset.time_to) : "");
      search(preset);
    }
  }, [preset]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    search(undefined, editing);
  };
  const snippets = [
    {
      query: "Show restricted entry events",
      kind: "Behaviour",
      icon: Footprints,
      hint: "Rule-triggered events, with the reason and time window.",
    },
    {
      query: "穿红衣服的人靠近白色汽车",
      kind: "Appearance",
      icon: Shirt,
      hint: "Describe clothing, colour or an object; the local model searches descriptions.",
    },
    {
      query: "lelaki baju merah dekat kereta",
      kind: "Bahasa Melayu",
      icon: Languages,
      hint: "Ask in Malay, English or Chinese. Results show what was analysed.",
    },
    {
      query: "有没有人打架",
      kind: "Unsupported",
      icon: Ban,
      hint: "Fighting is not supported. The answer says so instead of inventing a match.",
    },
  ];
  const footage = (items: Related[], nearest = false) =>
    items.map((item, i) => (
      <button
        className="result-card"
        key={item.video_id + "-" + item.start_sec + "-" + i}
        onClick={() =>
          play(item.video_id, item.observed_at_sec ?? item.start_sec)
        }
      >
        <span className="result-thumb">
          {item.keyframe_url ? (
            <img src={item.keyframe_url} alt="Sampled recording frame" />
          ) : (
            <Film size={26} />
          )}
          <small>{duration(item.observed_at_sec ?? item.start_sec)}</small>
        </span>
        <span className="result-body">
          <strong>{item.text}</strong>
          <span>
            {data.cameras.find((c) => c.id === item.camera_id)?.name} ·{" "}
            {duration(item.start_sec)} – {duration(item.end_sec)}
          </span>
          <small>
            {nearest
              ? "For manual review only"
              : item.model || "Local analysis"}
            {item.analysis_source ? " · " + item.analysis_source : ""} · Sampled
            frame, review the video
          </small>
          {nearest && !!item.unmet_conditions?.length && (
            <small>Not observed: {item.unmet_conditions.join("; ")}</small>
          )}
          {!nearest && item.match_basis === "visible_attributes" && (
            <small className="match-basis">
              Matched on recorded colours and objects · similarity{" "}
              {item.score.toFixed(2)}, just below the threshold
            </small>
          )}
        </span>
        <ArrowUpRight size={18} />
      </button>
    ));
  const searchBox = (
    <form className={"ask-box" + (result ? " is-compact" : "")} onSubmit={submit}>
      <Search size={result ? 18 : 22} />
      <label className="sr-only" htmlFor="search-query">
        Search recordings
      </label>
      <input
        id="search-query"
        placeholder="Ask about a moment, a place or a behaviour…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
        required
      />
      <Button disabled={busy}>
        {busy ? "Searching…" : "Search"}
        <ArrowUpRight size={16} />
      </Button>
    </form>
  );
  const locationName =
    data.locations.find((l) => l.id === locationId)?.name || "All locations";
  const appearance = result
    ? Array.isArray(result.interpreted.appearance)
      ? result.interpreted.appearance.join(", ") || "Any"
      : result.interpreted.appearance || "Any"
    : "Any";
  const coveragePct = result?.coverage.total
    ? (result.coverage.analysed / result.coverage.total) * 100
    : 0;
  return (
    <div className={"ask-page wx-reveal" + (result ? " has-result" : "")} ref={pageRef}>
      {!result ? (
        <>
          <section className="ask-hero" data-reveal>
            <span className="ask-badge">
              <Lock size={13} /> Local AI · footage never leaves the site
            </span>
            <h2>What do you want to find?</h2>
            <p>
              A place, a rough time and one detail is enough. Ask in English,
              中文 or Bahasa Melayu.
            </p>
            {searchBox}
            <div className="ask-langs" aria-hidden="true">
              <span>EN</span>
              <span>中文</span>
              <span>BM</span>
            </div>
          </section>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <div className="ask-examples-head" data-reveal>
            <Sparkles size={14} /> Try one of these
          </div>
          <div className="ask-examples">
            {snippets.map((s, i) => (
              <button
                key={s.query}
                type="button"
                className={"ask-example" + (s.kind === "Unsupported" ? " is-muted" : "")}
                data-reveal
                style={{ "--i": i } as CSSProperties}
                disabled={busy}
                onClick={() => {
                  setQuery(s.query);
                  search({ query: s.query });
                }}
              >
                <span className="ask-example-icon">
                  <s.icon size={17} />
                </span>
                <span className="ask-example-kind">{s.kind}</span>
                <strong>{s.query}</strong>
                <small>{s.hint}</small>
                <ArrowUpRight className="ask-example-go" size={16} />
              </button>
            ))}
          </div>
          <ol className="ask-steps" data-reveal>
            <li>
              <span>1</span>
              <div>
                <strong>Say what you remember</strong>
                <small>Plain words. No filters needed.</small>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>See what JagaAI understood</strong>
                <small>Place, behaviour, appearance and coverage.</small>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Play the matching clip</strong>
                <small>Every result opens the original recording.</small>
              </div>
            </li>
          </ol>
        </>
      ) : (
        <>
          <div className="ask-topbar">
            {searchBox}
            <div className="ask-topbar-meta">
              <span>
                Results for <strong>“{resultQuery}”</strong>
              </span>
              <span className="ask-counts">
                <b>{result.events.length}</b> events · <b>{result.related.length}</b> clips
              </span>
            </div>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <div className="ask-layout" aria-busy={busy}>
            <div className={"ask-main" + (busy ? " is-busy" : "")}>
              {!result.supported ? (
                <Panel className="ask-card">
                  <Empty
                    icon={CircleHelp}
                    title="This behaviour is not supported"
                    text={result.message}
                  />
                  <div className="supported-note">
                    <strong>Supported in this workspace</strong>
                    <p>
                      Vehicle loitering and restricted area entry, plus descriptions
                      from recordings analysed by a local vision model. Fighting,
                      falls and intent to steal are not identified.
                    </p>
                  </div>
                </Panel>
              ) : !result.events.length && !result.related.length ? (
                <Panel className="ask-card">
                  <Empty
                    icon={Search}
                    title="No clear match"
                    text={
                      result.message ||
                      "No analysed event or description met the search threshold. This does not prove nothing happened."
                    }
                  />
                  {result.coverage.total === 0 && (
                    <div className="supported-note">
                      <Info size={16} />
                      <p>
                        Upload and analyse a recording in Cameras to create
                        searchable coverage.
                      </p>
                    </div>
                  )}
                </Panel>
              ) : (
                <>
                  {result.message && (
                    <div className="info-strip">
                      <Info size={16} />
                      {result.message}
                    </div>
                  )}
                  {result.events.length > 0 && (
                    <Panel
                      className="ask-card"
                      title="Behaviour events"
                      action={<span className="panel-subtle">{result.events.length} found</span>}
                    >
                      <div className="event-results">
                        {result.events.map((e) => (
                          <EventRow key={e.id} event={e} />
                        ))}
                      </div>
                    </Panel>
                  )}
                  {result.related.length > 0 && (
                    <Panel
                      className="ask-card"
                      title="Related footage"
                      action={<span className="panel-subtle">Click a clip to play it</span>}
                    >
                      <div className="related-results ask-clips">
                        {footage(result.related)}
                      </div>
                    </Panel>
                  )}
                </>
              )}
              {result.supported && result.nearest.length > 0 && (
                <details className="nearest-results ask-card">
                  <summary>
                    Closest footage for manual review ({result.nearest.length})
                  </summary>
                  <p>
                    These clips did not meet the similarity threshold or visible
                    conditions. Review them before drawing conclusions.
                  </p>
                  {footage(result.nearest, true)}
                </details>
              )}
            </div>

            <aside className="ask-rail" aria-label="What the system understood">
              <section className="ask-understood">
                <div className="ask-rail-head">
                  <span className="ask-eyebrow">
                    <Sparkles size={14} /> System understood
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(!editing)}
                    aria-expanded={editing}
                  >
                    <SlidersHorizontal size={15} />
                    {editing ? "Close" : "Edit"}
                  </Button>
                </div>
                <dl className="ask-facts">
                  <div>
                    <dt>
                      <MapPin size={14} /> Location
                    </dt>
                    <dd>{locationName}</dd>
                  </div>
                  <div>
                    <dt>
                      <Activity size={14} /> Behaviour
                    </dt>
                    <dd>{result.interpreted.behaviour?.replaceAll("_", " ") || "Any"}</dd>
                  </div>
                  <div>
                    <dt>
                      <Eye size={14} /> Appearance
                    </dt>
                    <dd>{appearance}</dd>
                  </div>
                  {result.interpreted.attribute_search_phrase && (
                    <div>
                      <dt>
                        <Search size={14} /> Also searched
                      </dt>
                      <dd>{result.interpreted.attribute_search_phrase}</dd>
                    </div>
                  )}
                  {from && (
                    <div>
                      <dt>
                        <Film size={14} /> Time (MYT)
                      </dt>
                      <dd>
                        {from.replace("T", " ")} – {to ? to.replace("T", " ") : "now"}
                      </dd>
                    </div>
                  )}
                </dl>
                {editing && (
                  <form className="conditions-form ask-conditions" onSubmit={submit}>
                    <Field label="Location">
                      <select
                        value={locationId}
                        onChange={(e) => setLocationId(e.target.value)}
                      >
                        <option value="">All locations</option>
                        {data.locations.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="From (MYT)">
                      <input
                        type="datetime-local"
                        value={from}
                        onChange={(e) => setFrom(e.target.value)}
                      />
                    </Field>
                    <Field label="To (MYT)">
                      <input
                        type="datetime-local"
                        value={to}
                        min={from || undefined}
                        onChange={(e) => setTo(e.target.value)}
                      />
                    </Field>
                    <div className="ask-conditions-actions">
                      <Button disabled={busy} type="submit">
                        Apply conditions
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setFrom("");
                          setTo("");
                          setLocationId("");
                          setConditionsApplied(true);
                        }}
                      >
                        <X size={15} /> Clear
                      </Button>
                    </div>
                  </form>
                )}
              </section>
              <section className="ask-coverage">
                <div className="ask-coverage-top">
                  <ShieldCheck size={16} />
                  <strong>
                    {result.coverage.analysed} of {result.coverage.total} recordings analysed
                  </strong>
                </div>
                <span className="ask-meter" aria-hidden="true">
                  <span style={{ width: coveragePct + "%" }} />
                </span>
                <small>
                  {result.coverage.pending > 0
                    ? `${result.coverage.pending} not fully analysed — results may be incomplete.`
                    : "No pending recordings. Results cover everything analysed."}
                </small>
              </section>
              <button
                type="button"
                className="ask-new"
                onClick={() => {
                  setResult(null);
                  setQuery("");
                  setEditing(false);
                }}
              >
                <Search size={14} /> Start a new search
              </button>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
