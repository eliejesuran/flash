# Flash — Light Show Synchronisé
**v2026-07-16c** · Elie JESURAN · GPL

## Concept
Un téléphone **maître** joue un fichier audio et diffuse une intensité lumineuse en temps réel à N téléphones **clients**, qui rejoignent la session en scannant un QR code. Chaque client fait varier son écran (et sa torche si dispo) en synchro avec la musique.

## Architecture
`index.html` monofichier (HTML/CSS/JS, pas de build) · rôle maître/client déterminé à l'écran d'accueil
Serveur : `server/server.js` · Node 20+ · `ws` · relais temps réel pur, pas de persistance d'état (contrairement à `../setlist`)
Front : GitHub Pages (statique) · Serveur : Render gratuit + UptimeRobot `/healthz` 5min (identique à `../setlist`)
Dev local : `.claude/launch.json` → `flash-server` (node, port 3001) + `flash-front` (python http.server, port 5500)

## Contrainte technique majeure — torche caméra
- **iOS (Safari + tout navigateur iOS)** : aucune API web pour piloter la torche. Ce n'est PAS une question de permission — WebKit n'expose jamais `MediaTrackConstraints.torch`. Tous les navigateurs iOS (Chrome/Firefox/Edge inclus) tournent sur WebKit, donc aucun n'y a accès. (Exception théorique : moteurs alternatifs autorisés par le DMA UE depuis iOS 17.4 — aucun n'implémente torch à ce jour, à ignorer.)
- **Android Chrome/Chromium** : torche pilotable via `track.applyConstraints({advanced:[{torch:true}]})`, mais **on/off uniquement** — pas de niveau natif.
- **Conséquence design** : le flash écran (plein écran, luminosité/couleur CSS) est le mécanisme **principal** — fonctionne partout, vraie intensité continue, et supporte la couleur (voir § Couleur). La torche est un **bonus** activé si `track.getCapabilities().torch` existe, intensité simulée par cycle on/off (voir § Torche) — toujours en niveaux de gris, une torche physique ne peut pas être teintée. Fallback auto vers écran si torche absente.
- Activer la torche exige un flux caméra actif (`getUserMedia`) même sans afficher la vidéo → prompt permission caméra côté client pour cette feature spécifiquement.

