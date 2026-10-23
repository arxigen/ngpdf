---
'@ngpdf/core': patch
---

Border widths accept the CSS keywords `thin`, `medium` and `thick` (1, 3 and 5 points) in
`border`, `border-*`, `border-width` and `border-*-width`. They used to be read as colors and throw.
A negative border width now throws an `ngpdf:` error instead of being accepted.
