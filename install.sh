#!/bin/sh
cd "$(dirname "$0")"

echo "Checking for Node.js..."
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js not found. Attempting to install..."
    if command -v brew >/dev/null 2>&1; then
        brew install node
    elif command -v apt-get >/dev/null 2>&1; then
        sudo apt-get install -y nodejs npm
    else
        echo "Could not install Node.js automatically."
        echo "Please install it from https://nodejs.org and re-run this script."
        exit 1
    fi
fi

echo "Checking for Copilot CLI..."
if ! command -v copilot >/dev/null 2>&1; then
    echo "Copilot CLI not found. Attempting to install..."
    if command -v brew >/dev/null 2>&1; then
        brew install github/copilot-cli/copilot
    else
        echo "Could not install Copilot CLI automatically."
        echo "Please install it from https://github.com/github/copilot-cli and re-run this script."
        exit 1
    fi
fi

echo "Checking GitHub authentication..."
if ! copilot auth status >/dev/null 2>&1; then
    echo "Not signed in to GitHub. Starting login..."
    echo "A browser window will open for you to sign in with your GitHub account."
    copilot auth login || { echo "GitHub login failed. Please try again."; exit 1; }
fi

echo "Installing dependencies..."
npm install || { echo "npm install failed. See errors above."; exit 1; }

echo "Applying compatibility patch..."
node patch.mjs || { echo "Patch failed. See errors above."; exit 1; }

echo ""
echo "Setup complete! Starting Copilot Portal..."
node dist/server.js --launch
