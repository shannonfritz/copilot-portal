#!/bin/sh
cd "$(dirname "$0")"

echo "Checking for Node.js..."
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Attempting to install..."
    if command -v brew >/dev/null 2>&1; then
        brew install node
    elif command -v apt-get >/dev/null 2>&1; then
        sudo apt-get install -y nodejs npm
    elif command -v winget >/dev/null 2>&1; then
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    else
        echo "Could not install Node.js automatically."
        echo "Please install it from https://nodejs.org and re-run this script."
        exit 1
    fi
fi

echo "Installing dependencies..."
npm install || { echo "npm install failed. See errors above."; exit 1; }

echo "Applying compatibility patch..."
node patch.mjs || { echo "Patch failed. See errors above."; exit 1; }

echo ""
echo "Setup complete! Starting Copilot Portal..."
node dist/server.js --launch
