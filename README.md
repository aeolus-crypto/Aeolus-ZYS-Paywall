# ZYS Paywall — Setup Guide

Sell any digital file for **ZYS (Zephyr Yield Stable)** with no middlemen. Payments are confirmed on-chain. Buyers get a one-time download link automatically.

![Linux](https://img.shields.io/badge/Linux-FCC624?style=flat&logo=linux&logoColor=black)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)
![ZYS](https://img.shields.io/badge/ZYS-Payments-orange?style=flat)

---

## Part 1 — Download Zephyr CLI

Go to:

```
https://github.com/ZephyrProtocol/zephyr/releases/tag/v2.3.0
```

Download `zephyr-cli-linux-v2.3.0.zip`, extract it, and move the folder to your Desktop.

Open a terminal and navigate into it:

```bash
cd ~/Desktop/zephyr-cli-linux-v2.3.0
```

Start syncing the blockchain:

```bash
./zephyrd --detach
```

Check sync progress:

```bash
./zephyrd status
```

> ⚠️ **Do not move on until it shows 100%.** This can take several hours depending on your internet speed.

---

## Part 2 — Create Your Wallet

Once fully synced, create your wallet. Replace `MyWallet` with any name you want — you'll need it in the next step.

```bash
./zephyr-wallet-cli --generate-new-wallet MyWallet
```

When prompted:

- Enter and confirm a strong password
- Pick your language
- **Write down your 25-word seed phrase and store it safely offline** — this is the only way to recover your wallet if something goes wrong
- Press **No** when asked about mining
- Close the wallet

---

## Part 3 — Start the Wallet RPC

The paywall connects to your wallet through the RPC server. Keep this running whenever your store is live.

```bash
./zephyr-wallet-rpc --wallet-file MyWallet --password YOURPASSWORD --rpc-bind-port 17777 --disable-rpc-login --log-level 1
```

Test it's working (open a new terminal and run this):

```bash
curl -s http://127.0.0.1:17777/json_rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"0","method":"get_version"}'
```

You should get a JSON response back. If you do, the wallet RPC is ready.

---

## Part 4 — ZYS Paywall Setup

Install Node.js (only needed once):

```bash
sudo apt install nodejs npm
```

Copy your product file into the downloads folder:

```bash
cp /path/to/yourfile ~/Desktop/ZYS-Paywall/downloads/
```

Generate your JWT secret and copy the output:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Create the config file:

```bash
nano ~/Desktop/ZYS-Paywall/.env
```

Paste this and fill in your values:

```env
PRODUCT_NAME=Your Product Name
PRODUCT_DESC=A short description
PRODUCT_FILE=yourfile.zip
PRODUCT_PRICE_USD=10.00
WALLET_RPC_URL=http://127.0.0.1:17777/json_rpc
JWT_SECRET=paste_your_generated_secret_here
REQUIRED_CONFIRMATIONS=3
POLL_INTERVAL_MS=30000
PORT=3002
```

Save and exit: `Ctrl+O`, `Enter`, `Ctrl+X`

Install dependencies and start the server:

```bash
cd ~/Desktop/ZYS-Paywall
npm install
node server.js
```

You should see:

```
ZYS Paywall → http://localhost:3002
```

Open `http://localhost:3002` in your browser to confirm your store is live. Keep this terminal open and running.

---

## Part 5 — Cloudflare Tunnel (Public URL)

Download cloudflared once:

```bash
cd ~/Desktop
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared
```

Every time you want to go live, open a new terminal and run:

```bash
cd ~/Desktop
./cloudflared tunnel --url http://localhost:3002
```

You'll get a public URL like:

```
https://something.trycloudflare.com
```

Share that link with buyers. The URL changes each time you restart, so keep the tunnel running while your store is open.

> 💡 You can also use an actual custom domain with a named Cloudflare tunnel for a permanent URL.
