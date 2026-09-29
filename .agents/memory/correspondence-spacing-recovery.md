---
name: Correspondence spacing recovery
description: Why historical email spacing needs provider retrieval rather than display-only changes
---

Recover historical Correspondence spacing from the provider on demand, rather than guessing paragraph boundaries or bulk reimporting mail.

**Why:** Earlier Missive imports permanently collapsed whitespace and discarded HTML. A display-only formatter cannot reconstruct those line breaks. Bulk recovery competes with sync on the shared paced provider queue.

**How to apply:** Recover only messages approaching the visible area, preserve thread authorization before provider or cache access, and leave saved text available when recovery fails. Keep recovered content text-only. Do not adopt Gmail's preview length cap for full Correspondence messages: formatting must not silently shorten previously complete bodies.