import "./env.js";
import type { ErrorRequestHandler } from "express";
import express from "express";
import { authRouter } from "./auth.js";
import { itemsRouter } from "./items.js";

export const app = express();

app.use(express.json({ limit: "16kb" }));

app.get("/api/health", (_request, response) => {
  response.status(200).json({ status: "ok" });
});

app.use("/api/auth", authRouter);
app.use("/api/items", itemsRouter);

app.use((_request, response) => {
  response.status(404).json({ error: "Not found." });
});

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  void _next;
  if (
    error instanceof SyntaxError &&
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 400
  ) {
    response.status(400).json({ error: "Invalid JSON request body." });
    return;
  }
  response.status(500).json({ error: "Internal server error." });
};

app.use(errorHandler);
