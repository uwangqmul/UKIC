import test from "node:test";
import assert from "node:assert/strict";
import { portfolioUrl, uniquePortfolios } from "../src/umushroom-policy.js";

test("only accepts UMushroom portfolio detail URLs", () => {
  assert.equal(portfolioUrl("/en/alice/growth/portfolio/abc"), "https://umushroom.com/en/alice/growth/portfolio/abc");
  assert.equal(portfolioUrl("https://evil.com/en/a/b/portfolio/c"), null);
  assert.equal(portfolioUrl("/en/a/b/portfolio/c?x=1"), null);
  assert.equal(portfolioUrl("/en/a/edit/portfolio/c"), null);
});

test("de-duplicates by URL", () => {
  const list = uniquePortfolios([
    { name: "A", href: "/en/u/p/portfolio/1" },
    { name: "A again", href: "/en/u/p/portfolio/1#x" },
    { name: " ", href: "/en/u/p/portfolio/2" },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[1].name, "Unnamed portfolio");
});
