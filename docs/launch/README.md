# Launch drafts

Drafts for announcing 2.0.0. Nothing here has been posted. Each number in them comes from
[../benchmarks.md](../benchmarks.md) or [../../examples/README.md](../../examples/README.md);
re-check them against those pages before posting, in case a later change moved them.

- [show-hn.md](show-hn.md) — Show HN title and first comment
- [devto.md](devto.md) — a longer article
- [x-thread.md](x-thread.md) — a thread of six posts

## Before posting

1. Release 2.0.0 to npm, so `npx naso-dev@latest` gives what the posts describe.
2. Check that the README demo (`docs/demo/setup.svg`) renders on the GitHub page.
3. Set the repository's topics to match package.json's keywords:

   ```bash
   gh repo edit MrVal042/naso-dev \
     --add-topic agents-md --add-topic ai-agents --add-topic claude-code \
     --add-topic cursor --add-topic copilot --add-topic context-engineering \
     --add-topic handoff --add-topic token-efficiency --add-topic pre-commit \
     --add-topic developer-tools
   ```

4. Label the issues from [../good-first-issues.md](../good-first-issues.md) `good first issue`
   once they are opened, so people arriving from a post have somewhere to start.
