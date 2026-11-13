export interface PasswordCheck {
  /** 0 (empty) to 4 (strong). */
  score: 0 | 1 | 2 | 3 | 4;
  long: boolean;
  digit: boolean;
  special: boolean;
  upper: boolean;
  /** Rough guesses an offline attacker would need: 10^log10Guesses. */
  log10Guesses: number;
}

/**
 * How hard a password is to guess. Four criteria (12+ characters, a
 * number, a special character, an uppercase letter); 16+ characters count
 * as one more. The guess count assumes random picks from the character
 * sets used, discounted for repeats, so it stays on the optimistic side.
 */
export function checkPassword(pw: string): PasswordCheck {
  const long = [...pw].length >= 12;
  const digit = /\d/.test(pw);
  const special = /[^\p{L}\p{N}]/u.test(pw);
  const upper = /\p{Lu}/u.test(pw);
  const lower = /\p{Ll}/u.test(pw);
  const met = [long, digit, special, upper].filter(Boolean).length + ([...pw].length >= 16 ? 1 : 0);
  const score = (pw.length === 0 ? 0 : Math.max(1, Math.min(4, met))) as PasswordCheck["score"];
  const pool = (lower ? 26 : 0) + (upper ? 26 : 0) + (digit ? 10 : 0) + (special ? 20 : 0) || 1;
  const distinct = new Set(pw).size;
  const length = Math.min([...pw].length, distinct * 2);
  return { score, long, digit, special, upper, log10Guesses: length * Math.log10(pool) };
}

/** Time bucket for guessing at ten billion tries a second. */
export function crackTime(log10Guesses: number): "instant" | "minutes" | "days" | "years" | "centuries" {
  const seconds = log10Guesses - 10;
  if (seconds < 1) return "instant";
  if (seconds < Math.log10(86400)) return "minutes";
  if (seconds < Math.log10(86400 * 365)) return "days";
  if (seconds < Math.log10(86400 * 365 * 100)) return "years";
  return "centuries";
}
