---
'@ngpdf/core': patch
---

A `pdf-image` with element children now rejects the render with
`ngpdf: pdf-image cannot have children (found <pdf-text>)`, naming the first child, before any
image is fetched. It used to fail deep inside Yoga with an unclear error.
