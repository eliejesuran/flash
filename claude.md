# Flash — Light Show Synchronisé
**v2026-07-15a** · Elie JESURAN · GPL

## Concept
Un téléphone **maître** joue un fichier audio et diffuse une intensité lumineuse en temps réel à N téléphones **clients**, qui rejoignent la session en scannant un QR code. Chaque client fait varier son écran (et sa torche si dispo) en synchro avec la musique.

## Architecture
`index.html` monofichier (HTML/CSS/JS, pas de build) · rôle maître/client déterminé à l'écran d'accueil
Serveur : Node 20+ · `ws` · relais temps réel pur, pas de persistance d'état (contrairement à `../setlist`)
Front : GitHub Pages (statique) · Serveur : Render gratuit + UptimeRobot `/healthz` 5min (identique à `../setlist`)

## Contrainte technique majeure — torche caméra
- **iOS (Safari + tout navigateur iOS)** : aucune API web pour piloter la torche. Ce n'est PAS une question de permission — WebKit n'expose jamais `MediaTrackConstraints.torch`. Tous les navigateurs iOS (Chrome/Firefox/Edge inclus) tournent sur WebKit, donc aucun n'y a accès. (Exception théorique : moteurs alternatifs autorisés par le DMA UE depuis iOS 17.4 — aucun n'implémente torch à ce jour, à ignorer.)
- **Android Chrome/Chromium** : torche pilotable via `track.applyConstraints({advanced:[{torch:true}]})`, mais **on/off uniquement** — pas de niveau natif.
- **Conséquence design** : le flash écran (plein écran, luminosité/couleur CSS) est le mécanisme **principal** — fonctionne partout, vraie intensité continue. La torche est un **bonus** activé si `track.getCapabilities().torch` existe, intensité simulée par cycle on/off sur fenêtre ~150-250ms (pas de PWM fiable — latence matérielle + throttling OS). Fallback auto vers écran si torche absente.
- Activer la torche exige un flux caméra actif (`getUserMedia`) même sans afficher la vidéo → prompt permission caméra côté client pour cette feature spécifiquement.

## Protocole WS (prévu)
URL : `/session/{id}` · id `[a-zA-Z0-9-]{4,20}` (même regex que setlist)

| Direction | Type | Contenu |
|---|---|---|
| c→s | `identify` | `{role:'master'\|'client', name?}` |
| s→c | `joined` | `{sessionId, peers, hasMaster}` |
| s→c | `master_status` | `{hasMaster}` — broadcast connexion/déconnexion maître |
| m→s→c | `cue` | `{intensity:0..1, ts}` — ~20-30Hz, relais pur sans persistance |
| m→s→c | `track_control` | `{action:'play'\|'pause'\|'seek', position}` |
| s→c | `peer_joined\|peer_left\|peers_update` | `{names[], peers}` |
| c↔s | `ping/pong` | heartbeat + calcul offset horloge (RTT/2) |
| s→c | `error` | `{code, message}` |

Un seul maître par session (`identify role=master` rejeté si déjà pris — sauf reconnexion, détail à trancher en codant). Sécurité serveur : reprendre origin allowlist + rate limit/IP + cap taille message de `../setlist/server/server.js`. Pas de `session.state` persisté (flux live, pas de doc à synchroniser) — un client qui rejoint en cours reçoit simplement le prochain `cue`.

## Rejoindre une session
QR encode `https://<domaine-pages>/?join={id}` → scan via **appareil photo natif** (pas de scanner in-app, évite une lib de décodage QR). Fallback : saisie manuelle du code (même principe que `wsValidateCode` dans setlist).

## Écrans prévus
- **Maître** : sélection fichier audio, lecture/pause, QR + code, compteur peers, niveau audio en direct
- **Client** : saisie/scan code → attente maître → zone plein écran réactive à `cue` + torche si dispo

## Hébergement
Front : GitHub Pages, aucune Action nécessaire (statique, pas de build)
Serveur : Render (root dir `server/`, build `npm install`, start `npm start`) + UptimeRobot ping `/healthz` toutes les 5min (anti-sleep free tier)

## Backlog
**v1** : join + cue broadcast naïf (pas de compensation de latence) · flash écran · torche Android best-effort · fichier audio local + Web Audio API (bandes basses → intensité)
**v2+** : compensation d'offset horloge (ping/pong déjà prévu pour ça) · presets couleur · PWA/manifest (comme setlist) · multi-peers stress test (>20)

---
*Créé 15 juillet 2026*
