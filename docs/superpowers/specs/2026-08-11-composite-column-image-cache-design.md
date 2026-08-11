# Composite APR Column and Google Chat Image Cache Design

## Goal

Restore the ranking metric to the flat Funding table and ensure Google Chat card thumbnails always match the image opened from the card.

## Composite APR definition

- Add `Composite APR` immediately after `Asset`.
- Display the existing `CompositeFundingRow.compositeNextApr` value.
- Preserve the current calculation and ranking behavior: normalize each available venue's next Funding to APR, then take the equal-weight arithmetic mean across available venues.
- Do not introduce volume, open-interest, or configurable weights.
- The displayed Composite APR must therefore equal the value used to sort the Top20.

## Image layout

- Keep two images for ranks 1–10 and 11–20.
- Keep SVG width 800 and PNG width 1600 at 2× density.
- Render nine fixed columns in this order: `Asset`, `Composite APR`, `Binance`, `OKX`, `Hyper`, `Bybit`, `Bitget`, `7D / Day`, `7D APR`.
- Preserve the current two-line venue cells, missing-value dashes, signed colors, 7D equal-weight summaries, partial-history marker, and long-asset font scaling.
- Use compact column widths so the additional Composite column does not increase the image width.

## Google Chat cache handling

- Keep the existing GitHub object path for each scheduled slot and Top10 range.
- After uploading each PNG, append a deterministic content-version query parameter to its public raw URL: `?v=<content digest>`.
- Derive the version from the PNG bytes, so identical content keeps the same URL and changed content always gets a new URL.
- Google Chat therefore receives a new image URL after any forced regeneration, avoiding a stale cached thumbnail while preserving the existing repository structure.
- Do not add environment variables or expose the GitHub token.

## Verification

- Unit-test that Composite APR appears in every asset row and retains signed coloring.
- Preserve exact two-image output and 1600-pixel PNG width.
- Unit-test that published URLs contain deterministic, distinct versions for changed image bytes.
- Run typecheck, build, and the complete Node 24 test suite.
- Force-publish once, send to Google Chat, and visually confirm the card thumbnail and opened image show the same nine-column design.
