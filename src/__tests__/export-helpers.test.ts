import { describe, expect, it } from "vitest";
import { formatPageRange, parsePageRange } from "../page-range";
import { checkPassword, crackTime } from "../password-strength";

describe("page ranges", () => {
  it("empty or all means every page", () => {
    expect(parsePageRange("", 3)).toEqual([1, 2, 3]);
    expect(parsePageRange("All (3)", 3)).toEqual([1, 2, 3]);
  });
  it("reads lists and ranges", () => {
    expect(parsePageRange("1-3, 5", 6)).toEqual([1, 2, 3, 5]);
    expect(parsePageRange("5, 2,2", 6)).toEqual([2, 5]);
    expect(parsePageRange("4-", 6)).toEqual([4, 5, 6]);
    expect(parsePageRange("-2", 6)).toEqual([1, 2]);
  });
  it("refuses pages out of the document or text", () => {
    expect(parsePageRange("0", 6)).toBeNull();
    expect(parsePageRange("7", 6)).toBeNull();
    expect(parsePageRange("3-1", 6)).toBeNull();
    expect(parsePageRange("abc", 6)).toBeNull();
  });
  it("writes lists the short way", () => {
    expect(formatPageRange([3])).toBe("3");
    expect(formatPageRange([2, 3, 4, 7, 9, 10])).toBe("2-4, 7, 9-10");
    expect(parsePageRange(formatPageRange([1, 2, 5]), 6)).toEqual([1, 2, 5]);
  });
});

describe("password strength", () => {
  it("scores the criteria", () => {
    expect(checkPassword("").score).toBe(0);
    expect(checkPassword("abc").score).toBe(1);
    const p = checkPassword("cheval-violet-pluie-42");
    expect([p.long, p.digit, p.special, p.upper]).toEqual([true, true, true, false]);
    expect(p.score).toBe(4);
  });
  it("repeated characters do not count as strong", () => {
    expect(checkPassword("aaaaaaaaaaaaaaaa").log10Guesses).toBeLessThan(5);
    expect(crackTime(checkPassword("aaaaaaaaaaaaaaaa").log10Guesses)).toBe("instant");
  });
  it("a long passphrase takes centuries", () => {
    expect(crackTime(checkPassword("tortue-orange-saute-7-fois").log10Guesses)).toBe("centuries");
  });
});
