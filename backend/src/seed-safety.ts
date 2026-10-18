export function assertDevelopmentSeedAllowed(nodeEnv = process.env.NODE_ENV): void {
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    throw new Error(
      "Development seed data requires NODE_ENV=development or NODE_ENV=test.",
    );
  }
}
