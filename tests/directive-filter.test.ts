import { expect, test, describe } from "bun:test";
import { findDirectiveSnippets } from "../shared/directive-filter.ts";

describe("findDirectiveSnippets — positive cases (real directives)", () => {
  test("plain TODO: line", () => {
    const text = "TODO: merge PR #42 after CI turns green";
    expect(findDirectiveSnippets(text).length).toBe(1);
  });

  test("plain Claude: line", () => {
    const text = "Claude: pull the friendlies list from the CRM";
    expect(findDirectiveSnippets(text).length).toBe(1);
  });

  test("bullet + TODO:", () => {
    const text = "- TODO: fix the feedback widget copy";
    expect(findDirectiveSnippets(text).length).toBe(1);
  });

  test("numbered list + Claude:", () => {
    const text = "1. Claude: draft the launch post outline";
    expect(findDirectiveSnippets(text).length).toBe(1);
  });

  test("blockquote + TODO:", () => {
    const text = "> TODO: update the README with the new deploy URL";
    expect(findDirectiveSnippets(text).length).toBe(1);
  });

  test("bold-wrapped TODO: at line start", () => {
    const text = "**TODO:** tighten the directive filter by EOW";
    expect(findDirectiveSnippets(text).length).toBe(1);
  });

  test("bold blockquote Claude: with list marker", () => {
    const text = "> - **Claude:** run the weekly status skill";
    expect(findDirectiveSnippets(text).length).toBe(1);
  });

  test("case-insensitive matches", () => {
    expect(findDirectiveSnippets("todo: lowercase works").length).toBe(1);
    expect(findDirectiveSnippets("claude: lowercase works").length).toBe(1);
  });

  test("multiple directives in one document — snippets cover both", () => {
    const text = [
      "Here is the plan.",
      "",
      "- TODO: file the tax extension",
      "- Claude: draft the response email to the landlord",
      "",
      "End.",
    ].join("\n");
    const combined = findDirectiveSnippets(text).join("\n");
    expect(combined).toContain("TODO:");
    expect(combined).toContain("Claude:");
  });
});

describe("findDirectiveSnippets — negative cases (the false-positive soup)", () => {
  test("'Claude Design' product-name mention does NOT match", () => {
    const text = "Bryan × Claude Design — bike map: Claude Design session (in progress, ~60-90 min)";
    expect(findDirectiveSnippets(text)).toEqual([]);
  });

  test("'Claude Code' product-name mention does NOT match", () => {
    const text = "Newly landed in Claude Code v2.1.111. Test on a non-trivial PR.";
    expect(findDirectiveSnippets(text)).toEqual([]);
  });

  test("boilerplate footer explaining the markers does NOT match", () => {
    const text =
      "*Bryan: edit anything above, add **`TODO:`** or **`Claude:`** markers where you want the conductor to act, or leave comments.*";
    expect(findDirectiveSnippets(text)).toEqual([]);
  });

  test("'From: Conductor' attribution does NOT match", () => {
    const text = "**From: Conductor** — mapping Goals 1-6 against the actual week.";
    expect(findDirectiveSnippets(text)).toEqual([]);
  });

  test("'Bryan's voice' blockquote attribution does NOT match", () => {
    const text = "**Bryan's voice** (preserved from his draft):\n> I want to get bike map out into the world.";
    expect(findDirectiveSnippets(text)).toEqual([]);
  });

  test("'TODO' word without colon does NOT match", () => {
    const text = "- Status: 3 TODO items remaining in the backlog";
    expect(findDirectiveSnippets(text)).toEqual([]);
  });

  test("'Claude' word without colon does NOT match", () => {
    const text = "Ask Claude if it can help with the homepage copy.";
    expect(findDirectiveSnippets(text)).toEqual([]);
  });

  test("backtick-wrapped `TODO:` inside prose does NOT match", () => {
    const text = "We use the `TODO:` marker convention across projects.";
    expect(findDirectiveSnippets(text)).toEqual([]);
  });

  test("mid-sentence TODO: does NOT match (not at line start)", () => {
    const text = "I want to add TODO: review this later, but haven't yet.";
    expect(findDirectiveSnippets(text)).toEqual([]);
  });

  test("link-title containing Claude: does NOT match", () => {
    const text = "See [Claude: the official docs](https://example.com) for details.";
    expect(findDirectiveSnippets(text)).toEqual([]);
  });
});

describe("findDirectiveSnippets — real-world plan-page soup", () => {
  test("full weekly-plan-page text with lots of Claude mentions returns NO directives", () => {
    const text = `
# Week of Apr 20-26 — planning

**From: Conductor** — mapping Goals 1-6.

## Goal 1: Launch bike map

### Bryan × Claude Design — redesign direction (in progress)
- Produce design artifacts (layouts, flows, component specs)
- Output is what the Family Bike Map agent implements
**Collaborates with:** Family Bike Map agent (handoff)

## Goal 3: Job Search

Try Claude Design (Anthropic, launched Apr 17) — NL → prototypes.
Newly landed in Claude Code v2.1.111.

---

*Bryan: edit anything above, add **\`TODO:\`** or **\`Claude:\`** markers where you want the conductor to act, or leave comments.*
`;
    expect(findDirectiveSnippets(text)).toEqual([]);
  });

  test("page WITH a real directive buried in plan-page soup returns only that directive", () => {
    const text = `
# Week of Apr 20-26 — planning

**From: Conductor** — mapping Goals 1-6.

## Goal 1: Launch bike map
### Bryan × Claude Design — redesign direction
- Produce design artifacts

TODO: flip rare-disease repo to public at share-time (Bryan to greenlight Wed)

Try Claude Design (Anthropic, launched Apr 17).

*Bryan: edit anything above, add **\`TODO:\`** or **\`Claude:\`** markers...*
`;
    const snippets = findDirectiveSnippets(text);
    expect(snippets.length).toBe(1);
    expect(snippets[0]).toContain("TODO:");
    expect(snippets[0]).toContain("rare-disease");
  });
});
