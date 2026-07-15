# Flash — Light Show Synchronisé
**v2026-07-15b** · Elie JESURAN · GPL

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
- **Conséquence design** : le flash écran (plein écran, luminosité/couleur CSS) est le mécanisme **principal** — fonctionne partout, vraie intensité continue. La torche est un **bonus** activé si `track.getCapabilities().torch` existe, intensité simulée par cycle on/off (voir § Torche). Fallback auto vers écran si torche absente.
- Activer la torche exige un flux caméra actif (`getUserMedia`) même sans afficher la vidéo → prompt permission caméra côté client pour cette feature spécifiquement.

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
| c↔s | `ping/pong` | heartbeat (client ping toutes les 20s) |
| s→c | `error` | `{code, message}` — `MASTER_TAKEN` · `SESSION_FULL` · `MSG_TOO_LARGE` · `BAD_JSON` · `UNKNOWN_TYPE` |

Un seul maître par session : `identify role=master` rejeté (`MASTER_TAKEN`) si un maître est déjà connecté. **Reconnexion** : à la déconnexion du maître, `session.master` repasse à `null` immédiatement (broadcast `master_status`) — un refresh de page libère donc le rôle. Pas de `session.state` persisté : un client qui rejoint en cours reçoit simplement le prochain `cue`. Sécurité serveur : origin allowlist + rate limit/IP (10/min) + cap taille message 4 Ko (`../setlist` utilise 128 Ko car ses patchs sont plus gros — ici les messages sont de petits JSON fixes).

## Rejoindre une session
QR encode `${location.origin}${location.pathname}?join={code}` via `qrcode@1.5.3` (CDN jsdelivr) → scan via **appareil photo natif**. **Dégradation gracieuse** : si le CDN est bloqué/hors-ligne, `renderQr()` détecte `QRCode === undefined` et masque le canvas — le code texte reste affiché et la connexion WS n'est jamais bloquée par cet échec (bug réel trouvé en testant : l'exception non catchée de `QRCode.toCanvas` empêchait `wsConnect()` de s'exécuter — `renderQr()` doit rester isolé de `wsConnect()`). Fallback : saisie manuelle du code, 5 caractères sans I/O/0/1 ambigus.

## Écrans
- **Maître** : sélection fichier audio (`<input type=file>` → `Audio` + `MediaElementAudioSourceNode` + `AnalyserNode` fftSize 256) · lecture/pause · QR + code · compteur peers · niveau audio en direct (moyenne des ~12% premiers bins = basses, lissage EMA α=0.35)
- **Client** : saisie/scan code → `#flash-zone` plein écran (fond noir→blanc selon `cue.intensity`) + badges statut/peers/torche en overlay

## Torche — implémentation
`setupTorch()` : `getUserMedia({video:{facingMode:'environment', width/height ideal:64}})` (résolution minimale, le flux n'est jamais affiché) → `track.getCapabilities().torch` détermine le mode. Si dispo : `torchLoop()` auto-entretenue (boucle `setTimeout` qui relit `latestIntensity` à chaque tick de fenêtre 200ms) — **découplée du débit réseau des cues**, pour un vrai cycle on/off stable plutôt qu'un toggle au rythme des messages entrants (~30Hz, trop instable pour le hardware).

## Hébergement
Front : GitHub Pages, aucune Action nécessaire (statique, pas de build)
Serveur : Render (root dir `server/`, build `npm install`, start `npm start`) + UptimeRobot ping `/healthz` toutes les 5min (anti-sleep free tier)
**TODO avant déploiement** : remplacer `WS_SERVER` (`index.html:126`) par l'URL Render réelle une fois le service créé.

## Backlog
**Livré (v1)** : join + cue broadcast naïf (pas de compensation de latence) · flash écran · torche Android best-effort avec repli écran · fichier audio local + Web Audio API (bandes basses → intensité) · dégradation gracieuse QR · testé en local (2 clients simulés, protocole WS validé de bout en bout)
**v2+** : compensation d'offset horloge (le `ping/pong` existe déjà, l'offset n'est pas encore calculé/appliqué) · presets couleur · PWA/manifest (comme setlist) · multi-peers stress test (>20) · interpolation client entre deux `cue` (actuellement saut direct, pas de lissage visuel)

---
*Màj 15 juillet 2026*
