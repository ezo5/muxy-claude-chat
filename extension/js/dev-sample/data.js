// Sample conversations, written by hand. Nothing here comes from Claude, and every name is invented.
CC.devSample = CC.devSample || {};

CC.devSample.SERVER = "dev-box";

CC.devSample.chats = function () {
  return [
    {
      id: "upload", title: "Retry failed uploads in the sync client", project: "orbit", state: "need",
      ask: "Allow Bash: npm run test:sync", branch: "retry-uploads", path: "~/projects/orbit", ctx: [12, 120], changes: [48, 6, 2],
      model: "Opus 5.5", effort: "High", mode: "Ask",
      blocks: [
        { k: "prompt", text: "Uploads that fail on a dropped connection never retry. Add retries with backoff.", time: "4 min ago" },
        { k: "text", html: "<p>Failed uploads end in <code>markFailed</code> without a retry path. I added a capped exponential backoff around the send call.</p>" },
        { k: "work", summary: "Read 3 files, edited 2 files", add: 48, del: 6, rows: [
          { label: "Read", name: "uploader.ts", path: "src/sync/uploader.ts", from: 41, code: ["async function send(item: Item) {", "  const res = await post(item);", "  if (!res.ok) markFailed(item);", "}"] },
          { label: "Traced where failed items are picked up again" },
          { label: "Edited", name: "uploader.ts", add: 42, del: 6, path: "src/sync/uploader.ts", diff: [[" ", 41, "async function send(item: Item) {"], ["-", 42, "  const res = await post(item);"], ["-", 43, "  if (!res.ok) markFailed(item);"], ["+", 42, "  const res = await withBackoff(() => post(item), { tries: 5 });"], ["+", 43, "  if (!res.ok) markFailed(item, res.status);"], [" ", 44, "}"]] },
        ] },
        { k: "permission", id: "p1", q: "Run the sync tests?", command: "npm run test:sync", options: [
          { key: "allow", title: "Yes" },
          { key: "always", title: "Yes, and don't ask again for npm run test", sub: "Saved in this project's settings" },
          { key: "deny", title: "No, and tell Claude what to do instead" },
        ] },
      ],
      resume: { live: "Running the sync tests", result: "<p>All 37 sync tests pass, including the new retry cases.</p>" },
    },
    {
      id: "palette", title: "Choose the default chart palette", project: "dashboard", state: "need",
      ask: "Which palette should be the default?", branch: "chart-palette", path: "~/projects/dashboard", ctx: [31, 200], changes: [0, 0, 0],
      model: "Sonnet 5.5", effort: "Medium", mode: "Plan",
      blocks: [
        { k: "prompt", text: "Charts are hard to read in dark mode. Fix the colours.", time: "8 min ago" },
        { k: "work", summary: "Read 6 files, searched the code twice", rows: [
          { label: "Found every place that sets a series colour" },
          { label: "Read", name: "palette.ts", path: "src/charts/palette.ts", from: 3, code: ["export const series = [\"#3366cc\", \"#dc3912\", \"#ff9900\"];"] },
        ] },
        { k: "text", html: "<p>The series colours are hard-coded and fail contrast on the dark background. There are two sensible ways to fix it.</p>" },
        { k: "question", id: "q1", q: "Which palette should be the default?", options: [
          { key: "a", title: "Adaptive", sub: "Separate tuned colours for light and dark" },
          { key: "b", title: "One shared palette", sub: "Simpler, slightly weaker contrast in both themes" },
        ] },
      ],
      resume: { live: "Rewriting the palette", result: "<p>Done. The charts now use separate tuned colours for light and dark.</p>" },
    },
    {
      id: "keys", title: "Keyboard navigation in the file tree", project: "orbit", state: "busy", now: "Editing tree.ts",
      branch: "tree-keys", path: "~/projects/orbit", ctx: [58, 200], changes: [112, 14, 3], model: "Opus 5.5", effort: "High", mode: "Accept edits",
      blocks: [
        { k: "prompt", text: "Add arrow key navigation to the file tree, with expand and collapse on left and right.", time: "1 min ago" },
        { k: "text", html: "<p>I'll keep the focus state in the tree model, so the renderer stays stateless.</p>" },
        { k: "work", summary: "Read 4 files, ran a command", rows: [
          { label: "Read", name: "tree.ts", path: "src/ui/tree.ts", from: 12, code: ["export class Tree {", "  private expanded = new Set<string>();", "}"] },
          { label: "Checked which tests cover the tree" },
        ] },
        { k: "tasks", items: [["done", "Add focus state to the tree model"], ["run", "Handle arrow keys"], ["todo", "Scroll the focused row into view"], ["todo", "Add tests"]] },
        { k: "live", text: "Editing tree.ts", secs: 34 },
      ],
    },
    {
      id: "grid", title: "Fix pagination in the orders grid", project: "shop", state: "idle", unread: true,
      branch: "orders-pagination", path: "~/projects/shop", ctx: [84, 1000], changes: [31, 11, 3], model: "Opus 5.5", effort: "High", mode: "Accept edits",
      blocks: [
        { k: "prompt", text: "Page 2 of the orders grid repeats rows from page 1 when sorted by date. Find out why and fix it.", time: "14 min ago" },
        { k: "text", html: "<p>The query sorts only by <code>created_at</code>. Orders imported in one batch share that timestamp, so the database may return them in a different order for each page.</p>" },
        { k: "work", summary: "Ran 4 commands, read 3 files, 1 failed", rows: [
          { label: "Reproduced the repeated rows with a query against the sample data" },
          { label: "Read", name: "OrderQuery.java", path: "src/main/java/shop/orders/OrderQuery.java", from: 58, code: ["public Page<Order> find(Filter filter, Pageable page) {", "    return repository.findAll(", "        filter.toSpec(),", "        PageRequest.of(page.getPageNumber(), page.getPageSize(),", "            Sort.by(Sort.Direction.DESC, \"createdAt\")));", "}"] },
          { label: "Ran the grid tests before the change", failed: true, path: "./gradlew test --tests OrderQueryTest", from: 1, code: ["OrderQueryTest > secondPageHasNoRepeats FAILED", "    expected: 25 distinct rows", "     but was: 22 distinct rows"] },
          { label: "Checked other queries for the same sort" },
        ] },
        { k: "text", html: "<p>The fix adds <code>id</code> as a tie-breaker, so the order is the same on every page. Two other grids had the same problem, so I changed them too.</p>" },
        { k: "files", title: "Edited 3 files", add: 31, del: 11, rows: [["OrderQuery.java", 9, 3], ["InvoiceQuery.java", 4, 2], ["OrderQueryTest.java", 18, 6]] },
        { k: "text", html: "<p>All 212 tests pass. Nothing changes for grids sorted by a unique column.</p>" },
        { k: "end", text: "2 min 41 s, 13.3k tokens" },
      ],
      diff: [
        { name: "OrderQuery.java", dir: "src/main/java/shop/orders", add: 9, del: 3, lines: [[" ", 61, "        PageRequest.of(page.getPageNumber(), page.getPageSize(),"], ["-", 62, "            Sort.by(Sort.Direction.DESC, \"createdAt\")));"], ["+", 62, "            Sort.by(Sort.Direction.DESC, \"createdAt\")"], ["+", 63, "                .and(Sort.by(Sort.Direction.DESC, \"id\"))));"], [" ", 64, "}"]] },
        { name: "InvoiceQuery.java", dir: "src/main/java/shop/invoices", add: 4, del: 2, lines: [["-", 40, "    Sort sort = Sort.by(\"issuedAt\");"], ["+", 40, "    Sort sort = Sort.by(\"issuedAt\").and(Sort.by(\"id\"));"]] },
        { name: "OrderQueryTest.java", dir: "src/test/java/shop/orders", add: 18, del: 6, lines: [["+", 88, "@Test"], ["+", 89, "void secondPageHasNoRepeats() {"], ["+", 90, "    assertThat(idsOfPages(1, 2)).doesNotHaveDuplicates();"], ["+", 91, "}"]] },
      ],
    },
    {
      id: "pg", title: "Upgrade to PostgreSQL 16", project: "shop", state: "idle",
      branch: "master", path: "~/projects/shop", ctx: [20, 200], changes: [0, 0, 0], model: "Sonnet 5.5", effort: "Medium", mode: "Ask",
      blocks: [
        { k: "prompt", text: "What breaks if we move to PostgreSQL 16?", time: "2 hours ago" },
        { k: "work", summary: "Read 8 files, searched the web", rows: [{ label: "Compared the release notes with the extensions we use" }] },
        { k: "text", html: "<p>Nothing in the application code. The one thing to plan for is the <code>pg_trgm</code> indexes, which should be rebuilt after the upgrade.</p>" },
        { k: "end", text: "48 s, 6.1k tokens" },
      ],
    },
    {
      id: "login", title: "Flaky login test on CI", project: "dashboard", state: "stopped",
      branch: "master", path: "~/projects/dashboard", ctx: [9, 200], changes: [0, 0, 0], model: "Sonnet 5.5", effort: "Medium", mode: "Ask",
      blocks: [
        { k: "prompt", text: "The login test fails about once a week on CI. Any idea why?", time: "Yesterday" },
        { k: "text", html: "<p>It waits a fixed 200 ms for the redirect. On a busy runner that isn't always enough, so it should wait for the URL to change instead.</p>" },
        { k: "end", text: "22 s, 2.4k tokens" },
      ],
    },
  ];
};
