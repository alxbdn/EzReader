import { describe, expect, it } from "vitest";
import { CommandError, errorCode, toCommandError } from "../errors";

describe("command errors", () => {
  it("turns a command's {code, detail} into a CommandError", () => {
    const err = toCommandError({ code: "wrong-password", detail: "wrong password" });
    expect(err).toBeInstanceOf(CommandError);
    expect(errorCode(err)).toBe("wrong-password");
    expect(String(err)).toBe("wrong password");
  });

  it("leaves anything else as it is", () => {
    expect(toCommandError("plain text")).toBe("plain text");
    expect(errorCode(new Error("x"))).toBeNull();
    expect(errorCode("PasswordException")).toBeNull();
  });
});
