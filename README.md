# 🏎️ Web Racers

A browser-based 2D top-down racing game built with HTML5 Canvas and JavaScript. Features Firebase multiplayer, an open world with 9 connected regions, a Knockout Cup elimination mode, dynamic weather, and unique soundtracks for every map.

## 🎮 Game Modes

### Quick Race
Pick your car, set up to 17 racers with customizable difficulty, choose a track, and race. Supports local co-op.

### Knockout Cup
Fall Guys-style elimination tournament with 17 players across 4 rounds:
- **Round 1** — Top 10 advance (7 eliminated)
- **Round 2** — Top 7 advance (3 eliminated)
- **Round 3** — Top 3 advance (4 eliminated)
- **Final** — First to finish 3 laps wins the cup!

### Open World
Explore a seamlessly connected world map with 9 unique biome regions linked by 9 highways. Collect coins along roads and around region centers, discover tracks, and drive freely. Entering a new region fades the screen and displays a region banner.

## 🗺️ Regions

| Region | Position | Biome |
|--------|----------|-------|
| City | 0, 0 | Urban |
| Suburbs | −55000, 0 | Green |
| Desert | 65000, 0 | Desert |
| Coastal | 0, 65000 | Coastal |
| Mountain | 65000, 50000 | Mountain |
| Airport | 30000, −40000 | Desert |
| Beach | 30000, 105000 | Coastal |
| Forest | −55000, −55000 | Deep Forest |
| Industrial | 65000, 105000 | Industrial |

## 🏁 Maps

| Map | Biome | Difficulty |
|-----|-------|------------|
| Classic Oval | Grass | Easy |
| Figure-8 | Grass | Medium |
| City Circuit | Urban | Medium |
| Desert Speedway | Desert | Hard |
| Mountain Race | Mountain | Hard |
| Seaside Circuit | Coastal | Medium |
| Technical Track | Neon | Expert |
| Phoenix Sky Harbor | Desert | Expert |

Each map card in the browser shows **difficulty**, **length** (meters), **corner count**, and **biome** as colored stat chips.

## ✨ Features

- **Up to 17 racers** — 4 difficulty tiers: Rookie, Racer, Pro, and Rival
- **Dynamic weather** — Clear, Rain, and Storm modes with Web Audio rain/thunder SFX
- **Realistic physics** — Drift mechanics, barrier glide collisions, off-road slowdown, NOS boost
- **Visual effects** — Tire skid marks, drift smoke, car shadows, day/night cycle
- **Airport map** — Airplane flyover every lap with jet engine SFX and parked planes at gates
- **Full HUD** — Speedometer (bottom-right), minimap (top-right), live leaderboard, lap counter, best lap timer, NOS bar
- **Unique OST** — Every map has its own genre and BPM composed with Web Audio API oscillators
- **Firebase multiplayer** — Real-time online racing
- **Fall Guys-style loading screens** — Track preview + round objective before every race
- **World drone view** — Full atlas view of all 9 regions with biome halos, highway roads, and region name labels
- **Maps browser** — Each map card shows difficulty, length, corners, and biome stat chips
- **Seamless region transitions** — Fade overlay + "ENTERING AREA" banner when crossing region borders
- **Logical highway network** — 9 highway corridors connect all regions; roads rendered with shoulders, lane markings, and dashed center lines

## 🛠️ Tech Stack

- **HTML5 Canvas** — All rendering
- **JavaScript** — Game logic, physics, AI
- **Web Audio API** — All sound effects and music (no audio files needed)
- **Firebase** — Multiplayer and authentication
- **Tone.js** — Synthesized instrument audio

## 🚀 Installing as a Chrome Extension

1. **Download or clone this repo**
   ```bash
   git clone https://github.com/matthewro7263-hub/web-racers-chrome-extension.git
   ```

2. **Open Chrome Extensions**
   - Go to `chrome://extensions` in your browser
   - Or: Chrome menu → More Tools → Extensions

3. **Enable Developer Mode**
   - Toggle **Developer mode** on (top-right corner)

4. **Load the extension**
   - Click **Load unpacked**
   - Select the cloned `web-racers-chrome-extension` folder

5. **Launch the game**
   - Click the Web Racers icon in your Chrome toolbar
   - The game opens in a popup or new tab — ready to play!

> **Note:** No build step or server required. The extension runs entirely in the browser using HTML5 Canvas and the Web Audio API.

## 📄 License

CC BY-NC 4.0 (Non-Commercial) — see [LICENSE](LICENSE) for details.
