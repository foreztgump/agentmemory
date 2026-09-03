ARG III_VERSION=0.11.2

FROM iiidev/iii:${III_VERSION} AS iii-image

FROM node:22-slim

ARG AGENTMEMORY_VERSION=0.9.29
ARG III_VERSION=0.11.2
ARG III_SDK_VERSION=0.11.2
ARG VOYAGE_EMBEDDING_MODEL=voyage-code-4

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini gosu curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=iii-image /app/iii /usr/local/bin/iii

WORKDIR /opt/agentmemory
RUN printf '{"name":"agentmemory-deploy","version":"1.0.0","private":true,"overrides":{"iii-sdk":"%s"}}\n' "${III_SDK_VERSION}" > package.json \
 && npm install "@agentmemory/agentmemory@${AGENTMEMORY_VERSION}" --omit=optional --no-fund --no-audit \
 && ln -s /opt/agentmemory/node_modules/.bin/agentmemory /usr/local/bin/agentmemory

# The published bundle hardcodes the legacy `voyage-code-3` and, unlike the
# OpenAI provider, exposes no *_EMBEDDING_MODEL override — so the model can
# only be changed by rewriting the literal in the installed bundle.
#
# This is safe only because both models emit 1024 dimensions. The provider
# declares `dimensions = 1024` and withDimensionGuard() throws on a mismatch,
# so swapping to a differently-sized model here would fail closed rather than
# silently poison the index. Both names are also the same byte length, which
# keeps the bundled sourcemap offsets intact.
#
# The grep gate makes an upstream rename fail the build instead of quietly
# leaving the deployment on the old model.
RUN set -eu; \
    dist=/opt/agentmemory/node_modules/@agentmemory/agentmemory/dist; \
    patched=0; \
    for f in "$dist"/*.mjs; do \
      if grep -q 'voyage-code-3' "$f"; then \
        sed -i "s/voyage-code-3/${VOYAGE_EMBEDDING_MODEL}/g" "$f"; \
        patched=$((patched + 1)); \
      fi; \
    done; \
    if [ "$patched" -eq 0 ]; then \
      echo "FATAL: 'voyage-code-3' literal absent from $dist/*.mjs. The bundle changed upstream; re-verify the embedding model before deploying." >&2; \
      exit 1; \
    fi; \
    echo "patched embedding model -> ${VOYAGE_EMBEDDING_MODEL} in $patched bundle(s)"

ENV AGENTMEMORY_III_VERSION=${III_VERSION} \
    TINI_SUBREAPER=1

COPY --chmod=0755 entrypoint.sh /usr/local/bin/agentmemory-entrypoint.sh

EXPOSE 3111

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3111/agentmemory/livez || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agentmemory-entrypoint.sh"]
