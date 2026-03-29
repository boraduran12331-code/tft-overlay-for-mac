import { app, BrowserWindow, clipboard, ipcMain, safeStorage, screen, shell } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import * as https from 'https'
import { RiotClientGateway } from './services/RiotClientGateway'
import { OverlayManager } from './services/OverlayManager'
import { registerMetaTFTScraperIPC } from './services/MetaTFTScraper'
import { WindowStateService } from './services/WindowStateService'
import { TFTGameEngine, TFTNotification } from './services/TFTGameEngine'

// ─── Globals ────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let notifWindow: BrowserWindow | null = null
const riotClient = new RiotClientGateway()
const gameEngine = new TFTGameEngine()
let overlayManager: OverlayManager | null = null
let windowStateService: WindowStateService | null = null

// ─── Riot API Key Storage ───────────────────────────────
const SETTINGS_FILE = join(app.getPath('userData'), 'settings.json')

interface Settings {
  riotApiKey?: string   // encrypted
  riotRegion?: string
  notifBounds?: { x: number; y: number; width: number; height: number }
}

function loadSettings(): Settings {
  try {
    if (existsSync(SETTINGS_FILE)) return JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'))
  } catch { /* ignore */ }
  return {}
}

function saveSettings(s: Settings) {
  try { writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)) } catch { }
}

let _settings: Settings = {}

function getRiotApiKey(): string {
  const enc = _settings.riotApiKey
  if (!enc) return ''
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(enc, 'base64'))
      : enc
  } catch { return '' }
}

function setRiotApiKey(key: string) {
  try {
    _settings.riotApiKey = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(key).toString('base64')
      : key
    saveSettings(_settings)
  } catch { }
}

// ── Region → Riot API host ──────────────────────────────
const REGION_HOST: Record<string, string> = {
  EUW: 'euw1.api.riotgames.com', NA: 'na1.api.riotgames.com',
  KR: 'kr.api.riotgames.com', EUNE: 'eun1.api.riotgames.com',
  BR: 'br1.api.riotgames.com', JP: 'jp1.api.riotgames.com',
  LAN: 'la1.api.riotgames.com', LAS: 'la2.api.riotgames.com',
  OCE: 'oc1.api.riotgames.com', TR: 'tr1.api.riotgames.com',
  RU: 'ru.api.riotgames.com',
}
const ROUTING: Record<string, string> = {
  EUW: 'europe', EUNE: 'europe', TR: 'europe', RU: 'europe',
  NA: 'americas', BR: 'americas', LAN: 'americas', LAS: 'americas',
  KR: 'asia', JP: 'asia',
  OCE: 'sea',
}

// ── Riot API helper ─────────────────────────────────────
function riotAPIGet<T>(host: string, path: string, apiKey: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: host, path, headers: { 'X-Riot-Token': apiKey }, rejectUnauthorized: false },
      res => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(4000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

// ── Fetch opponent's recent comp (last 5 TFT matches) ──
const opponentCompCache = new Map<string, { ts: number; traits: string[]; placement: number }>()

async function fetchOpponentComp(summonerName: string): Promise<{ traits: string[]; placement: number } | null> {
  const key = summonerName.toLowerCase()
  const cached = opponentCompCache.get(key)
  if (cached && Date.now() - cached.ts < 300_000) return cached // 5min cache

  const apiKey = getRiotApiKey()
  const region = _settings.riotRegion ?? 'EUW'
  const host = REGION_HOST[region] ?? REGION_HOST.EUW
  const routing = ROUTING[region] ?? 'europe'

  try {
    // 1. Get PUUID by summoner name
    const parts = summonerName.split('#')
    const gameName = encodeURIComponent(parts[0]?.trim() ?? summonerName)
    const tagLine  = encodeURIComponent(parts[1]?.trim() ?? region)
    const account = await riotAPIGet<any>(
      `${routing}.api.riotgames.com`,
      `/riot/account/v1/accounts/by-riot-id/${gameName}/${tagLine}`,
      apiKey
    )
    if (!account?.puuid) return null

    // 2. Get last 5 TFT match IDs
    const matchIds = await riotAPIGet<string[]>(
      `${routing}.api.riotgames.com`,
      `/tft/match/v1/matches/by-puuid/${account.puuid}/ids?count=5`,
      apiKey
    )
    if (!matchIds?.length) return null

    // 3. Get most recent match detail
    const match = await riotAPIGet<any>(
      `${routing}.api.riotgames.com`,
      `/tft/match/v1/matches/${matchIds[0]}`,
      apiKey
    )

    // Find this player in participants
    const participant = match?.info?.participants?.find(
      (p: any) => p.puuid === account.puuid
    )
    if (!participant) return null

    const traits: string[] = (participant.traits ?? [])
      .filter((t: any) => t.num_units >= t.min_units && t.tier_current > 0)
      .sort((a: any, b: any) => b.num_units - a.num_units)
      .slice(0, 3)
      .map((t: any) => t.name?.replace(/^Set\d+_/,'') ?? t.name)

    const placement: number = participant.placement ?? 0

    const result = { traits, placement, ts: Date.now() }
    opponentCompCache.set(key, result)
    return result
  } catch {
    return null
  }
}

// ─── Main Window (Control Panel) ────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 460, height: 720,
    minWidth: 400, minHeight: 560,
    title: 'Antigravity TFT Companion',
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#0d0f12',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  })
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })

    // In dev mode: when main window gets a full-page reload (Vite HMR),
    // also reload the overlay and notif windows so they pick up the latest bundle.
    mainWindow.webContents.on('did-finish-load', () => {
      try {
        if (overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.webContents.isDestroyed()) {
          overlayWindow.webContents.reload()
        }
        if (notifWindow && !notifWindow.isDestroyed() && !notifWindow.webContents.isDestroyed()) {
          notifWindow.webContents.reload()
        }
      } catch (e) {
        console.warn('[Main] HMR reload failed:', e)
      }
    })
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'))
  }
  mainWindow.on('closed', () => { mainWindow = null })
}

