import { describe, expect, test } from "bun:test";
import { tokenizeJson } from "../src/components/JsonEditor";

describe("tokenizeJson", () => {
  test("classifies keys, strings, numbers, keywords and punctuation", () => {
    const tokens = tokenizeJson('{\n  "a": "x:y",\n  "n": -1.5e3,\n  "t": true,\n  "z": null\n}');
    const kinds = tokens.filter((t) => t.kind !== "text").map((t) => `${t.kind}:${t.text}`);
    expect(kinds).toEqual([
      "punct:{", "key:\"a\"", "punct::", "string:\"x:y\"", "punct:,",
      "key:\"n\"", "punct::", "number:-1.5e3", "punct:,",
      "key:\"t\"", "punct::", "keyword:true", "punct:,",
      "key:\"z\"", "punct::", "keyword:null", "punct:}",
    ]);
  });

  test("round-trips text exactly, including escapes and invalid JSON", () => {
    for (const src of ['{"k\\"q": "v\\n"}', "not json { at all", "", "[1, 2,\n"]) {
      expect(tokenizeJson(src).map((t) => t.text).join("")).toBe(src);
    }
  });
});
