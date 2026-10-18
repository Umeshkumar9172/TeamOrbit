export type MembershipRole = "VIEWER" | "MEMBER" | "LEAD" | "ADMIN";
export type ItemType = "INCIDENT" | "CUSTOMER_ISSUE" | "PAYMENT" | "COMPLIANCE" | "TASK";
export type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type Status = "OPEN" | "IN_PROGRESS" | "AWAITING_APPROVAL" | "RESOLVED" | "CLOSED";

export type Team = { id: string; name: string; slug: string };
export type Membership = { role: MembershipRole; team: Team };
export type User = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  memberships: Membership[];
};
export type WorkItem = {
  id: string;
  title: string;
  description: string;
  type: ItemType;
  priority: Priority;
  status: Status;
  teamId: string;
  assigneeId: string | null;
  creatorId: string;
  dueDate: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  team: Team;
  assignee: { id: string; name: string } | null;
  creator: { id: string; name: string };
};
export type ItemPage = { items: WorkItem[]; nextCursor: string | null };
export type DashboardData = {
  assignedToMe: WorkItem[];
  unassignedUrgent: WorkItem[];
  awaitingMyApproval: WorkItem[];
};
export type ActivityEvent = {
  id: string;
  workItemId: string;
  actorId: string;
  eventType: string;
  metadata: unknown;
  createdAt: string;
  actor: { id: string; name: string };
};
export type Comment = {
  id: string;
  workItemId: string;
  authorId: string;
  body: string;
  createdAt: string;
  author: { id: string; name: string };
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
  });

  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    let code: string | undefined;
    try {
      const body = (await response.json()) as { error?: unknown; code?: unknown };
      if (typeof body.error === "string") message = body.error;
      if (typeof body.code === "string") code = body.code;
    } catch {
      // Keep the generic HTTP message if the server returned no JSON body.
    }
    throw new ApiError(message, response.status, code);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const authApi = {
  current: () => apiRequest<{ user: User }>("/api/auth/me"),
  login: (email: string, password: string) =>
    apiRequest<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () =>
    apiRequest<void>("/api/auth/logout", { method: "POST" }),
};

export function buildItemQuery(filters: {
  q?: string;
  status?: string;
  priority?: string;
  type?: string;
  assigneeId?: string;
  cursor?: string | null;
}): string {
  const params = new URLSearchParams();
  for (const key of ["q", "status", "priority", "type", "assigneeId"] as const) {
    const value = filters[key]?.trim();
    if (value) params.set(key, value);
  }
  if (filters.cursor) params.set("cursor", filters.cursor);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const itemsApi = {
  dashboard: (signal?: AbortSignal) =>
    apiRequest<DashboardData>("/api/items/dashboard", { signal }),
  list: (query: string, signal?: AbortSignal) =>
    apiRequest<ItemPage>(`/api/items${query}`, { signal }),
  get: (id: string) =>
    apiRequest<{ item: WorkItem }>(`/api/items/${encodeURIComponent(id)}`),
  create: (body: Record<string, unknown>, key: string) =>
    apiRequest<{ item: WorkItem }>("/api/items", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(body),
    }),
  update: (id: string, body: Record<string, unknown>) =>
    apiRequest<{ item: WorkItem }>(`/api/items/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  claim: (id: string, version: number) =>
    apiRequest<{ item: WorkItem }>(`/api/items/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      body: JSON.stringify({ version }),
    }),
  transition: (id: string, version: number, to: Status) =>
    apiRequest<{ item: WorkItem }>(`/api/items/${encodeURIComponent(id)}/transition`, {
      method: "POST",
      body: JSON.stringify({ version, to }),
    }),
  activity: (id: string) =>
    apiRequest<{ events: ActivityEvent[] }>(`/api/items/${encodeURIComponent(id)}/activity`),
  comments: (id: string) =>
    apiRequest<{ comments: Comment[] }>(`/api/items/${encodeURIComponent(id)}/comments`),
  addComment: (id: string, body: string) =>
    apiRequest<{ comment: Comment }>(`/api/items/${encodeURIComponent(id)}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
};
