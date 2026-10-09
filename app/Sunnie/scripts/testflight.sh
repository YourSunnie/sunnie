#!/usr/bin/env bash
# Archive the App Store build of the hosted app and upload it to TestFlight.
#
#   scripts/testflight.sh [build-number]
#
# Signing comes from Signing.local.xcconfig (team) and either Xcode's signed-in Apple account
# or an App Store Connect API key (SUNNIE_ASC_KEY_ID and SUNNIE_ASC_ISSUER_ID in
# scripts/testflight.local.env, the .p8 in ~/.appstoreconnect/private_keys/): with
# -allowProvisioningUpdates that registers the App IDs and makes the distribution profiles.
# The App Store Connect record for the bundle ID has to exist before the upload.
# The build number defaults to the number of commits, which only ever grows.
set -Eeuo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

# Your own values live in scripts/testflight.local.env (gitignored): SUNNIE_STORE_BUNDLE_ID,
# SUNNIE_STORE_CONNECT_HOST (the public host where a code is claimed at /c/<code>).
[[ -f scripts/testflight.local.env ]] && { set -a; source scripts/testflight.local.env; set +a; }
AUTH=()
if [[ -n ${SUNNIE_ASC_KEY_ID:-} && -n ${SUNNIE_ASC_ISSUER_ID:-} ]]; then
  AUTH=(-authenticationKeyPath "$HOME/.appstoreconnect/private_keys/AuthKey_${SUNNIE_ASC_KEY_ID}.p8"
        -authenticationKeyID "$SUNNIE_ASC_KEY_ID" -authenticationKeyIssuerID "$SUNNIE_ASC_ISSUER_ID")
fi
BUNDLE_ID="${SUNNIE_STORE_BUNDLE_ID:-com.example.app}"
CONNECT_HOST="${SUNNIE_STORE_CONNECT_HOST:-panel.example.com}"
BUILD="${1:-$(git rev-list --count HEAD)}"
OUT="${SUNNIE_STORE_OUT:-build/testflight}"
mkdir -p "$OUT"

echo "Archiving $BUNDLE_ID build $BUILD (connect host $CONNECT_HOST)..."
xcodebuild archive \
  -scheme Sunnie -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$OUT/Sunnie.xcarchive" -allowProvisioningUpdates "${AUTH[@]}" \
  SUNNIE_FLAVOR=hosted SUNNIE_CONNECT_HOST="$CONNECT_HOST" SUNNIE_BUNDLE_ID="$BUNDLE_ID" \
  CURRENT_PROJECT_VERSION="$BUILD" \
  | grep -E "error:|warning: .*(signing|provisioning)|ARCHIVE (SUCCEEDED|FAILED)" || true
[[ -d "$OUT/Sunnie.xcarchive" ]] || { echo "No archive was produced." >&2; exit 1; }

# With profiles named in the local env (made once in the developer portal, installed in
# ~/Library/Developer/Xcode/UserData/Provisioning Profiles) the export signs by hand: an API key
# without cloud-signing access cannot make distribution profiles on the fly.
OPTIONS=scripts/ExportOptions.plist
if [[ -n ${SUNNIE_STORE_PROFILE:-} && -n ${SUNNIE_STORE_SHARE_PROFILE:-} && -n ${SUNNIE_STORE_TEAM:-} ]]; then
  OPTIONS="$OUT/ExportOptions.manual.plist"
  cat > "$OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>method</key><string>app-store-connect</string>
	<key>destination</key><string>upload</string>
	<key>signingStyle</key><string>manual</string>
	<key>signingCertificate</key><string>Apple Distribution</string>
	<key>teamID</key><string>$SUNNIE_STORE_TEAM</string>
	<key>provisioningProfiles</key><dict>
		<key>$BUNDLE_ID</key><string>$SUNNIE_STORE_PROFILE</string>
		<key>$BUNDLE_ID.Share</key><string>$SUNNIE_STORE_SHARE_PROFILE</string>
	</dict>
	<key>uploadSymbols</key><true/>
	<key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST
fi

echo "Uploading to App Store Connect..."
xcodebuild -exportArchive \
  -archivePath "$OUT/Sunnie.xcarchive" -exportOptionsPlist "$OPTIONS" \
  -exportPath "$OUT/export" -allowProvisioningUpdates "${AUTH[@]}" \
  | grep -E "error:|Upload succeeded|EXPORT (SUCCEEDED|FAILED)" || true
