import type { CSSProperties } from "react";

export type FeedItem = {
  id: string;
  time: string;
  date: string;
  title: string;
  place: string;
  /** pending = waiting for a person; done = already reviewed; logged = no alert raised. */
  state: "pending" | "done" | "logged";
  severe: boolean;
  status: string;
  onOpen: () => void;
};

// The newest events, newest first, each one click away from its evidence.
export function ActivityFeed({ items, onAll }: { items: FeedItem[]; onAll: () => void }) {
  return (
    <section className="cc-card cc-panel cc-feed" aria-labelledby="cc-feed-title" data-reveal>
      <header className="cc-panel-head">
        <div>
          <h2 id="cc-feed-title">Latest events</h2>
          <p>Newest first. Click one to see the evidence.</p>
        </div>
        <button type="button" className="cc-link" onClick={onAll}>
          All alerts <span aria-hidden="true">→</span>
        </button>
      </header>
      {items.length ? (
        <ol className="cc-feed-list">
          {items.map((e, i) => (
            <li key={e.id} style={{ "--i": i } as CSSProperties} data-reveal>
              <button type="button" className={"cc-frow is-" + e.state + (e.severe ? " is-severe" : "")} onClick={e.onOpen}>
                <span className="cc-frow-time">
                  <b>{e.time}</b>
                  <small>{e.date}</small>
                </span>
                <span className="cc-frow-rail" aria-hidden="true">
                  <i />
                </span>
                <span className="cc-frow-main">
                  <strong>{e.title}</strong>
                  <small>{e.place}</small>
                </span>
                <span className="cc-frow-status">{e.status}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="cc-panel-empty">No events yet. They appear here as soon as a recording is analysed.</p>
      )}
    </section>
  );
}
