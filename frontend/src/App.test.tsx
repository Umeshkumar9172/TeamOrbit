// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { DashboardData, User, WorkItem } from "./api";

const user: User = {
  id: "user-1",
  email: "operator@example.test",
  name: "Olivia Operator",
  createdAt: "2026-10-16T09:00:00.000Z",
  memberships: [{ role: "MEMBER", team: { id: "team-1", name: "Operations", slug: "operations" } }],
};

const item: WorkItem = {
  id: "item-1",
  title: "Payment queue delays",
  description: "Investigate delayed payment processing.",
  type: "INCIDENT",
  priority: "URGENT",
  status: "OPEN",
  teamId: "team-1",
  assigneeId: null,
  creatorId: "user-1",
  dueDate: null,
  version: 1,
  createdAt: "2026-10-16T09:00:00.000Z",
  updatedAt: "2026-10-16T09:00:00.000Z",
  team: { id: "team-1", name: "Operations", slug: "operations" },
  assignee: null,
  creator: { id: "user-1", name: "Olivia Operator" },
};

const dashboard: DashboardData = {
  assignedToMe: [],
  unassignedUrgent: [item],
  awaitingMyApproval: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function installAuthenticatedApi(
  overrides: (path: string, init: RequestInit) => Response | Promise<Response>,
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) =>
    Promise.resolve(overrides(String(input), init)),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function authenticatedResponse(path: string, init: RequestInit): Response {
  if (path === "/api/auth/me") return jsonResponse({ user });
  if (path === "/api/items/dashboard") return jsonResponse(dashboard);
  if (path === `/api/items/${item.id}`) return jsonResponse({ item });
  if (path === `/api/items/${item.id}/activity`) return jsonResponse({ events: [] });
  if (path === `/api/items/${item.id}/comments`) return jsonResponse({ comments: [] });
  if (path === "/api/items") return jsonResponse({ items: [item], nextCursor: null });
  if (init.method === "POST" && path === `/api/items/${item.id}/claim`) {
    return jsonResponse({ error: "Work item version conflict.", code: "VERSION_CONFLICT" }, 409);
  }
  return jsonResponse({}, 404);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TeamOrbit frontend", () => {
  it("restores the cookie session and renders dashboard data from the API", async () => {
    const fetchMock = installAuthenticatedApi(authenticatedResponse);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Good day, Olivia" })).toBeTruthy();
    expect(await screen.findByText("Payment queue delays")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/me",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("shows invalid credentials and does not leave the login screen", async () => {
    installAuthenticatedApi((path) =>
      path === "/api/auth/me"
        ? jsonResponse({ error: "Authentication required." }, 401)
        : jsonResponse({ error: "Invalid email or password." }, 401),
    );
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Email address"), { target: { value: "bad@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "incorrect" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Email or password is incorrect.");
    expect(screen.getByRole("heading", { name: "TeamOrbit" })).toBeTruthy();
  });

  it("displays session-expired and session-restoration server errors", async () => {
    let dashboardUnauthorized = true;
    installAuthenticatedApi((path) => {
      if (path === "/api/auth/me") return jsonResponse({ user });
      if (path === "/api/items/dashboard" && dashboardUnauthorized) {
        return jsonResponse({ error: "Authentication required." }, 401);
      }
      return jsonResponse({ error: "Authentication service unavailable." }, 503);
    });
    const view = render(<App />);
    expect(await screen.findByText("Your session has expired. Sign in again to continue.")).toBeTruthy();
    view.unmount();

    installAuthenticatedApi(() => jsonResponse({ error: "Session service unavailable." }, 503));
    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toContain("Session service unavailable.");
    dashboardUnauthorized = false;
  });

  it("shows dashboard empty states and provides retry after a server error", async () => {
    let failDashboard = true;
    const firstDashboard = deferred<Response>();
    let dashboardCalls = 0;
    installAuthenticatedApi((path) => {
      if (path === "/api/auth/me") return jsonResponse({ user });
      if (path === "/api/items/dashboard" && dashboardCalls++ === 0) return firstDashboard.promise;
      if (path === "/api/items/dashboard" && failDashboard) {
        return jsonResponse({ error: "Service unavailable." }, 503);
      }
      return jsonResponse({ assignedToMe: [], unassignedUrgent: [], awaitingMyApproval: [] });
    });
    render(<App />);

    expect((await screen.findAllByLabelText("Loading work items")).length).toBeGreaterThan(0);
    firstDashboard.resolve(jsonResponse({ error: "Service unavailable." }, 503));
    expect((await screen.findByRole("alert")).textContent).toContain("Service unavailable.");
    failDashboard = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Nothing assigned right now")).toBeTruthy();
    expect(screen.getByText("No urgent items waiting")).toBeTruthy();
    expect(screen.getByText("No approvals pending")).toBeTruthy();
  });

  it("logs in and logs out through the cookie-backed auth endpoints", async () => {
    const calls: string[] = [];
    installAuthenticatedApi((path, init) => {
      calls.push(`${init.method ?? "GET"} ${path}`);
      if (path === "/api/auth/me") return jsonResponse({ error: "Authentication required." }, 401);
      if (path === "/api/auth/login") return jsonResponse({ user });
      if (path === "/api/items/dashboard") return jsonResponse(dashboard);
      if (path === "/api/auth/logout") return jsonResponse({}, 204);
      return jsonResponse({}, 404);
    });
    render(<App />);

    fireEvent.change(await screen.findByLabelText("Email address"), { target: { value: user.email } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "not-rendered" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Good day, Olivia" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Sign out" })[0]);
    expect(await screen.findByRole("heading", { name: "TeamOrbit" })).toBeTruthy();
    expect(calls).toContain("POST /api/auth/login");
    expect(calls).toContain("POST /api/auth/logout");
  });

  it("prevents duplicate create submits and reuses the idempotency key on a retry", async () => {
    const firstCreate = deferred<Response>();
    const createHeaders: string[] = [];
    let createCount = 0;
    installAuthenticatedApi((path, init) => {
      if (path === "/api/auth/me") return jsonResponse({ user });
      if (path === "/api/items" && init.method === "POST") {
        createCount += 1;
        createHeaders.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
        if (createCount === 1) return firstCreate.promise;
        return jsonResponse({ error: "Unexpected create response." }, 503);
      }
      return authenticatedResponse(path, init);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "＋ New work item" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Queue investigation" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Inspect delayed payments." } });
    const form = screen.getByRole("button", { name: "Create work item" }).closest("form");
    if (!form) throw new Error("Create form was not rendered.");

    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(createCount).toBe(1));
    firstCreate.reject(new TypeError("Network connection lost."));
    expect((await screen.findByRole("alert")).textContent).toContain("Network connection lost.");

    fireEvent.submit(form);
    await waitFor(() => expect(createCount).toBe(2));
    expect(createHeaders[0]).not.toBe("");
    expect(createHeaders[1]).toBe(createHeaders[0]);
  });

  it("shows a safe version conflict and lets the user reload the latest item", async () => {
    let version = 1;
    const fetchMock = installAuthenticatedApi((path, init) => {
      if (path === "/api/auth/me") return jsonResponse({ user });
      if (path === `/api/items/${item.id}` && (!init.method || init.method === "GET")) return jsonResponse({ item: { ...item, version } });
      if (path === `/api/items/${item.id}/activity`) return jsonResponse({ events: [] });
      if (path === `/api/items/${item.id}/comments`) return jsonResponse({ comments: [] });
      if (path === `/api/items/${item.id}` && init.method === "PATCH") {
        return jsonResponse({ error: "Work item version conflict.", code: "VERSION_CONFLICT" }, 409);
      }
      if (init.method === "PATCH") return jsonResponse({ error: "Work item version conflict." }, 409);
      return authenticatedResponse(path, init);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open item" }));
    expect(await screen.findByRole("heading", { name: "Update item" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Updated title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/This item changed since you opened it/)).toBeTruthy();
    const patchCall = fetchMock.mock.calls.find(([path, init]) => String(path) === `/api/items/${item.id}` && init?.method === "PATCH");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({ version: 1, title: "Updated title" });

    version = 2;
    fireEvent.click(screen.getByRole("button", { name: "Reload latest item" }));
    expect(await screen.findByText("Version 2")).toBeTruthy();
  });

  it("shows a claim conflict with a reload action", async () => {
    installAuthenticatedApi(authenticatedResponse);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open item" }));
    fireEvent.click(await screen.findByRole("button", { name: "Claim item" }));

    expect(await screen.findByText(/This item changed since you opened it/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload latest item" })).toBeTruthy();
  });

  it("shows server authorization failures for workflow transitions", async () => {
    installAuthenticatedApi((path, init) => {
      if (path === `/api/items/${item.id}/transition`) {
        return jsonResponse({ error: "You cannot transition work items in this team." }, 403);
      }
      return authenticatedResponse(path, init);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open item" }));
    fireEvent.click(await screen.findByRole("button", { name: "Move to In Progress" }));

    expect(await screen.findByText("You cannot transition work items in this team.")).toBeTruthy();
  });

  it("sends the expected item version for a successful transition", async () => {
    let currentItem = item;
    const fetchMock = installAuthenticatedApi((path, init) => {
      if (path === `/api/items/${item.id}/transition`) {
        currentItem = { ...item, status: "IN_PROGRESS", version: 2 };
        return jsonResponse({ item: currentItem });
      }
      if (path === `/api/items/${item.id}` && (!init.method || init.method === "GET")) return jsonResponse({ item: currentItem });
      return authenticatedResponse(path, init);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open item" }));
    fireEvent.click(await screen.findByRole("button", { name: "Move to In Progress" }));

    expect(await screen.findByText("Version 2")).toBeTruthy();
    expect(screen.getByText("In Progress")).toBeTruthy();
    const transitionCall = fetchMock.mock.calls.find(([path]) => String(path) === `/api/items/${item.id}/transition`);
    expect(JSON.parse(String(transitionCall?.[1]?.body))).toEqual({ version: 1, to: "IN_PROGRESS" });
  });

  it("claims an eligible item using its expected version", async () => {
    let currentItem = item;
    const fetchMock = installAuthenticatedApi((path, init) => {
      if (path === `/api/items/${item.id}/claim`) {
        currentItem = {
          ...item,
          assigneeId: user.id,
          assignee: { id: user.id, name: user.name },
          version: 2,
        };
        return jsonResponse({ item: currentItem });
      }
      if (path === `/api/items/${item.id}` && (!init.method || init.method === "GET")) return jsonResponse({ item: currentItem });
      return authenticatedResponse(path, init);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open item" }));
    fireEvent.click(await screen.findByRole("button", { name: "Claim item" }));

    expect(await screen.findByText("Version 2")).toBeTruthy();
    expect(screen.getAllByText("Olivia Operator").length).toBeGreaterThan(0);
    const claimCall = fetchMock.mock.calls.find(([path]) => String(path) === `/api/items/${item.id}/claim`);
    expect(JSON.parse(String(claimCall?.[1]?.body))).toEqual({ version: 1 });
  });

  it("shows approval actions only to a Lead in the item's team", async () => {
    const approvalItem = { ...item, status: "AWAITING_APPROVAL" as const, assigneeId: "user-1" };
    const viewer = {
      ...user,
      memberships: [{ role: "ADMIN" as const, team: user.memberships[0].team }],
    };
    installAuthenticatedApi((path) => {
      if (path === "/api/auth/me") return jsonResponse({ user: viewer });
      if (path === "/api/items/dashboard") return jsonResponse({ assignedToMe: [], unassignedUrgent: [], awaitingMyApproval: [] });
      if (path === "/api/items") return jsonResponse({ items: [approvalItem], nextCursor: null });
      if (path === `/api/items/${item.id}`) return jsonResponse({ item: approvalItem });
      if (path.endsWith("/activity")) return jsonResponse({ events: [] });
      if (path.endsWith("/comments")) return jsonResponse({ comments: [] });
      return jsonResponse({}, 404);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Work items" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open item" }));

    expect(await screen.findByText("Approval is restricted to a Lead in this item’s team.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move to Resolved" })).toBeNull();
  });

  it("submits comments and refreshes the chronological activity and comment feeds", async () => {
    let comments: Array<{ id: string; workItemId: string; authorId: string; body: string; createdAt: string; author: { id: string; name: string } }> = [];
    installAuthenticatedApi((path, init) => {
      if (path === "/api/auth/me") return jsonResponse({ user });
      if (path.endsWith("/comments") && init.method === "POST") {
        const body = JSON.parse(String(init.body)) as { body: string };
        const comment = { id: "comment-1", workItemId: item.id, authorId: user.id, body: body.body, createdAt: "2026-10-16T10:00:00.000Z", author: { id: user.id, name: user.name } };
        comments = [comment];
        return jsonResponse({ comment }, 201);
      }
      if (path.endsWith("/comments")) return jsonResponse({ comments });
      if (path.endsWith("/activity")) return jsonResponse({ events: [{
        id: "event-1",
        workItemId: item.id,
        actorId: user.id,
        eventType: "ITEM_CREATED",
        metadata: {},
        createdAt: "2026-10-16T09:00:00.000Z",
        actor: { id: user.id, name: user.name },
      }] });
      if (path === `/api/items/${item.id}`) return jsonResponse({ item });
      if (path === "/api/items/dashboard") return jsonResponse(dashboard);
      return authenticatedResponse(path, init);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open item" }));
    const commentField = await screen.findByLabelText("Add a comment");
    fireEvent.change(commentField, { target: { value: "I am investigating the queue." } });
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));

    expect(await screen.findByText("I am investigating the queue.")).toBeTruthy();
    expect(screen.getByText("Created this work item.")).toBeTruthy();
    expect(screen.getAllByText("Olivia Operator").length).toBeGreaterThan(0);
  });
});
