import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  authApi,
  buildItemQuery,
  itemsApi,
  type ActivityEvent,
  type Comment,
  type DashboardData,
  type ItemType,
  type MembershipRole,
  type Priority,
  type Status,
  type User,
  type WorkItem,
} from "./api";

type Screen = "dashboard" | "items" | "create" | "detail";
type ListFilters = {
  q: string;
  status: string;
  priority: string;
  type: string;
  assigneeId: string;
};

const emptyFilters: ListFilters = {
  q: "",
  status: "",
  priority: "",
  type: "",
  assigneeId: "",
};
const itemTypes: ItemType[] = ["INCIDENT", "CUSTOMER_ISSUE", "PAYMENT", "COMPLIANCE", "TASK"];
const priorities: Priority[] = ["LOW", "NORMAL", "HIGH", "URGENT"];
const statuses: Status[] = ["OPEN", "IN_PROGRESS", "AWAITING_APPROVAL", "RESOLVED", "CLOSED"];
const nextStatus: Partial<Record<Status, Status>> = {
  OPEN: "IN_PROGRESS",
  IN_PROGRESS: "AWAITING_APPROVAL",
  AWAITING_APPROVAL: "RESOLVED",
  RESOLVED: "CLOSED",
};

function isWriter(role: MembershipRole | undefined): boolean {
  return role === "MEMBER" || role === "LEAD" || role === "ADMIN";
}

