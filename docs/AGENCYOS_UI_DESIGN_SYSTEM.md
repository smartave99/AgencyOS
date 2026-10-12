# AgencyOS — Interface Standard

The bar: the calm, restrained polish of an Apple product for the person using it, and the
precision, keyboard reach and safety of a Microsoft enterprise tool for the person running a
business on it. This document describes the system as built (`apps/frontend/src/components/agency/agency.ui.tsx`,
`agency.icons.tsx`, `command-palette.component.tsx`, tokens in `apps/frontend/src/app/colors.scss`,
interaction rules in `global.scss`). It also records what was checked and what was not.

## Principles

1. **One thing to do per screen.** The obvious next step is the one filled button. Everything
   else sits in an overflow menu or a quiet secondary button. (Campaign detail: *Submit for
   review*, *Review now*, *Schedule*, *Resume* or *Retry failed posts* depending on state and
   role; *Send now*, *Pause*, *Reopen*, *Duplicate*, *Download*, *Archive*, *Cancel* are in the menu.)
2. **Say where you are and what happens next.** Campaigns show a six-step progress line and a
   plain sentence ("Queued. Each destination receives it at the scheduled time.").
3. **Whitespace is structure.** Generous padding, hairline borders instead of heavy boxes,
   sentence-case labels, 13 px body text, 28 px large titles.
4. **Never lie in the interface.** No button that does nothing, no invented numbers, no
   "healthy" without a check. A missing bot or dispatcher is shown as a banner. Empty values
   show "—", not a made-up default.
5. **Safe by construction.** Every destructive or hard-to-reverse action asks first and says
   what will happen; sending something back or marking a deal lost requires a reason.
6. **Show only what the person can do.** Actions appear when the signed-in role holds the
   permission; the server still enforces it.

## Tokens

All colours are CSS variables set per theme (`.dark` / `.light` on `body`, the app's existing
mechanism) so contrast holds in both. There is a single accent (violet, from the host app's
palette).

| Group | Variables | Notes |
| --- | --- | --- |
| Accent | `--ag-accent`, `-hover`, `-fg`, `-text`, `-soft` | Primary buttons, links, focus ring, selected states |
| Status tones | `--ag-{good,info,warn,bad,neutral}-{fg,bg,line}` | Light: dark text on pale tint; dark: bright text on translucent tint |
| Surfaces | `--ag-surface`, `--ag-surface-raised`, `--ag-hairline`, `--ag-shadow`, `--ag-shadow-pop`, `--ag-scrim` | Cards use a hairline and a very soft shadow in light mode |

Host-app tokens (`newBgColor`, `newBgColorInner`, `newTextColor`, `textItemBlur`) are reused
for backgrounds and text so the agency screens sit naturally inside the Postiz shell.
Status colour is never the only signal: every badge carries its label.

## Type and spacing

| Role | Spec |
| --- | --- |
| Page title | 28 px, semibold, −0.02 em tracking |
| Section title | 15 px semibold |
| Body | 13 px; secondary text uses `textItemBlur` |
| Captions and field labels | 12 px, medium, sentence case |
| Numbers | tabular figures in tables and stat cards |
| Radii | controls 10 px, cards 16 px, dialogs 16 px (bottom sheet on phones) |
| Spacing | 4/8 px scale; page padding 16 → 32 px; 24–32 px between sections |

## Components (`agency.ui.tsx`)

`StatusBadge`, `Btn` / `LinkBtn` (primary, secondary, danger, ghost; busy state), `TextField`,
`TextArea`, `SelectField`, `CheckField` (label, hint, inline error, `aria-invalid`,
`aria-describedby`), `useTouched` (errors appear after a field is touched or a submit fails),
`Dialog` (focus trap, Escape, focus returns to the trigger, scroll lock, bottom sheet on
phones, cannot be dismissed while saving), `Segmented` (tabs with arrow keys), `Menu`
(overflow actions with arrow keys and Escape), `Stepper`, `Card`, `Stat`, `Notice`,
`EmptyState`, `Skeleton` / `Loading`, `LoadError` with retry, table styles, date/money
helpers, and a single stroke icon set (`agency.icons.tsx`) matching the app's navigation icons.
`CommandPalette` (Ctrl/⌘ + K) jumps to any page or campaign the role may see.

Existing platform components are reused: the confirmation dialog (`deleteDialog`), toasts
(`useToaster`), the media library, `useFetch`/SWR. Dialogs sit below the app's modal layer so a
confirmation opened from a dialog appears above it.

## Behaviour

* **Motion:** 140–280 ms fades, rises and pops; skeleton shimmer; all disabled under
  `prefers-reduced-motion`.
* **Focus:** the app removes outlines globally, so keyboard focus is drawn as a two-ring
  box-shadow on every interactive element inside agency screens.
* **Forms:** inline validation on blur and on submit; nothing is silently dropped; a save that
  half-succeeds says exactly which part.
* **Loading / empty / error:** skeletons, empty states that say what to do, errors with
  "Try again".
* **Responsive:** layouts collapse to one column; tables scroll inside their card; dialogs
  become bottom sheets; the page itself never scrolls sideways.
* **Print:** the reports screen prints only the report, in light colours, with a title block.

## Client portal

Deliberately quieter and larger than the staff screens: the client's name as the title, a
"Needs your approval" section showing the exact ad as it will appear in Telegram with
**Approve this ad** and **Request changes**, three honest numbers, and the list of their
campaigns (unfinished drafts are never shown).

## What was verified

A scripted run in a real Chromium against a seeded demo agency (real backend, real PostgreSQL):
31 checks covering inline validation, the composer and live preview, the command palette,
dialog focus and Escape, a confirmation stacked above a dialog, approvals gated on client
sign-off, the client approval path, no horizontal scroll at 390 px on nine screens, and no
unexpected console errors. Screens were reviewed visually in dark and light mode, and a PDF of
the report was generated and read back.

## What was not verified

* Screen readers and other assistive technology. Semantics (roles, labels, `aria-*`, focus
  management, keyboard paths) were built in and spot-checked, not audited.
* Browsers other than Chromium, and real touch devices.
* The drag-and-drop pipeline on touch screens (a "Move to" menu is the alternative).
* Colour-contrast measurement with a tool; the tones were chosen for contrast but not
  machine-checked.
