import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  HiddenPasswordInputError,
  readHiddenPassword,
  type HiddenPasswordInput,
} from "./hidden-terminal-password.js";

class FakeInput extends EventEmitter implements HiddenPasswordInput {
  isTTY = true;
  raw = false;
  encoding: string | undefined;

  setRawMode(mode: boolean) {
    this.raw = mode;
  }

  setEncoding(encoding: "utf8") {
    this.encoding = encoding;
  }

  resume() {}

  pause() {}
}

function enter(input: FakeInput, text: string) {
  input.emit("data", text);
}

describe("hidden terminal password input", () => {
  it("reads a password without echo and ignores a CRLF split across prompts", async () => {
    const input = new FakeInput();
    const output: string[] = [];
    const first = readHiddenPassword("VIEWER", input, (text) => output.push(text));
    enter(input, "Demo@123\r");
    await expect(first).resolves.toBe("Demo@123");
    expect(input.raw).toBe(false);
    expect(output.join("")).not.toContain("Demo@123");

    const second = readHiddenPassword("MEMBER", input, (text) => output.push(text));
    enter(input, "\n");
    enter(input, "Demo@123\r\n");
    await expect(second).resolves.toBe("Demo@123");
    expect(output.join("")).not.toContain("Demo@123");
  });

  it("rejects empty input with a safe actionable message", async () => {
    const input = new FakeInput();
    const pending = readHiddenPassword("LEAD", input, () => {});
    enter(input, "\r\n");
    await expect(pending).rejects.toThrow(
      "LEAD password must be between 1 and 128 characters.",
    );
  });

  it("rejects non-interactive input before prompting", async () => {
    const input = new FakeInput();
    input.isTTY = false;
    let prompted = false;
    await expect(
      readHiddenPassword("ADMIN", input, () => {
        prompted = true;
      }),
    ).rejects.toBeInstanceOf(HiddenPasswordInputError);
    expect(prompted).toBe(false);
  });

  it("clears and rejects cancelled input", async () => {
    const input = new FakeInput();
    const pending = readHiddenPassword("VIEWER", input, () => {});
    enter(input, "partial\u0003");
    await expect(pending).rejects.toThrow("Password entry was cancelled.");
    expect(input.raw).toBe(false);
  });
});
