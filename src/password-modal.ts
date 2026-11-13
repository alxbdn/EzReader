import { Modal, type Key } from "./modal";
import { checkPassword, crackTime } from "./password-strength";
import { ICON_LOCK, ICON_UNLOCK, ICON_EYE } from "./icons";

type Mode = "protect" | "remove" | "unlock";

const STRENGTH: [Key, string][] = [
  ["pwStrength0", "—"], ["pwWeak", "Weak"], ["pwFair", "Fair"], ["pwGood", "Good"], ["pwStrong", "Strong"],
];
const TIME: Record<ReturnType<typeof crackTime>, [Key, string]> = {
  instant: ["pwTimeInstant", "guessed in an instant"],
  minutes: ["pwTimeMinutes", "≈ minutes to guess"],
  days: ["pwTimeDays", "≈ days to guess"],
  years: ["pwTimeYears", "≈ years to guess"],
  centuries: ["pwTimeCenturies", "≈ centuries to guess"],
};

/**
 * The PDF's password: protect it (with a strength meter), remove the
 * protection (with the current password), or unlock a protected file to open it.
 */
export class PasswordModal extends Modal {
  private mode: Mode = "protect";
  private resolve: ((v: string | null) => void) | null = null;
  private submit: ((pw: string) => Promise<boolean> | boolean) | null = null;

  private titleLabel: HTMLElement;
  private titleIcon: HTMLElement;
  private intro: HTMLElement;
  private pwLabel: HTMLElement;
  private pw: HTMLInputElement;
  private reveal: HTMLButtonElement;
  private meter: HTMLElement;
  private bars: HTMLElement[] = [];
  private strengthLabel: HTMLElement;
  private timeLabel: HTMLElement;
  private criteria: HTMLElement;
  private crit: { el: HTMLElement; key: "long" | "digit" | "special" | "upper" }[] = [];
  private tip: HTMLElement;
  private confirmField: HTMLElement;
  private confirmInput: HTMLInputElement;
  private warning: HTMLElement;
  private error: HTMLElement;

  constructor() {
    super("password-box", "pwProtectTitle", "Protect with a password", "pwProtectOk", "Protect", ICON_LOCK);
    this.titleIcon = this.head.querySelector(".ez-modal-icon")!;
    this.titleLabel = this.head.querySelector(".ez-modal-title > span:last-child")!;

    this.intro = this.el("p", "ez-intro");
    const field = this.el("label", "ez-field");
    this.pwLabel = this.el("span", "ez-label");
    const wrap = this.el("span", "ez-input-wrap");
    this.pw = this.el("input", "ez-input");
    this.pw.type = "password";
    this.pw.autocomplete = "new-password";
    this.pw.spellcheck = false;
    this.pw.addEventListener("input", () => { this.error.hidden = true; this.refresh(); });
    this.pw.addEventListener("keydown", (e) => { if (e.key === "Enter") void this.confirm(); });
    this.reveal = this.el("button", "icon-btn ez-reveal");
    this.reveal.type = "button";
    this.reveal.innerHTML = ICON_EYE;
    this.title(this.reveal, "pwShow", "Show the password");
    this.reveal.addEventListener("click", () => {
      const show = this.pw.type === "password";
      this.pw.type = this.confirmInput.type = show ? "text" : "password";
      this.reveal.classList.toggle("active", show);
    });
    wrap.append(this.pw, this.reveal);
    field.append(this.pwLabel, wrap);

    this.meter = this.el("div", "pw-meter");
    const bars = this.el("div", "pw-bars");
    for (let i = 0; i < 4; i++) {
      const b = this.el("span");
      this.bars.push(b);
      bars.append(b);
    }
    const legend = this.el("div", "pw-legend");
    this.strengthLabel = this.el("span", "pw-strength");
    this.timeLabel = this.el("span", "ez-card-sub");
    legend.append(this.strengthLabel, this.timeLabel);
    this.meter.append(bars, legend);

    this.criteria = this.el("div", "pw-criteria");
    for (const [k, key, fb] of [
      ["long", "pwCritLength", "12 characters or more"], ["digit", "pwCritDigit", "A number"],
      ["special", "pwCritSpecial", "A special character"], ["upper", "pwCritUpper", "An uppercase letter"],
    ] as const) {
      const el = this.el("span", "pw-crit");
      el.append(this.el("span", "pw-mark"), this.el("span", "", key, fb));
      this.crit.push({ el, key: k });
      this.criteria.append(el);
    }

    this.tip = this.el("div", "pw-tip");

    this.confirmField = this.el("label", "ez-field");
    this.confirmInput = this.el("input", "ez-input");
    this.confirmInput.type = "password";
    this.confirmInput.autocomplete = "new-password";
    this.confirmInput.addEventListener("input", () => this.refresh());
    this.confirmInput.addEventListener("keydown", (e) => { if (e.key === "Enter") void this.confirm(); });
    this.confirmField.append(this.el("span", "ez-label", "pwConfirm", "Confirm"), this.confirmInput);

    this.warning = this.el("div", "pw-warning");
    const bang = this.el("span", "pw-bang");
    bang.textContent = "!";
    bang.setAttribute("aria-hidden", "true");
    this.warning.append(bang, this.el("span", "", "pwWarning", "EzReader doesn't keep this password. If you forget it, nobody can open this PDF again, not even us. Write it down somewhere safe."));

    this.error = this.el("div", "ez-error");
    this.error.hidden = true;

    this.body.append(this.intro, field, this.meter, this.criteria, this.tip, this.confirmField, this.error, this.warning);
    this.okBtn.addEventListener("click", () => void this.confirm());
  }

