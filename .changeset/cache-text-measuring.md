---
'@ngpdf/core': patch
---

Text is laid out faster: within one render, each text is prepared and broken into lines once per width, and each string is measured once per font and size, instead of on every layout pass. The PDF output is unchanged, and renders still share nothing.
