import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { queryFirst, routeParam } from "./routeParam";

function req(params: Record<string, string | string[]>, query: Record<string, string | string[] | undefined> = {}): Request {
  return { params, query } as unknown as Request;
}

describe("routeParam", () => {
  it("returns string route params as-is", () => {
    expect(routeParam(req({ id: "abc" }), "id")).toBe("abc");
  });

  it("normalizes array route params from Express 5 typing", () => {
    expect(routeParam(req({ id: ["x"] }), "id")).toBe("x");
  });

  it("returns empty string when missing", () => {
    expect(routeParam(req({}), "id")).toBe("");
  });
});

describe("queryFirst", () => {
  it("returns first query value", () => {
    expect(queryFirst(req({}, { page: "2" }), "page")).toBe("2");
  });

  it("normalizes array query values", () => {
    expect(queryFirst(req({}, { q: ["a", "b"] }), "q")).toBe("a");
  });
});
