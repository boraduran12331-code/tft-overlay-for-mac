<div align="center">
  <h1>Antigravity TFT Companion</h1>
  <p>A native macOS overlay and intelligence tool for Teamfight Tactics.</p>
</div>

---

## 🚀 Overview

**Antigravity TFT Companion** is a sleek, native macOS overlay application built to enhance your Teamfight Tactics (TFT) gameplay. By securely tapping into Riot's Live Client Data API and parsing real-time game states, the companion provides live scouting, tier lists, and actionable in-game insights—all without disrupting your game.

> Built natively via Electron + Vite (React) for high performance with minimal battery drain.

## ✨ Features

- **Live Match Scouting:** Automatically tracks your lobby participants and displays positioning history.
- **Top Meta Comps:** A live-updated grid of S-tier and A-tier compositions (via MetaTFT scraping) directly overlaid on your game.
- **Item Builder & Recipes:** Quickly reference component combos and best-in-slot (BIS) item maps for the current meta.
- **Smart Game Detection:** Seamlessly attaches to the League Client Update (LCU) to figure out when you're in a match.
- **Native Mac Window Management:** Floating panels designed to respect Mac windowing rules and provide transparent overlays without stealing mouse focus.

> **Note on Current Limitations**  
> ⚠️ **Top Notification Bar:** The dynamic top-center notification bar (designed for instant predictive alerts and quick tooltips) is currently in active development and **does not fully function** as intended at this time. We are working on stabilizing its IPC messaging logic.

## 🛠️ Built With

- **Vite & React (v19):** Ultra-fast frontend rendering
- **Electron:** Native system integration & window overlay manipulation
- **Zustand:** Lightweight and robust state management
- **LCU-Connector:** Secure discovery of the League Client websocket port

## 💻 Getting Started

### Prerequisites

You need `Node.js` (v18+) and `npm` installed.

### Installation

```bash
# Clone the repository
$ git clone https://github.com/your-username/tft-overlay-for-mac.git
$ cd tft-overlay-for-mac

# Install dependencies
$ npm install

# Start the development server (Vite + Electron)
$ npm run dev
```

### Production Build

To build a polished `.app` and `.dmg` file for macOS:

```bash
$ npm run build
```

This will run TypeScript checks, Vite's build process, and `electron-builder` to bundle the app securely into the `dist-electron` and `dist` directories.

## 🔒 Security & Compliance

This tool operates completely **outside the memory space of the game client**. It strictly interacts with standard, developer-sanctioned APIs, reading from the community-standard `127.0.0.1:2999/liveclientdata/allgamedata` endpoint. It does not modify game files, does not hook into Vanguard, and does not violate Riot's Terms of Service for third-party tools.

## 📄 License

This project is licensed under the MIT License - see the `package.json` for details.
