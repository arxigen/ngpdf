---
'@ngpdf/core': patch
---

A percent-encoded data URL is decoded straight into a `Uint8Array` instead of through a
`number[]`, which uses less memory and is a little faster for large images. The bytes are unchanged.
