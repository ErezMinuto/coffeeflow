// deno run -A supabase/functions/update-product-description/whole_test.ts
import { wholeDescription } from "./whole.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}
const ID = "11111111-1111-4111-8111-111111111111";
const proposal = { status: "proposed", target_type: "product_description", target_id: 65189, after: "<p>new text</p>" };
const lookup = (row: unknown) => async () => row as never;

check("approved proposal with the same text → whole text", JSON.stringify(await wholeDescription("<p>new text</p>", { change_id: ID }, 65189, lookup(proposal))) === JSON.stringify({ text: "<p>new text</p>" }));
check("text differs from the proposal → refused", "error" in await wholeDescription("<p>other</p>", { change_id: ID }, 65189, lookup(proposal)));
check("proposal for another product → refused", "error" in await wholeDescription("<p>new text</p>", { change_id: ID }, 1, lookup(proposal)));
check("proposal already applied → refused", "error" in await wholeDescription("<p>new text</p>", { change_id: ID }, 65189, lookup({ ...proposal, status: "applied" })));
check("proposal of another type → refused", "error" in await wholeDescription("<p>new text</p>", { change_id: ID }, 65189, lookup({ ...proposal, target_type: "product_faq" })));
check("unknown proposal → refused", "error" in await wholeDescription("<p>new text</p>", { change_id: ID }, 65189, lookup(null)));
check("undo → whole text, no lookup", JSON.stringify(await wholeDescription("<p>old</p>", { undo_of: ID }, 65189, async () => { throw new Error("no lookup on undo"); })) === JSON.stringify({ text: "<p>old</p>" }));
check("no change context → find/replace expected", JSON.stringify(await wholeDescription("<p>x</p>", {}, 65189, lookup(proposal))) === JSON.stringify({ text: null }));
check("no description → find/replace expected", JSON.stringify(await wholeDescription(undefined, { change_id: ID }, 65189, lookup(proposal))) === JSON.stringify({ text: null }));

check("undo and approval together → refused", "error" in await wholeDescription("<p>new text</p>", { undo_of: ID, change_id: ID }, 65189, lookup(proposal)));
check("target id returned as text still matches", JSON.stringify(await wholeDescription("<p>new text</p>", { change_id: ID }, 65189, lookup({ ...proposal, target_id: "65189" }))) === JSON.stringify({ text: "<p>new text</p>" }));

check("change queued for the weekly release → whole text", JSON.stringify(await wholeDescription("<p>new text</p>", { change_id: ID }, 65189, lookup({ ...proposal, status: "queued" }))) === JSON.stringify({ text: "<p>new text</p>" }));

if (failures) { console.error(`\n${failures} FAILED`); Deno.exit(1); }
console.log("\nall passed");
