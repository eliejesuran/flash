# Flash — Light Show Synchronisé
**v2026-07-16i** · Elie JESURAN · GPL

Maître (téléphone) lit un fichier audio local → analyse 3 bandes de fréquence en temps réel → diffuse à N clients qui varient écran/torche en rythme. Join par QR, code, ou scan in-app (fonctionne sur iOS aussi, voir § Invariants). Thème clair/sombre selon l'appareil.

## Stack
| | |
|---|---|
| Front | `index.html` monofichier, aucune dépendance de build |
| Serveur | `server/server.js` · Node 20+ · lib `ws` · relais pur, pas de persistance d'état |
| Front prod | GitHub Pages — https://eliejesuran.github.io/flash/ (déploie auto depuis `main`) |
| Serveur prod | Render Free — https://flash-a9yt.onrender.com (root dir `server/`, build `npm install`, start `npm start`) |
| Dev local | `.claude/launch.json` : `flash-server` (:3001) + `flash-front` (:5500, `python3 -m http.server`) |
| Test réel sans Render | `WS_SERVER` reconnaît aussi les IP réseau local (`192.168.*`, `10.*`, `172.16-31.*`) → même hôte:3001. **`file://` (double-clic) ne marche pas** (hostname vide, ni local ni configuré — message clair affiché plutôt qu'une tentative vouée à l'échec) |
| Thème | Variables CSS dans `:root` (dark, défaut) + `@media (prefers-color-scheme: light)` (override) — pas de toggle manuel, suit l'appareil |
| TODO | UptimeRobot sur `/healthz` (5min) — pas configuré, Render s'endort après inactivité (cold start ~10-60s) |

## Protocole WS
`/session/{id}` · id `[a-zA-Z0-9-]{4,20}`

| Dir | Type | Payload |
|---|---|---|
| c→s | `identify` | `{role:'master'\|'client'}` |
| s→c | `joined` | `{sessionId,role,peers,hasMaster}` |
| s→c | `master_status` | `{hasMaster}` |
| s→c | `peers_update` | `{peers}` — compteur seul, pas de noms |
| m→c | `cue` | `{bass,mid,treble:0..1,ts}` — ~30Hz |
| m→c | `track_control` | `{action:'play'\|'pause'\|'seek',position,ts}` |
| m→c | `color` | `{color:'#rrggbb'}` — envoyé au changement seulement |
| c↔s | `ping/pong` | applicatif, 20s (distinct du heartbeat protocole WS serveur, 30s) |
| s→c | `error` | `{code,message}` — `MASTER_TAKEN`·`SESSION_FULL`·`MSG_TOO_LARGE`·`BAD_JSON`·`UNKNOWN_TYPE` |

Un seul maître/session (`ws === session.master`). Pas de `session.state` persisté — un join en cours de session reçoit juste le prochain `cue`. Origin allowlist + rate limit/IP + cap taille message côté serveur.

## Constantes qui comptent (ne pas re-tuner à l'aveugle)
| Constante | Valeur | Où |
|---|---|---|
| `fftSize` | 2048 | `setupAudio()` |
| `smoothingTimeConstant` | 0.2 | `setupAudio()` |
| Bandes | bass 20-250Hz · mid 250-4000Hz · treble 4000-12000Hz | `bandRanges`, calculé en Hz réels via `sampleRate` |
| Seuil beat | énergie > moyenne×1.5 ET >0.15 | `createBandEnvelope()` |
| Période réfractaire | 120ms | `MIN_BEAT_INTERVAL_MS` |
| Décroissance | ×0.88/tick | `createBandEnvelope()` |
| Plancher | `max(enveloppe, énergie×0.3)` | évite un rendu "mort" en passage soutenu/peu percussif |
| `HISTORY_SIZE` | 21 ticks (~0.7s à 33ms/tick — **pas** 60fps) | `createBandEnvelope()` |
| Cadence analyse | `setInterval(33ms)`, **pas** `requestAnimationFrame` | `analysisTick` |
| Throttle cue serveur | 25ms (~40Hz max) | `CUE_MIN_INTERVAL_MS` |
| Rate limit connexions | 60/min/IP | `RATE_LIMIT_MAX` — plusieurs téléphones = 1 IP (NAT wifi de salle), pas juste anti-abus |
| Heartbeat serveur | ping 30s, `terminate()` si pas de pong | `HEARTBEAT_INTERVAL_MS` |
| Reconnexion client | backoff 1s→8s, 8 tentatives max | `MAX_RECONNECT_ATTEMPTS` |
| Torche | fenêtre on/off 200ms, pilotée par `treble` seul | `torchLoop()` |

