---
'@ngpdf/core': patch
---

Style keywords are matched case-insensitively and trimmed, as in CSS. `text-align: CENTER` no longer
throws, and `font-weight: BOLD` and `font-style: ITALIC` are no longer dropped silently. This covers
`text-align`, `text-decoration`, `flex-direction`, `justify-content`, `align-items`, `align-self`,
`object-fit`, `font-weight`, `font-style` and `break-before`. An unknown keyword still throws.
