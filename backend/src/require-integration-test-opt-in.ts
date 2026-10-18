import { getIntegrationTestConfiguration } from "./integration-test-safety.js";

const configuration = getIntegrationTestConfiguration(process.env);
if (!configuration.enabled) {
  throw new Error(
    "Set RUN_DATABASE_INTEGRATION_TESTS=1 and provide TEST_DATABASE_URL to run integration tests.",
  );
}
