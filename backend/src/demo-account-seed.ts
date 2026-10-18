import { DemoAccountSafetyError } from "./demo-account-database-safety.js";

export const demoAccountSeedConfirmationPhrase = "UPDATE FOUR DEMO ACCOUNTS";

export async function confirmDemoAccountSeed(
  isInteractive: boolean,
  ask: (question: string) => Promise<string>,
): Promise<boolean> {
  if (!isInteractive) {
    throw new DemoAccountSafetyError(
      "The development seed requires an interactive terminal.",
    );
  }

  const response = await ask(
    `Type "${demoAccountSeedConfirmationPhrase}" to update the existing demo accounts: `,
  );
  return response === demoAccountSeedConfirmationPhrase;
}
