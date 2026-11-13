import { describe, expect, it, vi } from "vitest";
import { Protection, type ProtectionDeps } from "../protection";

function setUp(state: { protected?: string; pending?: string } = {}) {
  let lock = state.protected ?? null;
  let pending = state.pending ?? null;
  const session = {
    isOpen: true,
    get isProtected() { return lock !== null; },
    get hasPendingPassword() { return pending !== null; },
    unlock: (pw: string) => { if (pw !== lock) return false; lock = null; return true; },
    protect: (pw: string | null) => { pending = pw; },
  };
  const toolbar = { setProtected: vi.fn(), setReadOnly: vi.fn(), onReadOnlyRefused: vi.fn() };
  const passwords = { askCurrent: vi.fn(), askNew: vi.fn() };
  const notify = vi.fn();
  const setDirty = vi.fn();
  const deps: ProtectionDeps = { session: session as never, toolbar, passwords, msg: (k) => k, notify, setDirty };
  return { protection: new Protection(deps), toolbar, passwords, notify, setDirty };
}

describe("Protection", () => {
  it("makes a protected document read-only and refuses with a message", () => {
    const { protection, toolbar, notify } = setUp({ protected: "secret" });
    protection.sync();
    expect(toolbar.setProtected).toHaveBeenLastCalledWith(true);
    expect(toolbar.setReadOnly).toHaveBeenLastCalledWith(true);
    expect(protection.refuse()).toBe(true);
    expect(notify).toHaveBeenCalledWith("msgProtectedReadOnly", true);
  });

  it("refused toolbar actions show the same message", () => {
    const { toolbar, notify } = setUp({ protected: "secret" });
    const refused = toolbar.onReadOnlyRefused.mock.calls[0][0] as () => void;
    refused();
    expect(notify).toHaveBeenCalledWith("msgProtectedReadOnly", true);
  });

  it("the padlock on a protected file unlocks it with the right password", async () => {
    const { protection, passwords, toolbar, setDirty } = setUp({ protected: "secret" });
    passwords.askCurrent.mockImplementation(async (check: (pw: string) => boolean) => check("wrong") || check("secret"));
    await protection.edit();
    expect(toolbar.setReadOnly).toHaveBeenLastCalledWith(false);
    expect(setDirty).toHaveBeenCalledWith(true);
    expect(protection.refuse()).toBe(false);
  });

  it("the padlock chooses a password, then cancels it before saving", async () => {
    const { protection, passwords, toolbar } = setUp();
    passwords.askNew.mockResolvedValue("pw");
    await protection.edit();
    expect(toolbar.setProtected).toHaveBeenLastCalledWith(true);
    expect(toolbar.setReadOnly).toHaveBeenLastCalledWith(false);
    await protection.edit();
    expect(toolbar.setProtected).toHaveBeenLastCalledWith(false);
  });
});
