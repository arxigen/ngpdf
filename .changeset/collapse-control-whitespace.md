---
'@ngpdf/core': patch
---

Form feed (`\f`), vertical tab (`\v`), U+2028 (line separator) and U+0085 (next line) in text now
collapse with the white space around them into one space, as in CSS. They used to be drawn as `?`.