// ─── Overlay Window ──────────────────────────────────────
function createOverlayWindow() {
  if (!windowStateService) windowStateService = new WindowStateService()
  const bounds = windowStateService.getOverlayBounds()

  overlayWindow = new BrowserWindow({
    width: bounds.width, height: bounds.height,
    x: bounds.x, y: bounds.y,
    minWidth: 280, minHeight: 400, maxWidth: 560,
    frame: false, transparent: true, alwaysOnTop: true,
    hasShadow: false, skipTaskbar: true, hiddenInMissionControl: true,
    resizable: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  })

  overlayWindow.hide()
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1)
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })

  overlayWindow.on('moved', () => {
    if (overlayWindow && windowStateService) windowStateService.save(overlayWindow, 'overlay')
  })
  overlayWindow.on('resized', () => {
    if (overlayWindow && windowStateService) windowStateService.save(overlayWindow, 'overlay')
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    overlayWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/overlay`)
    overlayWindow.webContents.once('did-finish-load', () => {
      overlayWindow?.webContents.openDevTools({ mode: 'detach' })
    })
  } else {
    overlayWindow.loadFile(join(__dirname, '../dist/index.html'), { hash: '/overlay' })
  }

  overlayWindow.on('closed', () => { overlayWindow = null })
  overlayManager = new OverlayManager(overlayWindow, mainWindow)
  return overlayWindow
}

// ─── Notification Bar Window ─────────────────────────────
function createNotificationWindow() {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width } = primaryDisplay.workAreaSize

  // Restore saved notif position or default to top-center
  const saved = _settings.notifBounds
  const notifX = saved?.x ?? Math.round(width / 2) - 320
  const notifY = saved?.y ?? 0
  const notifW = saved?.width ?? 640
  const notifH = saved?.height ?? 500

  notifWindow = new BrowserWindow({
    width: notifW, height: notifH,
    x: notifX, y: notifY,
    minWidth: 320, minHeight: 60,
    maxWidth: 900,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    focusable: true,        // ← must be true to allow resize/drag
    resizable: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  })

  notifWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  notifWindow.setAlwaysOnTop(true, 'screen-saver', 2)
  notifWindow.setIgnoreMouseEvents(true, { forward: true })
  notifWindow.showInactive()

  // Persist position on move/resize
  notifWindow.on('moved', () => saveNotifBounds())
  notifWindow.on('resized', () => saveNotifBounds())

  if (process.env.VITE_DEV_SERVER_URL) {
    notifWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/notification`)
  } else {
    notifWindow.loadFile(join(__dirname, '../dist/index.html'), { hash: '/notification' })
  }

  notifWindow.on('closed', () => { notifWindow = null })
  return notifWindow
}