function displayLabel(value: string): string {
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string | null): string {
  if (!value) return "No due date";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Invalid date"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function dateInputValue(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

function LoginScreen({
  expired,
  restoreError,
  onLogin,
}: {
  expired: boolean;
  restoreError: string;
  onLogin: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      await onLogin(email, password);
    } catch (reason) {
      setError(
        reason instanceof ApiError && reason.status === 401
          ? "Email or password is incorrect."
          : getErrorMessage(reason),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand-mark" aria-hidden="true">T</div>
        <p className="eyebrow">TeamOrbit · Operations</p>
        <h1 id="login-title">TeamOrbit</h1>
        <p className="muted">One Workspace. Every Task. Clear Accountability.</p>
        {expired && (
          <p className="notice notice--info" role="status">
            Your session has expired. Sign in again to continue.
          </p>
        )}
        {restoreError && <p className="notice notice--error" role="alert">{restoreError}</p>}
        {error && <p className="notice notice--error" role="alert">{error}</p>}
        <form className="stack-form" onSubmit={submit}>
          <label>
            Email address
            <input
              autoComplete="username"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <button className="button button--primary button--full" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="login-footnote">Access is managed by your TeamOrbit administrator.</p>
      </section>
    </main>
  );
}

function ItemCard({
  item,
  onOpen,
}: {
  item: WorkItem;
  onOpen: (item: WorkItem) => void;
}) {
  return (
    <article className="item-card">
      <div className="item-card__top">
        <span className={`priority priority--${item.priority.toLowerCase()}`}>
          <span aria-hidden="true" />{displayLabel(item.priority)}
        </span>
        <span className={`status status--${item.status.toLowerCase()}`}>{displayLabel(item.status)}</span>
      </div>
      <h3>{item.title}</h3>
      <p className="item-card__summary">{item.description || "No description provided."}</p>
      <dl className="item-meta">
        <div><dt>Team</dt><dd>{item.team.name}</dd></div>
        <div><dt>Assignee</dt><dd>{item.assignee?.name ?? "Unassigned"}</dd></div>
        <div><dt>Due</dt><dd>{formatDate(item.dueDate)}</dd></div>
      </dl>
      <button className="text-button" onClick={() => onOpen(item)}>
        Open item <span aria-hidden="true">→</span>
      </button>
    </article>
  );
}

function ItemGrid({
  items,
  emptyTitle,
  emptyBody,
  onOpen,
}: {
  items: WorkItem[];
  emptyTitle: string;
  emptyBody: string;
  onOpen: (item: WorkItem) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-state__icon" aria-hidden="true">✓</span>
        <h3>{emptyTitle}</h3>
        <p>{emptyBody}</p>
      </div>
    );
  }
  return <div className="item-grid">{items.map((item) => <ItemCard key={item.id} item={item} onOpen={onOpen} />)}</div>;
}

function ItemSkeletons() {
  return (
    <div className="item-grid" aria-label="Loading work items">
      {[0, 1, 2].map((key) => (
        <div className="item-skeleton" key={key} aria-hidden="true">
          <span /><span /><span /><span />
        </div>
      ))}
    </div>
  );
}

function DetailPanel({
  item,
  user,
  events,
  comments,
  loading,
  error,
  notice,
  busy,
  onBack,
  onReload,
  onClaim,
  onTransition,
  onUpdate,
  onComment,
}: {
  item: WorkItem | null;
  user: User;
  events: ActivityEvent[];
  comments: Comment[];
  loading: boolean;
  error: string;
  notice: string;
  busy: string;
  onBack: () => void;
  onReload: () => void;
  onClaim: () => void;
  onTransition: (status: Status) => void;
  onUpdate: (body: Record<string, unknown>) => Promise<void>;
  onComment: (body: string) => Promise<void>;
}) {
  const [commentBody, setCommentBody] = useState("");

  if (loading) {
    return <section className="content-section"><button className="text-button" onClick={onBack}>← Back to work items</button><div className="loading-line" role="status">Loading item details…</div></section>;
  }
  if (error || !item) {
    return (
      <section className="content-section">
        <button className="text-button" onClick={onBack}>← Back to work items</button>
        <div className="notice notice--error" role="alert">{error || "Work item unavailable."}</div>
        <button className="button button--secondary" onClick={onReload}>Retry loading item</button>
      </section>
    );
  }

  const role = user.memberships.find((membership) => membership.team.id === item.teamId)?.role;
  const writer = isWriter(role);
  const canApprove = role === "LEAD";
  const next = nextStatus[item.status];
  const canTransition = Boolean(writer && next && (item.status !== "AWAITING_APPROVAL" || canApprove));
  const canClaim = writer && item.status === "OPEN" && item.assigneeId === null;

  async function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onComment(commentBody.trim());
    setCommentBody("");
  }

  return (
    <section className="content-section">
      <button className="text-button back-link" onClick={onBack}>← Back to work items</button>
      {notice && (
        <div className="notice notice--warning" role="alert">
          <span>{notice}</span>
          <button className="text-button" onClick={onReload}>Reload latest item</button>
        </div>
      )}
      <div className="detail-heading">
        <div>
          <div className="detail-heading__eyebrow">{item.team.name} <span>·</span> {displayLabel(item.type)}</div>
          <h1>{item.title}</h1>
          <div className="item-card__top">
            <span className={`priority priority--${item.priority.toLowerCase()}`}><span aria-hidden="true" />{displayLabel(item.priority)}</span>
            <span className={`status status--${item.status.toLowerCase()}`}>{displayLabel(item.status)}</span>
            <span className="version-label">Version {item.version}</span>
          </div>
        </div>
        <div className="detail-actions">
          {canClaim && (
            <button className="button button--primary" disabled={busy !== ""} onClick={onClaim}>
              {busy === "claim" ? "Claiming…" : "Claim item"}
            </button>
          )}
          {canTransition && next && (
            <button className="button button--secondary" disabled={busy !== ""} onClick={() => onTransition(next)}>
              {busy === "transition" ? "Updating…" : `Move to ${displayLabel(next)}`}
            </button>
          )}
        </div>
      </div>
      {item.status === "AWAITING_APPROVAL" && !canApprove && (
        <p className="muted role-note">Approval is restricted to a Lead in this item’s team.</p>
      )}
      <div className="detail-layout">
        <div className="detail-main">
          <article className="surface description-panel">
            <div className="section-heading"><div><p className="eyebrow">Work item</p><h2>Details</h2></div></div>
            <p className="preserve-lines">{item.description || "No description provided."}</p>
            <dl className="detail-facts">
              <div><dt>Assignee</dt><dd>{item.assignee?.name ?? "Unassigned"}</dd></div>
              <div><dt>Creator</dt><dd>{item.creator.name}</dd></div>
              <div><dt>Due date</dt><dd>{formatDate(item.dueDate)}</dd></div>
              <div><dt>Last updated</dt><dd>{formatDate(item.updatedAt)}</dd></div>
            </dl>
          </article>
          <article className="surface">
            <div className="section-heading"><div><p className="eyebrow">Discussion</p><h2>Comments <span className="count">{comments.length}</span></h2></div></div>
            {comments.length === 0 ? <p className="muted">No comments yet. Add context for your teammates.</p> : (
              <ol className="comment-list">
                {comments.map((comment) => (
                  <li className="comment" key={comment.id}>
                    <div className="comment__avatar" aria-hidden="true">{comment.author.name.slice(0, 1).toUpperCase()}</div>
                    <div><div className="comment__meta"><strong>{comment.author.name}</strong><time dateTime={comment.createdAt}>{formatDate(comment.createdAt)}</time></div><p>{comment.body}</p></div>
                  </li>
                ))}
              </ol>
            )}
            {writer ? (
              <form className="comment-form" onSubmit={submitComment}>
                <label htmlFor="comment-body">Add a comment</label>
                <textarea id="comment-body" maxLength={5000} rows={3} value={commentBody} onChange={(event) => setCommentBody(event.target.value)} required />
                <div className="form-row form-row--end"><span className="muted">{commentBody.length}/5000</span><button className="button button--primary" disabled={busy !== "" || commentBody.trim().length === 0 || commentBody.trim().length > 5000}>{busy === "comment" ? "Posting…" : "Post comment"}</button></div>
              </form>
            ) : <p className="muted role-note">Your team role is read-only; comments can’t be added.</p>}
          </article>
        </div>
        <aside className="detail-side">
          {writer && <EditItemForm key={`${item.id}-${item.version}`} item={item} busy={busy === "update"} onSave={onUpdate} />}
          <article className="surface activity-panel">
            <div className="section-heading"><div><p className="eyebrow">Audit trail</p><h2>Activity</h2></div></div>
            {events.length === 0 ? <p className="muted">No activity recorded yet.</p> : (
              <ol className="activity-list">
                {events.map((event) => <ActivityRow event={event} key={event.id} />)}
              </ol>
            )}
          </article>
        </aside>
      </div>
    </section>
  );
}

