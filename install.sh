#!/bin/sh
cd "$(dirname "$0")"

echo ""
echo "========================================"
echo "  Copilot Portal - Setup"
echo "========================================"
echo ""

# ---- Step 1: Node.js ----
echo "[1/3] Checking for Node.js..."
if ! command -v node >/dev/null 2>&1; then
    echo "      Node.js not found. Attempting to install..."
    if command -v brew >/dev/null 2>&1; then
        brew install node
    elif command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update && sudo apt-get install -y nodejs npm
    else
        echo ""
        echo " ERROR: Could not install Node.js automatically."
        echo " Please install Node.js v22+ from https://nodejs.org"
        echo " then re-run this script."
        exit 1
    fi
fi
echo "      Found Node.js $(node --version)"

# ---- Step 2: npm install + patch ----
echo ""
echo "[2/3] Installing dependencies..."
npm install --no-fund --no-audit || { echo " ERROR: npm install failed."; exit 1; }
echo "      Applying compatibility patch..."
node patch.mjs || { echo " ERROR: Patch failed."; exit 1; }

# ---- Step 3: GitHub authentication ----
echo ""
echo "[3/3] Checking GitHub authentication..."
# Auth state is stored in ~/.copilot/config.json (logged_in_users array).
if node -e "try{const c=JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(),'.copilot','config.json'),'utf8'));process.exit(c.logged_in_users&&c.logged_in_users.length?0:1)}catch{process.exit(1)}" 2>/dev/null; then
    echo "      Already authenticated."
else
    echo "      Not signed in. A browser window will open so you"
    echo "      can sign in with your GitHub account."
    echo ""
    node_modules/.bin/copilot login || { echo " ERROR: GitHub login failed."; exit 1; }
fi

echo ""
echo "========================================"
echo "  Setup complete!"
echo ""
echo "  To start the portal, run:"
echo "    sh start-and-launch.sh"
echo "========================================"