  /** Asks for a new password; resolves with it, or null if cancelled. */
  askNew(): Promise<string | null> {
    return this.start("protect", null);
  }

  /** Asks for the current password; `check` says whether it is the right one. */
  askCurrent(check: (pw: string) => boolean): Promise<boolean> {
    return this.start("remove", check).then((v) => v !== null);
  }

  /** Asks for the password of a protected file until `tryOpen` accepts it. */
  askToOpen(fileName: string, tryOpen: (pw: string) => Promise<boolean>): Promise<boolean> {
    this.fileName = fileName;
    return this.start("unlock", tryOpen).then((v) => v !== null);
  }

  private fileName = "";

  private start(mode: Mode, submit: ((pw: string) => Promise<boolean> | boolean) | null): Promise<string | null> {
    this.resolve?.(null);
    this.mode = mode;
    this.submit = submit;
    this.pw.value = this.confirmInput.value = "";
    this.pw.type = this.confirmInput.type = "password";
    this.reveal.classList.remove("active");
    this.pw.autocomplete = mode === "protect" ? "new-password" : "current-password";
    this.error.hidden = true;
    this.okBtn.classList.toggle("btn-destructive", mode === "remove");
    this.refresh();
    this.show();
    setTimeout(() => this.pw.focus(), 0);
    return new Promise((res) => { this.resolve = res; });
  }

  override close(): void {
    super.close();
    const r = this.resolve;
    this.resolve = null;
    r?.(null);
  }

  private async confirm(): Promise<void> {
    if (this.okBtn.disabled) return;
    const pw = this.pw.value;
    if (this.submit) {
      this.okBtn.disabled = true;
      let ok = false;
      try { ok = await this.submit(pw); } finally { this.okBtn.disabled = false; }
      if (!ok) {
        this.error.textContent = this.tr("pwWrong", "That's not the right password.");
        this.error.hidden = false;
        this.pw.select();
        return;
      }
    }
    const r = this.resolve;
    this.resolve = null;
    super.close();
    r?.(pw);
  }

  protected override refresh(): void {
    if (!this.pw) return;
    const protect = this.mode === "protect";
    const [titleKey, titleFb, okKey, okFb, icon]: [Key, string, Key, string, string] =
      this.mode === "protect" ? ["pwProtectTitle", "Protect with a password", "pwProtectOk", "Protect", ICON_LOCK]
      : this.mode === "remove" ? ["pwRemoveTitle", "Remove the password", "pwRemoveOk", "Remove protection", ICON_UNLOCK]
      : ["pwUnlockTitle", "Protected PDF", "pwUnlockOk", "Open", ICON_LOCK];
    this.titleLabel.textContent = this.tr(titleKey, titleFb);
    this.titleIcon.innerHTML = icon;
    this.okBtn.textContent = this.tr(okKey, okFb);
    this.intro.hidden = protect;
    this.intro.textContent = this.mode === "remove"
      ? this.tr("pwRemoveIntro", "This PDF is protected. Enter its password to remove the protection for good when you save.")
      : this.tr("pwUnlockIntro", "{name} is protected. Enter its password to open it.").replace("{name}", this.fileName);
    this.pwLabel.textContent = protect ? this.tr("pwLabel", "Password") : this.tr("pwCurrent", "Current password");
    for (const el of [this.meter, this.criteria, this.tip, this.confirmField, this.warning]) el.hidden = !protect;

    if (protect) {
      const c = checkPassword(this.pw.value);
      const colors = ["", "#f87171", "#fb923c", "#facc15", "#4ade80"];
      this.bars.forEach((b, i) => { b.style.background = i < c.score ? colors[c.score] : ""; });
      const [sk, sf] = STRENGTH[c.score];
      this.strengthLabel.textContent = this.tr(sk, sf);
      this.strengthLabel.style.color = c.score ? colors[c.score] : "";
      const [tk, tf] = TIME[crackTime(c.log10Guesses)];
      this.timeLabel.textContent = this.pw.value ? this.tr(tk, tf) : "";
      for (const { el, key } of this.crit) {
        el.classList.toggle("met", c[key]);
        el.querySelector(".pw-mark")!.textContent = c[key] ? "✓" : "○";
      }
      this.tip.innerHTML = "";
      const [a, b] = this.tr("pwTip", "Tip: a {passphrase} is safer and easier to remember. For example {example}").split("{passphrase}");
      const [b1, b2] = (b ?? "").split("{example}");
      const strong = this.el("b");
      strong.textContent = this.tr("pwPassphrase", "passphrase");
      const ex = this.el("code");
      ex.textContent = this.tr("pwExample", "turtle-orange-jumps-7-times");
      // "For example …" goes on its own line, after the first sentence.
      const cut = (b1 ?? "").search(/[.。!！](?=[^.。!！]*$)/);
      const [first, rest] = cut >= 0 ? [(b1 ?? "").slice(0, cut + 1), (b1 ?? "").slice(cut + 1).trimStart()] : [b1 ?? "", ""];
      this.tip.append(a, strong, first, this.el("br"), rest, ex, b2 ?? "");
      const mismatch = this.confirmInput.value !== "" && this.confirmInput.value !== this.pw.value;
      this.confirmInput.classList.toggle("invalid", mismatch);
      this.okBtn.disabled = this.pw.value === "" || this.confirmInput.value !== this.pw.value;
    } else {
      this.okBtn.disabled = this.pw.value === "";
    }
  }
}