function saveNotifBounds() {
  if (!notifWindow) return
  _settings.notifBounds = notifWindow.getBounds()
  saveSettings(_settings)
}

function sendNotification(payload: TFTNotification | any) {
  if (!notifWindow || notifWindow.isDestroyed() || notifWindow.webContents.isDestroyed()) return
  try {
    notifWindow.setIgnoreMouseEvents(false)
    notifWindow.showInactive()
    notifWindow.webContents.send('notif:push', payload)
  } catch (e) {
    console.warn('[Main] sendNotification failed:', e)
  }
}

function broadcastState(channel: string, data: any) {
  [mainWindow, overlayWindow, notifWindow].forEach(win => {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      try {
        win.webContents.send(channel, data)
      } catch { /* Silent */ }
    }
  })
}

// ─── Enrich next-opponent notification with Riot API data ──
async function fireOpponentNotif(summonerName: string, round: string) {
  const baseNotif: any = {
    id: `opp-${round}-${summonerName}`,
    type: 'opponent', emoji: '⚔️',
    title: `Sonraki Rakip: ${summonerName}`,
    body: 'Yükleniyor...',
    ttl: 12000, priority: 'high',
  }
  sendNotification(baseNotif)

  // Enrich async — update body with real comp data
  const comp = await fetchOpponentComp(summonerName)
  if (comp && comp.traits.length > 0) {
    const avgPlacementLabel = comp.placement <= 4 ? '🟢 Tehlikeli' : '🟡 Orta'
    const enriched = {
      ...baseNotif,
      body: `${comp.traits.join(' · ')} — Son maç: ${comp.placement}. sıra ${avgPlacementLabel}`,
    }
    sendNotification(enriched) // re-push with enriched data (same id → dedup)
  }
}

// ─── IPC Handlers ───────────────────────────────────────
function setupIPC() {
  registerMetaTFTScraperIPC()

  ipcMain.handle('lcu:status', () => riotClient.getStatus())
  ipcMain.handle('livegame:status', () => gameEngine.getLiveState())

  // Overlay opacity
  ipcMain.handle('overlay:set-opacity', (_e, opacity: number) => {
    if (overlayWindow) overlayWindow.setOpacity(opacity)
  })

  // Clipboard
  ipcMain.handle('clipboard:write-text', (_e, text: string) => {
    clipboard.writeText(text); return true
  })

  // Overlay bounds
  ipcMain.handle('overlay:get-bounds', () => overlayWindow?.getBounds() ?? null)
  ipcMain.handle('overlay:save-bounds', (_e, bounds: any) => {
    if (!overlayWindow || !windowStateService) return
    if (bounds.width) overlayWindow.setSize(bounds.width, bounds.height)
    if (bounds.x !== undefined) overlayWindow.setPosition(bounds.x, bounds.y)
    windowStateService.save(overlayWindow, 'overlay')
  })

  // Compact mode
  ipcMain.handle('overlay:set-compact', (_e, compact: boolean) => {
    if (!overlayWindow) return
    const [w] = overlayWindow.getSize()
    overlayWindow.setSize(w, compact ? 400 : 640, true)
  })

  // NotifBar bounds
  ipcMain.handle('notif:get-bounds', () => notifWindow?.getBounds() ?? null)
  ipcMain.handle('notif:save-bounds', (_e, bounds: any) => {
    if (!notifWindow) return
    if (bounds.width) notifWindow.setSize(bounds.width, bounds.height)
    if (bounds.x !== undefined) notifWindow.setPosition(bounds.x, bounds.y)
    saveNotifBounds()
  })

  // NotifBar mouse passthrough control
  ipcMain.on('notif:empty', () => {
    notifWindow?.setIgnoreMouseEvents(true, { forward: true })
  })
  ipcMain.on('notif:active', () => {
    notifWindow?.setIgnoreMouseEvents(false)
  })

  // Push notification from renderer
  ipcMain.on('notif:push', (_e, payload) => sendNotification(payload))

  // Test notification
  ipcMain.on('notif:test', () => sendNotification({
    id: `test-${Date.now()}`, type: 'stage', emoji: '🎮',
    title: 'Antigravity Test',
    body: 'Bildirim sistemi çalışıyor!', ttl: 5000,
  }))

  // Generic API proxy
  ipcMain.handle('api:fetch', async (_e, url: string) => {
    return new Promise<string>((resolve, reject) => {
      https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          'Accept': 'application/json',
        }
      }, (res) => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => resolve(data))
        res.on('error', reject)
      }).on('error', reject)
    })
  })

  // Riot API key management
  ipcMain.handle('riot:get-key', () => getRiotApiKey())
  ipcMain.handle('riot:set-key', (_e, key: string) => {
    setRiotApiKey(key)
    gameEngine.setRiotApiKey(key, _settings.riotRegion ?? 'EUW')
  })
  ipcMain.handle('riot:get-region', () => _settings.riotRegion ?? 'EUW')
  ipcMain.handle('riot:set-region', (_e, region: string) => {
    _settings.riotRegion = region
    saveSettings(_settings)
    gameEngine.setRiotApiKey(getRiotApiKey(), region)
  })

  // Logs
  ipcMain.handle('logs:open', () => {
    const logPath = join(app.getPath('logs'), 'main.log')
    shell.showItemInFolder(logPath)
  })
}

