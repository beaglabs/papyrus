#!/usr/bin/env bash
#
# Build the zip that goes in the Partner Center plan's "Technical configuration" step.
#
# The solution template upload is a single zip containing `mainTemplate.json` and
# `createUiDefinition.json` at its root — not a folder, and nothing else. Both files are
# generated (the template is compiled from `main.bicep`, the UI definition is written by
# hand), and Partner Center gives no indication when the uploaded zip is older than the
# sources it was built from: it simply deploys the old template. So this script prints the
# digest of what it produced, and the zip is gitignored rather than committed, which
# removes the failure mode where a tracked artifact is uploaded months after it went stale.
#
# Run this immediately before uploading, after any change to main.bicep or
# createUiDefinition.json.
#
# Usage:
#   ./deploy/azure/package.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/papyrus-azure-application.zip"
TEMPLATE="$HERE/mainTemplate.json"
UI="$HERE/createUiDefinition.json"

for required in "$TEMPLATE" "$UI"; do
  if [ ! -f "$required" ]; then
    echo "package: missing $(basename "$required")" >&2
    if [ "$required" = "$TEMPLATE" ]; then
      echo "package: compile it first — az bicep build --file $HERE/main.bicep --outfile $TEMPLATE" >&2
    fi
    exit 1
  fi
done

# Both files must parse, or the upload fails in Partner Center with an error that does not
# say which of the two is malformed.
node -e '
  const fs = require("node:fs");
  for (const file of process.argv.slice(1)) {
    try {
      JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      console.error(`package: ${file} is not valid JSON — ${error.message}`);
      process.exit(1);
    }
  }
' "$TEMPLATE" "$UI"

# -X strips the extra fields (uid/gid/timestamps) so the same sources always produce the
# same bytes, and -j flattens to the archive root as Partner Center expects.
rm -f "$OUT"
( cd "$HERE" && zip -q -X -j "$OUT" "$(basename "$TEMPLATE")" "$(basename "$UI")" )

echo "package: wrote $OUT"
shasum -a 256 "$OUT" | awk '{ print "package: sha256 " $1 }'
unzip -l "$OUT" | sed 's/^/package:   /'

cat <<'NOTE'

package: upload this file at Partner Center -> your plan -> Technical configuration.
package: it must be rebuilt after any change to main.bicep or createUiDefinition.json.
NOTE
