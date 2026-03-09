#!/usr/bin/env bash
set -euo pipefail

BUMP=${1:?Usage: ./scripts/release.sh <patch|minor|major>}

# Pre-flight
npm run build
npm test
npm run typecheck

# Bump versions (keeps all packages in sync)
npm version "$BUMP" --workspace=packages/core --workspace=packages/vue --workspace=packages/react --no-git-tag-version

# Read the new version from core
VERSION=$(node -p "require('./packages/core/package.json').version")

# Publish in dependency order
npm publish --workspace=packages/core
npm publish --workspace=packages/vue
npm publish --workspace=packages/react

# Commit & tag
git add -A
git commit -m "release: v$VERSION"
git tag "v$VERSION"

echo "Published @sqstore/* v$VERSION"
echo "Run 'git push && git push --tags' to push the release."