// ─── App Lifecycle ──────────────────────────────────────
app.whenReady().then(async () => {
  _settings = loadSettings()
  _settings.riotRegion = _settings.riotRegion || 'TR'
  saveSettings(_settings)

  setupIPC()
  createMainWindow()
  createOverlayWindow()
  createNotificationWindow()

  riotClient.start()

  // ── LCU events → all windows ─────────────────────────
  riotClient.on('connected', (info) => {
    broadcastState('lcu:connected', info)
  })
  riotClient.on('disconnected', () => {
    broadcastState('lcu:disconnected', null)
    gameEngine.stop()
  })

  riotClient.on('gameflow-phase', (phase: string) => {
    mainWindow?.webContents.send('lcu:gameflow-phase', phase)
    overlayWindow?.webContents.send('lcu:gameflow-phase', phase)

    if (phase === 'InProgress') {
      const creds = riotClient.getCredentials()
      if (creds) gameEngine.setLCUCredentials(creds.port, creds.password)
      gameEngine.setRiotApiKey(getRiotApiKey(), _settings.riotRegion ?? 'EUW')
      gameEngine.start()
      overlayWindow?.show()
    } else if (phase === 'None') {
      gameEngine.stop()
    } else if (phase === 'ChampSelect') {
      overlayWindow?.show()
    }
  })

  riotClient.on('gameflow-session', (session: any) => {
    mainWindow?.webContents.send('lcu:gameflow-session', session)
    overlayWindow?.webContents.send('lcu:gameflow-session', session)

    try {
      const all: any[] = [
        ...(session?.gameData?.teamOne ?? []),
        ...(session?.gameData?.teamTwo ?? []),
      ]
      const names = all.map((p: any) => p.summonerName ?? p.gameName ?? '').filter(Boolean)
      if (names.length > 0) {
        mainWindow?.webContents.send('lcu:lobby-participants', names)
        overlayWindow?.webContents.send('lcu:lobby-participants', names)
      }
      // Register PUUIDs in engine so we can skip summonerV4 lookup mid-game
      const withPuuids = all
        .filter((p: any) => p.puuid && (p.summonerName || p.gameName))
        .map((p: any) => ({ summonerName: p.summonerName ?? p.gameName, puuid: p.puuid }))
      if (withPuuids.length > 0) {
        gameEngine.setLobbyParticipants(withPuuids)
      }
    } catch { }
  })

  riotClient.on('eog-stats', (stats: any) => {
    mainWindow?.webContents.send('lcu:eog-stats', stats)
    overlayWindow?.webContents.send('lcu:eog-stats', stats)
  })

  riotClient.on('summoner-info', (info: any) => {
    mainWindow?.webContents.send('lcu:summoner-info', info)
    overlayWindow?.webContents.send('lcu:summoner-info', info)
  })

  // ── TFTGameEngine events → windows + notifications ─────
  gameEngine.on('state', (state) => {
    mainWindow?.webContents.send('livegame:tft-state', state)
    overlayWindow?.webContents.send('livegame:tft-state', state)
    notifWindow?.webContents.send('livegame:tft-state', state)
  })

  gameEngine.on('notification', (notif: TFTNotification) => {
    sendNotification(notif)
  })


  gameEngine.on('stopped', () => {
    broadcastState('livegame:detached', null)
  })
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (overlayWindow && windowStateService) windowStateService.save(overlayWindow, 'overlay')
  saveNotifBounds()
  riotClient.stop()
  gameEngine.stop()
})
