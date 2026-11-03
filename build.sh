#!/bin/sh
# POSIX counterpart to build.bat — for macOS and Linux. Builds whatever this
# OS's electron-builder targets are (see app/electron-builder.yml's mac:/
# linux: sections): `npm run dist` picks the current OS's targets
# automatically, there's no cross-compiling a mac/Linux build from Windows
# or vice versa.
set -e

script_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$script_dir/app" || {
  echo "Error: cannot find the \"app\" folder next to this script."
  exit 1
}

echo "Installing dependencies..."
npm install

echo
echo "Building project..."
npm run dist

echo
echo "Build complete! Output is in ../dist/"
