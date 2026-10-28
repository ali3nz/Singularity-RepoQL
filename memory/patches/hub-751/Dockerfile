FROM agentmemory/memory-hub@sha256:53a3285b6444628384fc0b9a1b5da66558daddbed8aba880ee66d390764b7c6a
# Fail closed: the base bundle must be the reviewed baseline before the overlay replaces it.
RUN echo "c63a85473c2337ddc83699d82d268c71b0f73f3dc0a08afb18c257b7a6e7ff3a  /app/knowledge/dist/ingest-v2-CSw_7GGw.mjs" | sha256sum -c -
COPY patch/ingest-v2-CSw_7GGw.mjs /app/knowledge/dist/ingest-v2-CSw_7GGw.mjs
RUN echo "8ff062420227290a56c4251705ce4aed631a437874362272e9935369c7225c54  /app/knowledge/dist/ingest-v2-CSw_7GGw.mjs" | sha256sum -c -
RUN node --check /app/knowledge/dist/ingest-v2-CSw_7GGw.mjs && grep -q "PATCH-751" /app/knowledge/dist/ingest-v2-CSw_7GGw.mjs && grep -q "ingest-v2-CSw_7GGw.mjs" /app/knowledge/dist/server.mjs
