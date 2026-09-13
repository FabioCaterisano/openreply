import { afterEach, expect, it, vi } from "vitest";
import { getUserMediaPage, getMediaDetails } from "@/lib/meta/client";
afterEach(() => vi.unstubAllGlobals());

it("uses only the own media endpoint and passes native cursors without provider URLs", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "one" }], paging: { next: "https://graph.instagram.com/me/media?access_token=SECRET", cursors: { after: "next-cursor" } } })));
  vi.stubGlobal("fetch", fetchMock);
  expect(await getUserMediaPage("token", "previous")).toEqual({ data: [{ id: "one" }], after: "next-cursor" });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url.pathname).toMatch(/\/me\/media$/);
  expect(url.searchParams.get("after")).toBe("previous");
  expect(url.searchParams.has("access_token")).toBe(false);
  expect(init.headers.Authorization).toBe("Bearer token");
});
it("rejects incomplete pagination instead of reporting complete", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [], paging: { next: "https://example.com/next" } }))));
  await expect(getUserMediaPage("token")).rejects.toThrow("Invalid media pagination");
});
it("rejects failed metadata and missing media identity", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "down", code: 2 } }), { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({ id: "wrong" }))));
  await expect(getMediaDetails("token", "one")).rejects.toThrow();
  await expect(getMediaDetails("token", "one")).rejects.toThrow("Incomplete media metadata");
});