function EditItemForm({
  item,
  busy,
  onSave,
}: {
  item: WorkItem;
  busy: boolean;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [type, setType] = useState<ItemType>(item.type);
  const [priority, setPriority] = useState<Priority>(item.priority);
  const [assigneeId, setAssigneeId] = useState(item.assigneeId ?? "");
  const [dueDate, setDueDate] = useState(dateInputValue(item.dueDate));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSave({
      version: item.version,
      title: title.trim(),
      description,
      type,
      priority,
      assigneeId: assigneeId.trim() || null,
      dueDate: dueDate ? new Date(`${dueDate}T00:00:00`).toISOString() : null,
    });
  }

  return (
    <article className="surface">
      <div className="section-heading"><div><p className="eyebrow">Editable fields</p><h2>Update item</h2></div></div>
      <form className="stack-form compact-form" onSubmit={submit}>
        <label>Title<input maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} required /></label>
        <label>Description<textarea maxLength={10000} rows={4} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <div className="form-row">
          <label>Type<select value={type} onChange={(event) => setType(event.target.value as ItemType)}>{itemTypes.map((value) => <option key={value} value={value}>{displayLabel(value)}</option>)}</select></label>
          <label>Priority<select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>{priorities.map((value) => <option key={value} value={value}>{displayLabel(value)}</option>)}</select></label>
        </div>
        <label>Assignee user ID <input aria-describedby="assignee-help" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} placeholder="Leave blank to unassign" /></label>
        <p className="field-help" id="assignee-help">Use a user ID who belongs to this item’s team. The API does not expose a team member directory.</p>
        <label>Due date<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
        <button className="button button--primary" disabled={busy || title.trim().length === 0}>{busy ? "Saving…" : "Save changes"}</button>
      </form>
    </article>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const metadata = event.metadata && typeof event.metadata === "object"
    ? event.metadata as Record<string, unknown>
    : {};
  let summary = "Updated this work item.";
  if (event.eventType === "ITEM_CREATED") summary = "Created this work item.";
  else if (event.eventType === "STATUS_CHANGED") {
    const before = metadata.before as Record<string, unknown> | undefined;
    const after = metadata.after as Record<string, unknown> | undefined;
    summary = `Moved from ${displayLabel(String(before?.status ?? "unknown"))} to ${displayLabel(String(after?.status ?? "unknown"))}.`;
  } else if (event.eventType === "ASSIGNEE_CHANGED") {
    summary = metadata.source === "claim" ? "Claimed this work item." : "Changed the assignee.";
  } else if (event.eventType === "COMMENT_CREATED") summary = "Added a comment.";
  else if (event.eventType === "ITEM_UPDATED") {
    const fields = Array.isArray(metadata.changedFields)
      ? metadata.changedFields.filter((field): field is string => typeof field === "string")
      : [];
    const before = metadata.before as Record<string, unknown> | undefined;
    const after = metadata.after as Record<string, unknown> | undefined;
    const changes = fields.map((field) => {
      if (field === "priority" && before?.priority && after?.priority) {
        return `priority from ${displayLabel(String(before.priority))} to ${displayLabel(String(after.priority))}`;
      }
      if (field === "assigneeId") return "assignee";
      return displayLabel(field);
    });
    summary = `Updated ${changes.length > 0 ? changes.join(", ") : "item details"}.`;
  }
  return (
    <li className="activity">
      <span className="activity__dot" aria-hidden="true" />
      <div><p><strong>{event.actor.name}</strong> {summary}</p><time dateTime={event.createdAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(event.createdAt))}</time></div>
    </li>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [authError, setAuthError] = useState("");
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [selectedId, setSelectedId] = useState("");
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState("");
  const [filters, setFilters] = useState<ListFilters>(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState<ListFilters>(emptyFilters);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState("");
  const [detailItem, setDetailItem] = useState<WorkItem | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailNotice, setDetailNotice] = useState("");
  const [detailBusy, setDetailBusy] = useState("");
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [dataRefresh, setDataRefresh] = useState(0);
  const [createError, setCreateError] = useState("");
  const [createPending, setCreatePending] = useState(false);
  const createPendingRef = useRef(false);
  const createAttempt = useRef<{ signature: string; key: string } | null>(null);
  const writableTeams = useMemo(
    () => user?.memberships.filter(({ role }) => isWriter(role)) ?? [],
    [user],
  );

  useEffect(() => {
    let active = true;
    authApi.current()
      .then(({ user: currentUser }) => {
        if (active) setUser(currentUser);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && error.status !== 401) setAuthError(getErrorMessage(error));
      })
      .finally(() => {
        if (active) setSessionLoading(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!user || screen !== "dashboard") return;
    const controller = new AbortController();
    setDashboardLoading(true);
    setDashboardError("");
    itemsApi.dashboard(controller.signal)
      .then(setDashboard)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (handleAuthError(error)) return;
        setDashboardError(getErrorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDashboardLoading(false);
      });
    return () => controller.abort();
  }, [user, screen, dataRefresh]);

  useEffect(() => {
    if (!user || screen !== "items") return;
    const controller = new AbortController();
    setItemsLoading(true);
    setItemsError("");
    setItems([]);
    setNextCursor(null);
    const query = buildItemQuery(appliedFilters);
    itemsApi.list(query, controller.signal)
      .then((page) => {
        setItems(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (handleAuthError(error)) return;
        setItemsError(getErrorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setItemsLoading(false);
      });
    return () => controller.abort();
  }, [user, screen, appliedFilters, dataRefresh]);

  useEffect(() => {
    if (!user || screen !== "detail" || !selectedId) return;
    let active = true;
    setDetailLoading(true);
    setDetailError("");
    setDetailNotice("");
    Promise.all([
      itemsApi.get(selectedId),
      itemsApi.activity(selectedId),
      itemsApi.comments(selectedId),
    ])
      .then(([itemResponse, activityResponse, commentsResponse]) => {
        if (!active) return;
        setDetailItem(itemResponse.item);
        setActivity(activityResponse.events);
        setComments(commentsResponse.comments);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (handleAuthError(error)) return;
        setDetailError(getErrorMessage(error));
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => { active = false; };
  }, [user, screen, selectedId, detailRefresh]);

  function handleAuthError(error: unknown): boolean {
    if (error instanceof ApiError && error.status === 401) {
      setUser(null);
      setDashboard(null);
      setItems([]);
      setDetailItem(null);
      setActivity([]);
      setComments([]);
      setSessionExpired(true);
      setScreen("dashboard");
      return true;
    }
    return false;
  }

  async function login(email: string, password: string) {
    const result = await authApi.login(email, password);
    setAuthError("");
    setSessionExpired(false);
    setUser(result.user);
    setScreen("dashboard");
  }

  async function logout() {
    setAuthError("");
    try {
      await authApi.logout();
      setUser(null);
      setDashboard(null);
      setItems([]);
      setDetailItem(null);
      setActivity([]);
      setComments([]);
      setScreen("dashboard");
    } catch (error) {
      if (!handleAuthError(error)) setAuthError(getErrorMessage(error));
    }
  }

  function openItem(item: WorkItem) {
    setSelectedId(item.id);
    setDetailItem(null);
    setActivity([]);
    setComments([]);
    setDetailError("");
    setDetailNotice("");
    setScreen("detail");
  }

  async function loadMore() {
    if (!nextCursor || itemsLoading) return;
    setItemsLoading(true);
    setItemsError("");
    try {
      const query = buildItemQuery({ ...appliedFilters, cursor: nextCursor });
      const page = await itemsApi.list(query);
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (!handleAuthError(error)) setItemsError(getErrorMessage(error));
    } finally {
      setItemsLoading(false);
    }
  }

  async function createItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createPendingRef.current) return;
    const form = new FormData(event.currentTarget);
    const dueDate = String(form.get("dueDate") ?? "");
    const assigneeId = String(form.get("assigneeId") ?? "").trim();
    const body = {
      teamId: String(form.get("teamId") ?? ""),
      title: String(form.get("title") ?? "").trim(),
      description: String(form.get("description") ?? ""),
      type: String(form.get("type") ?? "TASK") as ItemType,
      priority: String(form.get("priority") ?? "NORMAL") as Priority,
      ...(assigneeId ? { assigneeId } : {}),
      ...(dueDate ? { dueDate: new Date(`${dueDate}T00:00:00`).toISOString() } : {}),
    };
    const signature = JSON.stringify(body);
    const attempt = createAttempt.current?.signature === signature
      ? createAttempt.current
      : { signature, key: crypto.randomUUID() };
    createAttempt.current = attempt;
    createPendingRef.current = true;
    setCreatePending(true);
    setCreateError("");
    try {
      const result = await itemsApi.create(body, attempt.key);
      createAttempt.current = null;
      setDataRefresh((value) => value + 1);
      openItem(result.item);
    } catch (error) {
      if (!handleAuthError(error)) setCreateError(getErrorMessage(error));
    } finally {
      createPendingRef.current = false;
      setCreatePending(false);
    }
  }

  async function runDetailMutation(
    name: string,
    operation: () => Promise<{ item?: WorkItem; comment?: Comment }>,
  ) {
    setDetailBusy(name);
    setDetailNotice("");
    setDetailError("");
    try {
      const result = await operation();
      if (result.comment) setComments((current) => [...current, result.comment!]);
      setDetailRefresh((value) => value + 1);
      setDataRefresh((value) => value + 1);
    } catch (error) {
      if (!handleAuthError(error)) {
        setDetailNotice(
          isVersionConflict(error)
            ? "This item changed since you opened it. Reload the latest version before continuing."
            : getErrorMessage(error),
        );
      }
    } finally {
      setDetailBusy("");
    }
  }

  if (sessionLoading) {
    return <main className="session-loading"><div className="spinner" aria-hidden="true" /><p role="status">Restoring your session…</p></main>;
  }
  if (!user) {
    return <LoginScreen expired={sessionExpired} restoreError={authError} onLogin={login} />;
  }

  const navItems: { id: "dashboard" | "items"; label: string; icon: string }[] = [
    { id: "dashboard", label: "Dashboard", icon: "⌂" },
    { id: "items", label: "Work items", icon: "▤" },
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a href="#" className="brand" onClick={(event) => { event.preventDefault(); setScreen("dashboard"); }}>
          <span className="brand-mark" aria-hidden="true">T</span>
          <span>TeamOrbit<span className="brand__sub">OPERATIONS</span></span>
        </a>
        <div className="sidebar-label">Workspace</div>
        <nav aria-label="Main navigation" className="main-nav">
          {navItems.map((entry) => (
            <button key={entry.id} className={`nav-link ${screen === entry.id || (screen === "detail" && entry.id === "items") ? "nav-link--active" : ""}`} onClick={() => setScreen(entry.id)}>
              <span aria-hidden="true">{entry.icon}</span>{entry.label}
            </button>
          ))}
        </nav>
        {writableTeams.length > 0 && <button className="button button--primary sidebar-create" onClick={() => { setCreateError(""); setScreen("create"); }}>＋ New work item</button>}
        <div className="sidebar-spacer" />
        <section className="team-list" aria-label="Your teams">
          <div className="sidebar-label">Your teams</div>
          {user.memberships.length === 0 ? <p className="team-empty">No team memberships</p> : user.memberships.map(({ team, role }) => (
            <div className="team-chip" key={team.id}>
              <span className="team-chip__mark">{team.name.slice(0, 1).toUpperCase()}</span>
              <span className="team-chip__name">{team.name}<small>{displayLabel(role)}</small></span>
            </div>
          ))}
        </section>
        <div className="profile">
          <div className="profile__avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</div>
          <div className="profile__identity"><strong>{user.name}</strong><span>{user.email}</span></div>
          <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={logout}>↗</button>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Operations</span><span aria-hidden="true">/</span><strong>{screen === "detail" ? "Work item" : screen === "create" ? "New work item" : displayLabel(screen)}</strong></div>
          <button className="profile-mobile" onClick={logout} aria-label={`Sign out ${user.name}`}><span className="profile__avatar">{user.name.slice(0, 1).toUpperCase()}</span></button>
        </header>
        {authError && <div className="global-error" role="alert">{authError}</div>}
        {screen === "dashboard" && (
          <section className="content-section">
            <div className="page-heading">
              <div><p className="eyebrow">Your workspace</p><h1>Good day, {user.name.split(" ")[0]}</h1><p className="muted">Here’s what needs your attention today.</p></div>
              <button className="button button--primary" onClick={() => { setCreateError(""); setScreen("create"); }} disabled={writableTeams.length === 0}>＋ Create work item</button>
            </div>
            {dashboardError && <ErrorState message={dashboardError} onRetry={() => setDataRefresh((value) => value + 1)} />}
            <section className="dashboard-group">
              <div className="section-heading"><div><p className="eyebrow">Your queue</p><h2>Assigned to me <span className="count">{dashboard?.assignedToMe.length ?? "—"}</span></h2></div><button className="text-button" onClick={() => setScreen("items")}>View all →</button></div>
              {dashboardLoading ? <ItemSkeletons /> : dashboard && <ItemGrid items={dashboard.assignedToMe} emptyTitle="Nothing assigned right now" emptyBody="Items assigned to you will appear here." onOpen={openItem} />}
            </section>
            <section className="dashboard-group">
              <div className="section-heading"><div><p className="eyebrow">Needs an owner</p><h2>Unassigned urgent <span className="count">{dashboard?.unassignedUrgent.length ?? "—"}</span></h2></div><button className="text-button" onClick={() => { setFilters({ ...emptyFilters, priority: "URGENT", assigneeId: "unassigned" }); setAppliedFilters({ ...emptyFilters, priority: "URGENT", assigneeId: "unassigned" }); setScreen("items"); }}>View queue →</button></div>
              {dashboardLoading ? <ItemSkeletons /> : dashboard && <ItemGrid items={dashboard.unassignedUrgent} emptyTitle="No urgent items waiting" emptyBody="Unassigned urgent work will show up here." onOpen={openItem} />}
            </section>
            <section className="dashboard-group">
              <div className="section-heading"><div><p className="eyebrow">Decision needed</p><h2>Awaiting my approval <span className="count">{dashboard?.awaitingMyApproval.length ?? "—"}</span></h2></div></div>
              {dashboardLoading ? <ItemSkeletons /> : dashboard && <ItemGrid items={dashboard.awaitingMyApproval} emptyTitle="No approvals pending" emptyBody="Items awaiting approval in your Lead teams will appear here." onOpen={openItem} />}
            </section>
          </section>
        )}
        {screen === "items" && (
          <section className="content-section">
            <div className="page-heading">
              <div><p className="eyebrow">Team workspace</p><h1>Work items</h1><p className="muted">Search and filter items in your teams.</p></div>
              {writableTeams.length > 0 && <button className="button button--primary" onClick={() => { setCreateError(""); setScreen("create"); }}>＋ New work item</button>}
            </div>
            <form className="filters" onSubmit={(event) => { event.preventDefault(); setAppliedFilters(filters); }}>
              <label className="search-field"><span className="sr-only">Search work items</span><span aria-hidden="true">⌕</span><input placeholder="Search title or description" value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} /></label>
              <label><span className="sr-only">Filter by status</span><select aria-label="Filter by status" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">All statuses</option>{statuses.map((value) => <option key={value} value={value}>{displayLabel(value)}</option>)}</select></label>
              <label><span className="sr-only">Filter by priority</span><select aria-label="Filter by priority" value={filters.priority} onChange={(event) => setFilters({ ...filters, priority: event.target.value })}><option value="">All priorities</option>{priorities.map((value) => <option key={value} value={value}>{displayLabel(value)}</option>)}</select></label>
              <label><span className="sr-only">Filter by type</span><select aria-label="Filter by type" value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value })}><option value="">All types</option>{itemTypes.map((value) => <option key={value} value={value}>{displayLabel(value)}</option>)}</select></label>
              <label><span className="sr-only">Filter by assignee</span><input aria-label="Filter by assignee" placeholder="Assignee ID or unassigned" value={filters.assigneeId} onChange={(event) => setFilters({ ...filters, assigneeId: event.target.value })} /></label>
              <button className="button button--secondary" type="submit">Apply filters</button>
            </form>
            {itemsError && <ErrorState message={itemsError} onRetry={() => setDataRefresh((value) => value + 1)} />}
            {itemsLoading && items.length === 0 ? <ItemSkeletons /> : items.length > 0 ? (
              <>
                <div className="list-summary">{items.length} item{items.length === 1 ? "" : "s"} loaded</div>
                <ItemGrid items={items} emptyTitle="" emptyBody="" onOpen={openItem} />
                {nextCursor && <div className="load-more"><button className="button button--secondary" disabled={itemsLoading} onClick={loadMore}>{itemsLoading ? "Loading…" : "Load more items"}</button></div>}
              </>
            ) : !itemsLoading && !itemsError ? <div className="empty-state"><span className="empty-state__icon" aria-hidden="true">⌕</span><h3>No matching work items</h3><p>Try changing your filters or search terms.</p></div> : null}
          </section>
        )}
        {screen === "create" && (
          <section className="content-section create-page">
            <button className="text-button back-link" onClick={() => setScreen("items")}>← Back to work items</button>
            <div className="page-heading"><div><p className="eyebrow">Work intake</p><h1>Create work item</h1><p className="muted">Add a clear description so the right team can take action.</p></div></div>
            {writableTeams.length === 0 ? <div className="notice notice--warning" role="status">You need a Member, Lead, or Admin role in a team to create work items.</div> : (
              <form className="surface create-form stack-form" onSubmit={createItem}>
                {createError && <div className="notice notice--error" role="alert">{createError}<p>Retry with the same details to safely replay an uncertain request.</p></div>}
                <label>Team<select name="teamId" required>{writableTeams.map(({ team }) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
                <label>Title<input name="title" maxLength={200} required placeholder="A short, specific summary" /></label>
                <label>Description<textarea name="description" maxLength={10000} rows={6} required placeholder="What happened, who is affected, and what is the impact?" /></label>
                <div className="form-row">
                  <label>Type<select name="type" defaultValue="TASK">{itemTypes.map((value) => <option key={value} value={value}>{displayLabel(value)}</option>)}</select></label>
                  <label>Priority<select name="priority" defaultValue="NORMAL">{priorities.map((value) => <option key={value} value={value}>{displayLabel(value)}</option>)}</select></label>
                </div>
                <label>Assignee user ID <input name="assigneeId" placeholder="Optional — must belong to this team" /></label>
                <p className="field-help">The API does not expose a team member directory. Leave blank to create an unassigned item.</p>
                <label>Due date<input name="dueDate" type="date" /></label>
                <div className="form-row form-row--end"><button type="button" className="button button--ghost" onClick={() => setScreen("items")}>Cancel</button><button className="button button--primary" disabled={createPending}>{createPending ? "Creating…" : "Create work item"}</button></div>
              </form>
            )}
          </section>
        )}
        {screen === "detail" && (
          <DetailPanel
            item={detailItem}
            user={user}
            events={activity}
            comments={comments}
            loading={detailLoading}
            error={detailError}
            notice={detailNotice}
            busy={detailBusy}
            onBack={() => setScreen("items")}
            onReload={() => setDetailRefresh((value) => value + 1)}
            onClaim={() => {
              if (!detailItem) return;
              void runDetailMutation("claim", async () => {
                const result = await itemsApi.claim(detailItem.id, detailItem.version);
                return { item: result.item };
              });
            }}
            onTransition={(status) => {
              if (!detailItem) return;
              void runDetailMutation("transition", async () => {
                const result = await itemsApi.transition(detailItem.id, detailItem.version, status);
                return { item: result.item };
              });
            }}
            onUpdate={(body) => {
              if (!detailItem) return Promise.resolve();
              return runDetailMutation("update", async () => {
                const result = await itemsApi.update(detailItem.id, body);
                return { item: result.item };
              });
            }}
            onComment={(body) => {
              if (!detailItem) return Promise.resolve();
              if (!body || body.length > 5000) {
                setDetailNotice("Comments must be between 1 and 5,000 characters.");
                return Promise.resolve();
              }
              return runDetailMutation("comment", async () => {
                const result = await itemsApi.addComment(detailItem.id, body);
                return { comment: result.comment };
              });
            }}
          />
        )}
      </main>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="notice notice--error error-state" role="alert">
      <span>{message}</span>
      <button className="button button--secondary" onClick={onRetry}>Try again</button>
    </div>
  );
}
