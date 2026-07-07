#!/usr/bin/env bash
# ponytail: "resolvr" is squatted/unpublished on npm (permanent, npm policy) —
# publish under the scoped name and restore package.json after, so the repo's
# VS Code extension manifest (name must stay "resolvr", vsce rejects @ and /)
# is never touched.
set -euo pipefail
cd "$(dirname "$0")/.."

trap 'git checkout -- package.json' EXIT

node -e "
  const fs = require('fs');
  const pkg = require('./package.json');
  pkg.name = '@ugudlado1/resolvr';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

npm publish --access public
