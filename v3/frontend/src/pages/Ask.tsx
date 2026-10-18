import { useState, useEffect, useRef, type FormEvent } from "react";
import {
  Search,
  ArrowUpRight,
  SlidersHorizontal,
  CircleHelp,
  Film,
  ShieldCheck,
  Info,
  X,
} from "lucide-react";
import { useApp } from "../context";
import { api, json, localInput, toUTC, duration } from "../api";
import type { SearchPreset, SearchResult, Related } from "../types";
import { Panel, Field, Empty, EventRow } from "../components/shared";
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
      hint: "Rule-triggered events, with the reason and time window.",
    },
    {
      query: "穿红衣服的人靠近白色汽车",
      kind: "Appearance",
      hint: "Describe clothing, colour or an object; the local model searches descriptions.",
    },
    {
      query: "lelaki baju merah dekat kereta",
      kind: "Bahasa Melayu",
      hint: "Ask in Malay, English or Chinese. Results show what was analysed.",
    },
    {
      query: "有没有人打架",
      kind: "Unsupported",
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
  return (
    <>
      <Panel className="search-panel">
        <form className="search-form" onSubmit={submit}>
          <Search size={22} />
          <label className="sr-only" htmlFor="search-query">
            Search recordings
          </label>
          <input
            id="search-query"
            placeholder="Ask about a moment, a place or a behaviour…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            required
          />
          <Button disabled={busy}>
            {busy ? "Searching…" : "Search"}
            <ArrowUpRight size={16} />
          </Button>
        </form>
        <div className="search-language">
          Ask in English, 中文 or Bahasa Melayu. Results always show what was
          analysed.
        </div>
        {!result && (
          <div className="suggestions example-grid">
            {snippets.map((s) => (
              <button
                key={s.query}
                className="example-card"
                onClick={() => {
                  setQuery(s.query);
                  search({ query: s.query });
                }}
              >
                <span>{s.kind}</span>
                <strong>{s.query}</strong>
                <small>{s.hint}</small>
              </button>
            ))}
          </div>
        )}
      </Panel>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {result ? (
        <>
          <Panel className="search-understood">
            <div className="panel-head">
              <div>
                <h2>System understood</h2>
                <p className="search-result-query">
                  Results for “{resultQuery}”
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(!editing)}
              >
                <SlidersHorizontal size={15} />
                {editing ? "Close conditions" : "Edit conditions"}
              </Button>
            </div>
            <div className="result-overview">
              <span>
                <strong>{result.events.length}</strong> behaviour events
              </span>
              <span>
                <strong>{result.related.length}</strong> related clips
              </span>
              <span>
                <strong>
                  {result.coverage.analysed}/{result.coverage.total}
                </strong>{" "}
                recordings analysed
              </span>
              {result.coverage.pending > 0 && (
                <span className="warn">
                  {result.coverage.pending} not fully analysed
                </span>
              )}
            </div>
            <div className="context-chips">
              <span>
                Location{" "}
                <strong>
                  {data.locations.find((l) => l.id === locationId)?.name ||
                    "All locations"}
                </strong>
              </span>
              <span>
                Behaviour{" "}
                <strong>
                  {result.interpreted.behaviour?.replaceAll("_", " ") || "Any"}
                </strong>
              </span>
              <span>
                Appearance{" "}
                <strong>
                  {Array.isArray(result.interpreted.appearance)
                    ? result.interpreted.appearance.join(", ") || "Any"
                    : result.interpreted.appearance || "Any"}
                </strong>
              </span>
              {result.interpreted.attribute_search_phrase && (
                <span>
                  Also searched
                  <strong>{result.interpreted.attribute_search_phrase}</strong>
                </span>
              )}
            </div>
            {editing && (
              <form className="conditions-form" onSubmit={submit}>
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
              </form>
            )}
            <div className="coverage-note">
              <ShieldCheck size={16} />
              <span>
                <strong>
                  Analysis coverage: {result.coverage.analysed} of{" "}
                  {result.coverage.total} recordings
                </strong>
                {result.coverage.pending > 0
                  ? ` · ${result.coverage.pending} not fully analysed`
                  : " · No pending recordings"}
                {from && (
                  <small>
                    {from.replace("T", " ")} –{" "}
                    {to ? to.replace("T", " ") : "now"} MYT
                  </small>
                )}
              </span>
            </div>
          </Panel>
          {!result.supported ? (
            <Panel>
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
          ) : (
            <>
              <div className="result-summary">
                <h2>Search results</h2>
                <span>
                  {result.events.length} behaviour events ·{" "}
                  {result.related.length} related clips
                </span>
              </div>
              {!result.events.length && !result.related.length ? (
                <Panel>
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
                    <Panel title="Behaviour events">
                      <div className="event-results">
                        {result.events.map((e) => (
                          <EventRow key={e.id} event={e} />
                        ))}
                      </div>
                    </Panel>
                  )}
                  {result.related.length > 0 && (
                    <Panel title="Related footage">
                      <div className="related-results">
                        {footage(result.related)}
                      </div>
                    </Panel>
                  )}
                </>
              )}
              {result.nearest.length > 0 && (
                <details className="nearest-results">
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
            </>
          )}
        </>
      ) : (
        <section className="panel search-empty">
          <div className="search-empty-copy">
            <span className="empty-icon">
              <Search size={24} strokeWidth={1.4} />
            </span>
            <div>
              <h2>Start with what you remember</h2>
              <p>
                A place, a rough time and one detail is enough. The workspace
                shows what it analysed and says when there is no clear match.
              </p>
            </div>
          </div>
          <p className="search-empty-hint">
            Try a place, a rough time, then one detail you remember. If nothing
            clear is found, the answer says so and shows the coverage.
          </p>
        </section>
      )}
    </>
  );
}
