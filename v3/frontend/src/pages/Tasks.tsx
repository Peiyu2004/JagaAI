import { useState, type FormEvent } from "react";
import {
  Plus,
  MapPin,
  UserRound,
  Clock3,
  Check,
  Play,
  Hand,
  ListChecks,
  RotateCcw,
} from "lucide-react";
import { useApp } from "../context";
import { api, json, relativeTime } from "../api";
import type { Task } from "../types";
import { Field, Empty, Badge } from "../components/shared";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";

const rank: Record<string, number> = { urgent: 0, high: 1, normal: 2 };
const blank = { title: "", detail: "", location_id: "", priority: "normal", assignee_id: "" };

export default function Tasks() {
  const { data, run } = useApp();
  const me = data.user;
  // Guards take and complete tasks; managers also assign them to anyone on the team.
  const manager = me.role !== "guard";
  const [filter, setFilter] = useState(manager ? "all" : "mine");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(blank);
  const [completing, setCompleting] = useState<Task | null>(null);
  const [note, setNote] = useState("");
  const people = Object.fromEntries(data.staff.map((s) => [s.id, s.name]));
  const places = Object.fromEntries(data.locations.map((l) => [l.id, l.name]));
  const active = data.tasks.filter((t) => t.status !== "done");
  const groups: Record<string, Task[]> = {
    mine: active.filter((t) => t.assignee_id === me.id),
    open: active.filter((t) => !t.assignee_id),
    all: active,
    done: data.tasks.filter((t) => t.status === "done"),
  };
  const visible = [...groups[filter]].sort(
    (a, b) =>
      (rank[a.priority] ?? 2) - (rank[b.priority] ?? 2) ||
      b.updated_at.localeCompare(a.updated_at),
  );
  const patch = (task: Task, body: Record<string, unknown>, message: string) =>
    run(
      () => api("/tasks/" + task.id, { method: "PATCH", body: json(body) }),
      message,
    );
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(
      () =>
        api("/tasks", {
          method: "POST",
          body: json({
            ...draft,
            location_id: draft.location_id || null,
            assignee_id: draft.assignee_id || null,
          }),
        }),
      "Task created",
    );
    if (ok) {
      setCreating(false);
      setDraft(blank);
    }
  };
  const complete = async (e: FormEvent) => {
    e.preventDefault();
    if (!completing) return;
    const ok = await patch(completing, { status: "done", note }, "Task completed");
    if (ok) setCompleting(null);
  };
  return (
    <div className="role-page">
      <div className="role-toolbar">
        <div className="role-filters" role="tablist" aria-label="Task filter">
          {[
            ["mine", "My tasks"],
            ["open", "Unassigned"],
            ["all", "All active"],
            ["done", "Done"],
          ].map(([value, name]) => (
            <button
              key={value}
              role="tab"
              aria-selected={filter === value}
              className={filter === value ? "active" : ""}
              onClick={() => setFilter(value)}
            >
              {name}
              <span>{groups[value].length}</span>
            </button>
          ))}
        </div>
        <Button
          onClick={() => {
            setDraft({ ...blank, assignee_id: manager ? "" : me.id });
            setCreating(true);
          }}
        >
          <Plus size={16} /> New task
        </Button>
      </div>
      {visible.length ? (
        <div className="task-list">
          {visible.map((task) => {
            const mine = task.assignee_id === me.id;
            return (
              <article className={"task-card is-" + task.priority} key={task.id}>
                <div className="task-main">
                  <div className="task-badges">
                    <Badge value={task.priority} />
                    <Badge value={task.status} />
                    {mine && <span className="task-mine">Assigned to you</span>}
                  </div>
                  <h3>{task.title}</h3>
                  {task.detail && <p>{task.detail}</p>}
                  <div className="task-meta">
                    {task.location_id && (
                      <span>
                        <MapPin size={13} />
                        {places[task.location_id]}
                      </span>
                    )}
                    <span>
                      <UserRound size={13} />
                      {task.assignee_id ? people[task.assignee_id] || "Former staff" : "Unassigned"}
                    </span>
                    <span>
                      <Clock3 size={13} />
                      Updated {relativeTime(task.updated_at)}
                    </span>
                  </div>
                  {task.note && (
                    <p className="task-note">
                      <strong>Note</strong> {task.note}
                    </p>
                  )}
                </div>
                <div className="task-actions">
                  {task.status !== "done" && !task.assignee_id && (
                    <Button
                      size="sm"
                      onClick={() =>
                        patch(task, { assignee_id: me.id, status: "in_progress" }, "Task taken")
                      }
                    >
                      <Hand size={14} /> Take task
                    </Button>
                  )}
                  {task.status === "open" && task.assignee_id && (mine || manager) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => patch(task, { status: "in_progress" }, "Task started")}
                    >
                      <Play size={14} /> Start
                    </Button>
                  )}
                  {task.status === "in_progress" && (mine || manager) && (
                    <Button
                      size="sm"
                      onClick={() => {
                        setNote(task.note);
                        setCompleting(task);
                      }}
                    >
                      <Check size={14} /> Complete
                    </Button>
                  )}
                  {task.status === "done" && manager && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => patch(task, { status: "open" }, "Task reopened")}
                    >
                      <RotateCcw size={14} /> Reopen
                    </Button>
                  )}
                  {manager && task.status !== "done" && (
                    <label className="task-assign">
                      <span className="sr-only">Assign {task.title}</span>
                      <select
                        value={task.assignee_id || ""}
                        onChange={(e) =>
                          patch(task, { assignee_id: e.target.value || null }, "Task reassigned")
                        }
                      >
                        <option value="">Unassigned</option>
                        {data.staff.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <Empty
          icon={ListChecks}
          title={filter === "mine" ? "Nothing assigned to you" : "No tasks here"}
          text={
            filter === "mine"
              ? "Take an unassigned task or create one from what you see on patrol."
              : "New patrols and follow-ups appear here as soon as they are created."
          }
        />
      )}
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="New task"
        description={
          manager
            ? "Create a patrol or follow-up and assign it to someone on duty."
            : "Log a follow-up for yourself, or leave it for the next guard."
        }
      >
        <form className="stack-form" onSubmit={create}>
          <Field label="What needs doing">
            <input
              required
              minLength={3}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="For example, check the service gate padlock"
            />
          </Field>
          <Field label="Details" hint="Optional">
            <textarea
              value={draft.detail}
              onChange={(e) => setDraft({ ...draft, detail: e.target.value })}
            />
          </Field>
          <div className="form-pair">
            <Field label="Location">
              <select
                value={draft.location_id}
                onChange={(e) => setDraft({ ...draft, location_id: e.target.value })}
              >
                <option value="">Anywhere on site</option>
                {data.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Priority">
              <select
                value={draft.priority}
                onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
              >
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </Field>
          </div>
          <Field label="Assign to">
            <select
              value={draft.assignee_id}
              onChange={(e) => setDraft({ ...draft, assignee_id: e.target.value })}
            >
              <option value="">Unassigned</option>
              {(manager ? data.staff : data.staff.filter((s) => s.id === me.id)).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id === me.id ? `${s.name} (me)` : s.name}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit">Create task</Button>
        </form>
      </Dialog>
      <Dialog
        open={!!completing}
        onOpenChange={(open) => !open && setCompleting(null)}
        title="Complete task"
        description={completing?.title}
      >
        <form className="stack-form" onSubmit={complete}>
          <Field label="What did you find?" hint="Optional. Visible to managers.">
            <textarea
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="For example, padlock secured; no damage found."
            />
          </Field>
          <Button type="submit">
            <Check size={16} /> Mark as done
          </Button>
        </form>
      </Dialog>
    </div>
  );
}