## Invariants / pièges déjà mordus une fois — ne pas régresser
- **iOS = aucune torche, jamais, sur aucun navigateur.** WebKit n'implémente pas `MediaTrackConstraints.torch` ; tout navigateur iOS (Chrome/Firefox/Edge inclus) tourne sur WebKit (imposé par Apple hors UE/DMA, et même sous DMA aucun moteur alternatif ne l'implémente). Écran = mécanisme principal partout, torche = bonus Android/Chromium uniquement.
- **iOS = pas de `BarcodeDetector`, aucune version** (vérifié caniuse : "disabled by default" sur Safari desktop et iOS). D'où **jsQR** pour le scanner in-app (canvas + décodage pixel pur JS, zéro dépendance à une Shape Detection API) — fonctionne partout, iOS inclus. Même lib que `../mix`, déjà validée en usage réel avant d'être adoptée ici. Bouton scanner toujours visible (jamais caché en silence — a prêté à confusion en v1 avec BarcodeDetector), message clair au clic si `jsQR`/caméra indisponible.
- **QR affiché (encodage) : image générée par une API externe** (`api.qrserver.com`), pas de lib JS côté client — même technique que `../mix`. **Historique** : la génération client-side (lib `qrcode` npm via CDN) a cassé 3 fois de suite pour 3 raisons différentes (mauvaise URL → 404 ; bonne URL mais `require()` CommonJS inexécutable en navigateur ; `typeof` levant dans le sandbox de test) avant d'être abandonnée pour cette approche, beaucoup plus robuste. **Leçon générale : un `curl` qui vérifie le status HTTP, ou un `grep` sur un nom de symbole, ne prouve jamais qu'un script s'exécute réellement — il faut le faire tourner pour de vrai (Node, ou un vrai navigateur) avant de déclarer un fix résolu.**
- **`renderQrInto()`/le chargement du scanner doivent rester isolés de `wsConnect()`.** Tout ce qui peut échouer côté QR/scan (image qui ne charge pas, lib absente) ne doit jamais empêcher la connexion WS dans `startMaster()`/`startClient()`.
- **`requestAnimationFrame` ≠ Wake Lock.** rAF est throttled/suspendu dès que l'onglet perd le focus (changer de fenêtre/appli), indépendamment du verrouillage d'écran que couvre le Wake Lock. La boucle d'analyse du maître tourne sur `setInterval`, jamais rAF (le scanner QR, lui, reste sur rAF — pertinent seulement pendant qu'on regarde activement l'écran, pas de risque d'arrière-plan).
- **`playing` doit être piloté par les events natifs `play`/`pause` de l'`<audio>`, pas par le seul clic du bouton.** Toute pause hors-bouton (fin de piste, interruption audio OS sur mobile — appel, autre appli) désynchronise sinon l'état et gèle cues/torche/couleur en silence côté clients, sans notifier personne. `audioEl.loop = true` en complément, pour qu'une piste qui se termine n'éteigne pas le show.
- **Revoke `URL.createObjectURL`** à chaque nouveau fichier chargé ET à la sortie de session (`currentBlobUrl`), sinon fuite mémoire silencieuse.
- **Un client qui se reconnecte doit repasser par `clientApplyCue(0,0,0)` immédiatement**, pas attendre le prochain `cue` — sinon l'écran ment sur l'état de la connexion (reste figé sur la dernière couleur).
- **Pendant un reconnect auto, `MASTER_TAKEN` peut être transitoire** (heartbeat serveur pas encore passé sur l'ancienne connexion morte) — le client retente (`ws._isRetry`) plutôt que d'éjecter l'utilisateur avec une alerte.
- **`accept` du file input inclut des extensions explicites en plus de `audio/*`** (`.mp3,.m4a,.wav,.aac,.ogg`) — les pickers mobiles filtrent parfois sur un MIME-sniffing incorrect (`.m4a` en particulier est signalé de façon incohérente selon l'OS).

## Sprint suivant — capture audio ambiante (micro) au lieu du fichier manuel
Objectif : le maître ne charge plus un fichier, il "écoute" ce qui joue déjà sur l'appareil (Spotify, Apple Music, YouTube, peu importe l'appli) et diffuse l'analyse en direct.

**Pourquoi pas un vrai "loopback" système :** aucune API web ne permet de capter "ce que l'OS joue" venant d'une autre appli — bloqué à la fois pour des raisons de sécurité (écoute audio silencieuse d'autres apps) et parce que les OS mobiles ne l'exposent tout simplement pas. `getDisplayMedia({audio:true})` capte de l'audio système/onglet mais desktop-only et inutilisable ici (cible = téléphones).

