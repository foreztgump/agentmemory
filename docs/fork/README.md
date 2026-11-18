# agentmemory disk fork

This is `foreztgump/agentmemory`, a fork of `rohitg00/agentmemory`. It keeps records, the knowledge graph, the keyword index and vectors on disk instead of in RAM, so the self-hosted stacks stop running out of memory. Every upstream feature stays.

The fork opens no pull requests against upstream. It follows upstream by rebasing.

## Branches

| Branch | Purpose |
|---|---|
| `disk` | The fork's mainline. It starts from an upstream release tag and carries the fork's commits on top. CI runs the upstream test suite on every push and pull request to it. |
| one deploy branch per stack | Coolify builds from these. They are updated from a fork release tag, never edited by hand. |

## Release tags

A fork release is a git tag `vX.Y.Z-am.N` on `disk`:

- `X.Y.Z` is the upstream release tag that `disk` is based on.
- `N` is the fork's release counter for that base. It starts at 1 and resets to 1 after each rebase onto a new upstream tag.

Example: the first fork release on upstream `v0.9.33` is `v0.9.33-am.1`, the next is `v0.9.33-am.2`, and the first release after rebasing onto `v0.9.34` is `v0.9.34-am.1`.

The fork never changes the version in `package.json`. The running server reports upstream's version, and the tag says which fork release it is.

The npm and Docker Hub publish workflows only run in `rohitg00/agentmemory`, so a release on the fork publishes nothing.

## Required settings

Upstream sends nothing to an LLM unless `AGENTMEMORY_LLM_PROVIDER` names a provider and that provider's key is set. A provider key alone is not enough. Without it, session summaries, consolidation and LLM compression do nothing, and the log says the server runs zero-LLM.

The stacks use an Anthropic-compatible endpoint for the LLM and Voyage for embeddings:

| Setting | Value |
|---|---|
| `AGENTMEMORY_LLM_PROVIDER` | `anthropic` |
| `ANTHROPIC_API_KEY` | the endpoint's key |
| `ANTHROPIC_BASE_URL` | the endpoint's URL |
| `ANTHROPIC_MODEL` | the model to use, for example `claude-haiku-5-5` |
| `EMBEDDING_PROVIDER` | `voyage` |
| `VOYAGE_API_KEY` | the Voyage key |
| `VOYAGE_MODEL` | `voyage-code-4` |
| `VOYAGE_OUTPUT_DIMENSION` | `1024` |

`VOYAGE_MODEL` defaults to upstream's `voyage-code-3`. `VOYAGE_OUTPUT_DIMENSION` accepts 256, 512, 1024 or 2048. When it is set, the server sends it to Voyage as `output_dimension` and expects vectors of that size. When it is unset, the server sends no dimension and expects 1024. Any other value stops the server at startup.

Changing the model or the dimension does not re-embed stored vectors. Vectors from different models are not comparable, even at the same size.

`test/fork-deploy-config.test.ts` checks these settings. It fails if a rebase changes how they select the LLM or the embedding model.

## Rebasing

See [rebase-runbook.md](rebase-runbook.md).
