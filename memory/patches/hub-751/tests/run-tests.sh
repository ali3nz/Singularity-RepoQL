#!/bin/sh
# Runs inside a throwaway container from the pinned base image. Read-only mounts:
#   /patch (patched bundle), /tests (suite), /dumps (archived failure dumps).
set -e
cd /app/knowledge
rm -rf dist-test dist-base
cp -r dist dist-test
cp /patch/ingest-v2-CSw_7GGw.mjs dist-test/ingest-v2-CSw_7GGw.mjs
cp -r dist dist-base
sed -i 's/export { commitCandidates, extractSource, scanExistingPages };/export { commitCandidates, extractSource, parseFileBlocks, scanExistingPages };/' dist-base/ingest-v2-CSw_7GGw.mjs
echo "baseline-export-lines: $(grep -c 'parseFileBlocks, scanExistingPages' dist-base/ingest-v2-CSw_7GGw.mjs)"
echo "patched-sha256: $(sha256sum dist-test/ingest-v2-CSw_7GGw.mjs | cut -c1-64)"
node --test /tests/parse.test.mjs
