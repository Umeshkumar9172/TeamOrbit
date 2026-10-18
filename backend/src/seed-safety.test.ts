import { describe, expect, it } from "vitest";
import { assertDevelopmentSeedAllowed } from "./seed-safety.js";

describe("development seed safety", () => {
  it.each(["production", "staging"])(
    "refuses to seed when NODE_ENV is %s",
    (nodeEnv) => {
      expect(() => assertDevelopmentSeedAllowed(nodeEnv)).toThrow(
        "Development seed data requires NODE_ENV=development or NODE_ENV=test.",
      );
    },
  );

  it("refuses to seed when NODE_ENV is unset", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;

    try {
      expect(() => assertDevelopmentSeedAllowed()).toThrow(
        "Development seed data requires NODE_ENV=development or NODE_ENV=test.",
      );
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  it.each(["development", "test"])(
    "allows the %s environment",
    (nodeEnv) => {
      expect(() => assertDevelopmentSeedAllowed(nodeEnv)).not.toThrow();
    },
  );
});
