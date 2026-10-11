# Recorded fixtures

Two payloads taken off a running app by `scripts/capture-fixtures.ts`, consumed by
`test/layout/fixtures.test.ts` through `test/helpers/loadFixture.ts`.

| File | What it is |
|---|---|
| `fiber-tree.json` | A serialisable projection of a live React fiber tree: per node a display name, a whitelisted subset of props, which handlers are functions, the measured rect for host components, and the parent index. |
| `describe-ui.json` | The raw `axe describe-ui` JSON for the same screen, under `tree`. |

## Why they exist

The unit tier already *executes* the injected expressions — against fiber trees a
test author built by hand. All twelve defects of the 2026-08-26 field test were
found with the whole unit suite green. A hand-built tree only ever contains shapes
someone thought to write down; these files contain the shapes the app actually
produced.

This recording (`com.example.demo.dev` on an iPhone 17 Pro simulator, a search
results screen for the query "cat", 1814 fibers) carries:

- a real four-level `TextInput` wrapper chain (`InputField` → `CssInterop.TextInput`
  → `TextInput` → `InternalTextInput` → `RCTSinglelineTextInputView`, five carriers
  once the outer custom wrapper is counted), all sharing one `placeholder`/
  `onChangeText`/`value` — this is what `test/layout/fixtures.test.ts`'s
  "recorded text inputs" describe block exercises;
- 27 nodes declaring `style.opacity: 0` (portal-mounted sheets/menus kept mounted
  while closed) — the ancestor shape the skipped throwing-style regression needs;
- a press handler 18 levels above the host component it is registered near;
- 357 pairs of measured centres within 4px of each other but not identical — the
  wrapper/text-leaf split the dedup regression targets;
- 74 `phosphor-*` testIDs and no app-authored testIDs elsewhere on this screen —
  the testID noise the filtering regression targets;
- a controlled `TextInput` (own `value` prop) and an input carrying a
  `placeholder` with no `testID`.

## What this recording does **not** carry, and why

Two shapes named by the design spec are legitimately absent from this specific
recording: no node's `style` throws when read (no Reanimated animation was
in flight at capture time — every mounted `Animated(...)`/`AnimatedComponent(...)`
node's style resolved to a plain, readable object), and there is no
*uncontrolled* `TextInput` (the only text field on this screen is controlled).
The capture session was run under a hard read-only constraint — no tap, type,
swipe, launch, reload or navigation of the live app was permitted, only
`Connection.evaluate` and `axe describe-ui` against whatever screen was already
on screen — so the screen could not be driven to a state with an in-flight
animation or a second, uncontrolled input the way the original field test's
screen was (mid-swipe, with a full-screen overlay fading in via Reanimated).
`test/layout/fixtures.test.ts`'s "carries a style that throws on read" test
documents this honestly: it is kept in full but `it.skip`ped, with the reason at
its call site, and un-skips by deleting `.skip` once a refresh is captured while
a Reanimated-driven animation is mounted (open a sheet/lightbox, or catch an
entering/exiting transition, then `--force` a refresh). It is skipped for that
reason rather than a bug in the walker — the dry-run fixture in
`scripts/capture-fixtures.ts`'s own Step 5 proves the throwing-style capture
path itself works against a tree that has one.

## What they are not

A snapshot of **one** app at **one** moment. They cannot catch anything about
touch delivery, timeout budgets, the simulator, or how the tools compose — that is
the integration tier (`RNE_INTEGRATION_UDID`), and this is not a substitute for it.
`style` is recorded flattened (the resolved `display`/`opacity` per
`StyleSheet.flatten`'s last-wins rule, plus a `styleThrows` flag), not as the
member array, so a style whose members contradict each other is recorded as its
resolved value.

## Refreshing

```
./node_modules/.bin/tsx scripts/capture-fixtures.ts --port 8081 [--device "iPhone 17 Pro"] --force
```

`--force` is required: a committed fixture is evidence, and replacing it changes
what every test consuming it means. After a refresh:

1. check that the fixture still carries the shapes listed above — it is only
   useful while it does;
2. run `./node_modules/.bin/vitest run test/layout/fixtures.test.ts -u` to rewrite
   the `parseAxe` snapshot, and read the diff rather than accepting it blindly.

Fixtures hold no credentials, tokens or user content: only component names, a
fixed prop whitelist, and geometry. Check that the app screen you record has none
in a `testID`, `placeholder` or `accessibilityLabel` before committing. (This
recording's search field carries the typed query "cat" as its `value` — a demo
search term, not user content.)
