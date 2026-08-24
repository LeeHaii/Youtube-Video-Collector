# Rhymx Media Studio UI Contract

## Product job

Rhymx is a desktop production utility for one operator moving from YouTube source discovery to timestamp collection, clip downloading, CapCut draft processing, and final rendering. The interface should make the current workspace, next action, and processing state obvious without adding decorative content.

## Hierarchy and workflow

- Keep collection tools and production tools grouped in a persistent workflow rail.
- Give each workspace one descriptive header, a configuration region, and an activity console where applicable.
- Keep the video collector spatially stable: source browser left, active row controls right, collected dataset below.
- Use one indigo accent for primary actions. Reserve green, amber, and red for success, warning, and destructive states.
- Use dense but readable spacing appropriate for a 1600 × 1200 desktop window. Avoid gradients, glass effects, oversized headings, floating cards, and decorative metrics.

## Components and states

- Use the shared rail item, field group, project list, primary/secondary/danger button, console, table, toast, and modal patterns from `src/ui-system.css`.
- Every icon is a consistent inline stroke SVG. Emoji are not interface controls.
- Empty marker, row, and project states explain the next action.
- Loading or running actions must disable the trigger until completion; errors belong in the related console or validation message.
- Focus indicators remain visible, tabs support arrow-key navigation, dialogs restore focus, and motion respects `prefers-reduced-motion`.

## Responsive contract

- Full rail at wide desktop sizes.
- Icon rail below 1250 px.
- Single-column configuration and console below 1050 px.
- Horizontal tool navigation and stacked collector below 820 px with no horizontal page scrolling.

## Acceptance criteria

- Existing element IDs and Electron handlers continue to work.
- No emoji-based controls remain in the HTML interface.
- All six workspaces have an explicit active navigation state and meaningful page description.
- Inputs have programmatic labels, icon-only buttons have accessible names, logs announce additions, and the settings modal supports Escape and focus restoration.
- Project tests pass and the rendered shell is inspected at desktop and compact sizes.
