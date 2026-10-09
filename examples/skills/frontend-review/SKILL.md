---
name: frontend-review
description: Inspect a frontend codebase and report evidence-backed correctness issues without editing files.
allowed-tools:
  - read_file
  - list_directory
  - glob
  - grep
  - search_code
  - git_status
  - git_diff
  - git_log
  - git_branch
---

Start by reading package.json and the application entry points. Trace shared state,
async lifecycles and error handling before reporting findings. Cite file paths and
explain a concrete reproduction for each issue. Separate confirmed bugs from
conditional risks. Do not claim that tests ran unless a tool result proves it.
