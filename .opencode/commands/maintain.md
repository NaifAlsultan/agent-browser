---
description: Maintain agent-browser, or check upstream browse for changes to take
---

Load the `maintain-agent-browser` skill and follow it for this task: $ARGUMENTS

If no task is given above, check whether upstream browse has a newer release than the one pinned in
`vendor/browse/README.md`. If it does, list the relevant changes and say for each whether to take it, adapt it or
skip it, and why, judged against the design goals. Don't change anything until I agree.
