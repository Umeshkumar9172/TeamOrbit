import { createHash, randomBytes } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { parse, serialize } from "cookie";
import { z } from "zod";
import { getPrisma } from "./database.js";
import { verifyPassword } from "./password.js";

const SESSION_COOKIE = "newtonite_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const loginSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(128),
  })
  .strict();

declare module "express-serve-static-core" {
  interface Request {
    authenticatedUserId?: string;
  }
}

type SessionUser = {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  memberships: Array<{
    role: "VIEWER" | "MEMBER" | "LEAD" | "ADMIN";
    team: { id: string; name: string; slug: string };
  }>;
};

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  };
}

function serializeSessionCookie(token: string): string {
  return serialize(SESSION_COOKIE, token, sessionCookieOptions());
}

function clearSessionCookie(): string {
  return serialize(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeUser(user: SessionUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
    memberships: user.memberships.map(({ role, team }) => ({
      role,
      team: { id: team.id, name: team.name, slug: team.slug },
    })),
  };
}

export const authRouter = Router();

export async function requireAuthenticated(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const token = readSessionToken(request);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const session = await getPrisma().session.findFirst({
    where: { tokenHash: hashToken(token), expiresAt: { gt: new Date() } },
    select: { userId: true },
  });
  if (!session) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  request.authenticatedUserId = session.userId;
  next();
}

authRouter.use((_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  next();
});

authRouter.post("/login", async (request: Request, response: Response) => {
  const input = loginSchema.safeParse(request.body);
  if (!input.success) {
    response.status(400).json({ error: "Email and password are required and must be valid." });
    return;
  }

  const email = input.data.email.toLowerCase();
  const user = await getPrisma().user.findUnique({
    where: { email },
    include: {
      memberships: {
        include: { team: true },
        orderBy: { team: { name: "asc" } },
      },
    },
  });
  if (!user || !(await verifyPassword(user.passwordHash, input.data.password))) {
    response.status(401).json({ error: "Invalid email or password." });
    return;
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await getPrisma().session.create({
    data: { tokenHash: hashToken(token), userId: user.id, expiresAt },
  });

  response.setHeader("Set-Cookie", serializeSessionCookie(token));
  response.status(200).json({ user: safeUser(user) });
});

authRouter.post("/logout", async (request: Request, response: Response) => {
  const token = readSessionToken(request);
  if (token) {
    await getPrisma().session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  response.setHeader("Set-Cookie", clearSessionCookie());
  response.status(204).end();
});

authRouter.get("/me", async (request: Request, response: Response) => {
  const token = readSessionToken(request);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const session = await getPrisma().session.findFirst({
    where: { tokenHash: hashToken(token), expiresAt: { gt: new Date() } },
    include: {
      user: {
        include: {
          memberships: {
            include: { team: true },
            orderBy: { team: { name: "asc" } },
          },
        },
      },
    },
  });
  if (!session) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  response.status(200).json({ user: safeUser(session.user) });
});

function readSessionToken(request: Request): string | undefined {
  try {
    return parse(request.headers.cookie ?? "")[SESSION_COOKIE];
  } catch {
    return undefined;
  }
}