## Le "freeze" — diagnostic et fix
Symptôme rapporté : la session se fige parfois. Cause la plus probable en usage réel mobile (deux mécanismes cumulés, non reproductibles à l'identique en sandbox mais fixés par construction) :
1. **Écran qui se verrouille** → `requestAnimationFrame` (boucle d'analyse audio du maître) et les timers sont suspendus par l'OS → plus aucun `cue` émis → tous les clients restent figés sur la dernière couleur. Fix : **Screen Wake Lock** (`navigator.wakeLock`) demandé sur maître et client tant que la session est active, redemandé sur `visibilitychange` (le lock est auto-relâché quand l'onglet passe en arrière-plan).
2. **Coupure réseau sans close propre** (bascule wifi/4G) → côté serveur, `session.master` pointait vers une connexion morte indéfiniment → un maître qui se reconnecte se fait rejeter `MASTER_TAKEN` → plus jamais de `cue`. Fix : **heartbeat serveur** (`ws.ping()` toutes les 30s, `ws.terminate()` si pas de pong reçu — pattern standard de la lib `ws`) qui force le `close` et libère `session.master`/`session.clients` proprement.

En complément, côté client : reconnexion auto avec backoff exponentiel (1s→8s, 8 tentatives max) sur toute coupure non intentionnelle, et le `#flash-zone` est explicitement remis à noir (+ torche coupée) à la déconnexion au lieu de rester figé sur la dernière valeur — même si la reconnexion échouait, l'écran ne mentirait plus sur l'état de la connexion.

## Protocole WS
URL : `/session/{id}` · id `[a-zA-Z0-9-]{4,20}` (même regex que setlist)

| Direction | Type | Contenu |
|---|---|---|
| c→s | `identify` | `{role:'master'\|'client'}` |
| s→c | `joined` | `{sessionId, role, peers, hasMaster}` |
| s→c | `master_status` | `{hasMaster}` — broadcast connexion/déconnexion maître |
| s→c | `peers_update` | `{peers}` — compteur seul, pas de noms (inutile ici contrairement à setlist) |
| m→s→c | `cue` | `{intensity:0..1, ts}` — throttle serveur ~40Hz max (`CUE_MIN_INTERVAL_MS`) |
| m→s→c | `track_control` | `{action:'play'\|'pause'\|'seek', position, ts}` |
| m→s→c | `color` | `{color:'#rrggbb'}` — teinte du flash écran ; envoyé seulement au changement (pas à chaque cue) |
| c↔s | `ping/pong` | heartbeat applicatif (client ping toutes les 20s) — distinct du heartbeat protocole WS serveur→clients (30s, détection de connexions mortes) |
| s→c | `error` | `{code, message}` — `MASTER_TAKEN` · `SESSION_FULL` · `MSG_TOO_LARGE` · `BAD_JSON` · `UNKNOWN_TYPE` |

Un seul maître par session : `identify role=master` rejeté (`MASTER_TAKEN`) si un maître est déjà connecté et vivant (voir § Freeze pour le heartbeat qui garantit que "vivant" reste correct). **Reconnexion** : à la déconnexion du maître (propre ou détectée par heartbeat), `session.master` repasse à `null` immédiatement (broadcast `master_status`). Pendant un reconnect auto, un `MASTER_TAKEN` transitoire (heartbeat pas encore passé) déclenche un nouveau essai côté client plutôt qu'une éjection. Pas de `session.state` persisté : un client qui rejoint en cours reçoit simplement le prochain `cue`. Sécurité serveur : origin allowlist + rate limit/IP (10/min) + cap taille message 4 Ko.

## Rejoindre une session
Deux façons, en plus de la saisie manuelle (5 caractères sans I/O/0/1 ambigus) :
- **QR affiché par le maître** (`qrcode@1.5.3`, CDN jsdelivr) encodant `${location.origin}${location.pathname}?join={code}` → scan via **appareil photo natif**. Dégradation gracieuse déjà en place : si le CDN est bloqué/hors-ligne, `renderQr()` masque le canvas et affiche `#qr-hint` ("QR indisponible — utilise le code") au lieu de laisser un vide muet — `wsConnect()` n'est jamais bloqué par cet échec (bug réel trouvé et corrigé — voir historique).
- **Scanner in-app** (bouton "📷 Scanner" sur l'accueil) : `BarcodeDetector` natif uniquement (Chrome/Edge/Android + Safari 17+), **pas de lib CDN** — on a déjà eu un bug à cause d'un CDN bloqué pour l'encodeur QR, inutile de dupliquer ce risque de fragilité côté scan. Bouton caché si `'BarcodeDetector' in window` est faux (Firefox notamment) ; code manuel ou scan natif restent disponibles. Décode soit l'URL `?join=`, soit un code brut. Overlay plein écran avec flux vidéo + cadre viewfinder CSS, polling `detect()` toutes les 250ms, caméra coupée proprement à la fermeture.

## Écrans
- **Maître** : sélection fichier audio (`<input type=file>` → `Audio` + `MediaElementAudioSourceNode` + `AnalyserNode` fftSize 256) · lecture/pause · QR + code · sélecteur couleur (`<input type=color>`, natif, pas de lib) · statut connexion · compteur peers · niveau audio en direct (moyenne des ~12% premiers bins = basses, lissage EMA α=0.35)
- **Client** : saisie/scan code → `#flash-zone` plein écran (fond noir→couleur choisie selon `cue.intensity`, blanc par défaut) + badges statut/peers/torche en overlay

## Couleur
Le maître choisit une couleur (défaut blanc = comportement d'origine). Le serveur relaie `color` tel quel (validation regex hex côté serveur). Le client stocke `currentColor {r,g,b}` et calcule `rgb(r×v, g×v, b×v)` à chaque `cue` d'intensité `v` — un fondu du noir vers la couleur pleine, jamais de vrai blanc/couleur pure sauf à `v=1`. Un changement de couleur ré-applique immédiatement la dernière intensité connue, pas besoin d'attendre le prochain `cue`. La torche reste indépendante de la couleur (physiquement impossible à teinter) — seule son intensité (cycle on/off) suit `latestIntensity`.

## Torche — implémentation
`setupTorch()` : `getUserMedia({video:{facingMode:'environment', width/height ideal:64}})` (résolution minimale, le flux n'est jamais affiché) → `track.getCapabilities().torch` détermine le mode. Si dispo : `torchLoop()` auto-entretenue (boucle `setTimeout` qui relit `latestIntensity` à chaque tick de fenêtre 200ms) — **découplée du débit réseau des cues**, pour un vrai cycle on/off stable plutôt qu'un toggle au rythme des messages entrants (~30Hz, trop instable pour le hardware).

## Hébergement
Front : GitHub Pages — https://eliejesuran.github.io/flash/ (actif, déploie auto depuis `main`, pas d'Action nécessaire)
Serveur : Render — https://flash-a9yt.onrender.com (root dir `server/`, build `npm install`, start `npm start`, plan Free)
**TODO** : UptimeRobot ping `/healthz` toutes les 5min pour éviter la mise en veille du plan Free (pas encore configuré).

### Tester en local sans Render
`WS_SERVER` détecte `localhost`/`127.0.0.1` **et les IP réseau local** (`192.168.*`, `10.*`, `172.16-31.*`) et pointe alors vers `ws://<même hôte>:3001` — ça permet de tester depuis un vrai téléphone sur le même wifi que la machine qui fait tourner `server.js`, sans rien déployer. Le serveur autorise ces origines (`LOCAL_NETWORK_ORIGIN` dans `server.js`). **Piège** : ouvrir `index.html` en double-clic (`file://`) ne matche aucun de ces cas (`location.hostname` est vide) → `WS_SERVER_CONFIGURED` est `false`, message clair affiché au lieu de tenter une connexion vouée à l'échec. Il faut servir le dossier via un vrai serveur HTTP (`python3 -m http.server 5500` par ex.) en plus de `node server/server.js`.

## Backlog
**Livré (v1)** : join + cue broadcast naïf · flash écran · torche Android best-effort avec repli écran · fichier audio local + Web Audio API (bandes basses → intensité) · dégradation gracieuse QR
**Livré (v1.1)** : heartbeat serveur (zombies) + reconnexion client avec backoff + reset visuel sur coupure · Screen Wake Lock · couleur du flash écran · scanner QR in-app (BarcodeDetector)
**v2+** : compensation d'offset horloge pour un vrai calcul de latence (le `ping/pong` applicatif existe déjà, l'offset n'est pas encore calculé/appliqué) · interpolation client entre deux `cue` (actuellement saut direct) · presets couleur / palette · PWA/manifest (comme setlist) · multi-peers stress test (>20) · token de session pour fiabiliser la reprise de rôle maître (au lieu de compter sur le seul heartbeat)

---
*Màj 16 juillet 2026 (c) — serveur Render en prod*