**Approche retenue : micro ambiant.** `getUserMedia({audio:true})` — le téléphone maître écoute littéralement ce qui sort de son propre haut-parleur (ou d'une enceinte externe à proximité). Fonctionne sur toute plateforme y compris iOS, indépendamment de l'appli source. Contrepartie : qualité dépendante du volume/de la distance/du bruit ambiant — inhérent à l'approche, pas un bug à corriger.

**Piège à ne pas rater en implémentant :** `getUserMedia({audio:true})` seul active par défaut `echoCancellation`/`noiseSuppression`/`autoGainControl` — pensés pour la voix en appel, ils écrasent la dynamique dont la détection de beat a besoin et peuvent supprimer du contenu musical légitime en le prenant pour du bruit/écho. Explicitement désactiver les trois :
```js
navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
})
```

**Réutilisation d'architecture — le point fort de cette approche :** `bandRanges`/`createBandEnvelope`/`bandEnergy`/`analysisTick` opèrent tous sur un `AnalyserNode`, indifférents à la source. Remplacer uniquement `audioCtx.createMediaElementSource(audioEl)` par `audioCtx.createMediaStreamSource(micStream)` — **tout le reste de la chaîne d'analyse ne change pas**. Aucun changement de protocole WS non plus (`cue{bass,mid,treble}` identique quelle que soit la source) : ce sprint touche uniquement le côté maître de `index.html`.

**Changements UI à prévoir :** remplacer `<input type=file>` par un bouton "Écouter" qui demande la permission micro ; plus de notion play/pause de piste (start/stop d'écoute à la place) ; plus de nom de fichier à afficher, les 3 mini-mètres deviennent le seul retour visuel de fonctionnement. **Question ouverte à trancher au démarrage du sprint** : garder le chargement de fichier comme mode alternatif (signal plus propre, utile pour tester sans bruit ambiant), ou le retirer complètement comme demandé.

## Backlog
Compensation d'offset horloge pour la latence réelle (le `ping/pong` applicatif existe, l'offset n'est pas calculé/appliqué) · interpolation client entre deux `cue` (saut direct actuellement) · PWA/manifest (comme `../setlist`) · stress test réel >20 peers · token de session pour fiabiliser la reprise de rôle maître (au lieu du seul heartbeat) · réglages beat-detection exposés en UI si le tuning par défaut ne convient toujours pas à un style de musique donné · gain par bande si une bande reste faible sur certains fichiers sources (raw FFT magnitude naturellement inégale entre graves/aigus selon le mix)

---
*Màj 16 juillet 2026 (i) — jsQR + QR par API, thème clair/sombre, plan capture micro*
