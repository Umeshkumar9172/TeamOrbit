export type HiddenPasswordInput = {
  isTTY: boolean | undefined;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding: (encoding: "utf8") => unknown;
  resume: () => unknown;
  pause: () => unknown;
  on: (event: "data", listener: (chunk: string) => void) => unknown;
  off: (event: "data", listener: (chunk: string) => void) => unknown;
};

export class HiddenPasswordInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HiddenPasswordInputError";
  }
}

let ignoreNextLineFeed = false;

export async function readHiddenPassword(
  label: string,
  input: HiddenPasswordInput,
  write: (text: string) => void,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new HiddenPasswordInputError(
      "Password entry requires an interactive terminal.",
    );
  }

  write(`${label} password (input hidden): `);
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();

  return new Promise((resolvePassword, rejectPassword) => {
    let password = "";
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      input.setRawMode!(false);
      input.pause();
      write("\r\n");
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (ignoreNextLineFeed) {
          ignoreNextLineFeed = false;
          if (character === "\n") continue;
        }

        if (character === "\u0003" || character === "\u0004") {
          cleanup();
          password = "";
          rejectPassword(
            new HiddenPasswordInputError("Password entry was cancelled."),
          );
          return;
        }
        if (character === "\r" || character === "\n") {
          if (character === "\r") ignoreNextLineFeed = true;
          cleanup();
          if (password.length === 0 || password.length > 128) {
            password = "";
            rejectPassword(
              new HiddenPasswordInputError(
                `${label} password must be between 1 and 128 characters.`,
              ),
            );
            return;
          }
          resolvePassword(password);
          password = "";
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          password = password.slice(0, -1);
        } else if (character >= " ") {
          password += character;
        }
      }
    };
    input.on("data", onData);
  });
}
