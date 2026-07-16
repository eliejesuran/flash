# Flash — Light Show Synchronisé
**v2026-07-16f** · Elie JESURAN · GPL

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
Symptôme rapporté : la session se fige parfois, ou reste sur une couleur figée tant qu'on ne quitte/rejoint pas. Plusieurs mécanismes distincts, tous côté **maître** (c'est lui qui doit continuer à émettre des `cue` sans interruption) :
1. **Écran qui se verrouille** → timers suspendus par l'OS → plus aucun `cue`. Fix : **Screen Wake Lock** (`navigator.wakeLock`) demandé sur maître et client tant que la session est active, redemandé sur `visibilitychange` (le lock est auto-relâché quand l'onglet passe en arrière-plan).
2. **Onglet qui perd le focus** (changer de fenêtre/appli sur ordinateur, très courant en testant) → `requestAnimationFrame` est un mécanisme **différent** du verrouillage d'écran : les navigateurs le suspendent dès que l'onglet n'est plus visible/actif, **même écran allumé et déverrouillé** — le Wake Lock ne couvre pas ce cas. C'est la cause la plus probable du "figé sauf si on quitte et revient" observé en testant sur un autre ordinateur : revenir sur l'onglet (ou quitter/rejoindre, qui force une reconnexion) relance `requestAnimationFrame` par la même occasion, d'où l'impression que le rejoin "corrige" la couleur. Fix : la boucle d'analyse audio du maître tourne maintenant sur `setInterval` (33ms), pas `requestAnimationFrame` — beaucoup moins agressivement throttlé en arrière-plan.
3. **Coupure réseau sans close propre** (bascule wifi/4G) → côté serveur, `session.master` pointait vers une connexion morte indéfiniment → un maître qui se reconnecte se fait rejeter `MASTER_TAKEN` → plus jamais de `cue`. Fix : **heartbeat serveur** (`ws.ping()` toutes les 30s, `ws.terminate()` si pas de pong reçu — pattern standard de la lib `ws`) qui force le `close` et libère `session.master`/`session.clients` proprement.

En complément, côté client : reconnexion auto avec backoff exponentiel (1s→8s, 8 tentatives max) sur toute coupure non intentionnelle, et le `#flash-zone` est explicitement remis à noir (+ torche coupée) à la déconnexion au lieu de rester figé sur la dernière valeur — même si la reconnexion échouait, l'écran ne mentirait plus sur l'état de la connexion.

## Protocole WS
URL : `/session/{id}` · id `[a-zA-Z0-9-]{4,20}` (même regex que setlist)

| Direction | Type | Contenu |
|---|---|---|
| c→s | `identify` | `{role:'master'\|'client'}` |
| s→c | `joined` | `{sessionId, role, peers, hasMaster}` |
| s→c | `master_status` | `{hasMaster}` — broadcast connexion/déconnexion maître |
| s→c | `peers_update` | `{peers}` — compteur seul, pas de noms (inutile ici contrairement à setlist) |
| m→s→c | `cue` | `{bass, mid, treble: 0..1, ts}` — throttle serveur ~40Hz max (`CUE_MIN_INTERVAL_MS`), une valeur par bande de fréquence (voir § Analyse audio) |
| m→s→c | `track_control` | `{action:'play'\|'pause'\|'seek', position, ts}` |
| m→s→c | `color` | `{color:'#rrggbb'}` — teinte du flash écran ; envoyé seulement au changement (pas à chaque cue) |
| c↔s | `ping/pong` | heartbeat applicatif (client ping toutes les 20s) — distinct du heartbeat protocole WS serveur→clients (30s, détection de connexions mortes) |
| s→c | `error` | `{code, message}` — `MASTER_TAKEN` · `SESSION_FULL` · `MSG_TOO_LARGE` · `BAD_JSON` · `UNKNOWN_TYPE` |

Un seul maître par session : `identify role=master` rejeté (`MASTER_TAKEN`) si un maître est déjà connecté et vivant (voir § Freeze pour le heartbeat qui garantit que "vivant" reste correct). **Reconnexion** : à la déconnexion du maître (propre ou détectée par heartbeat), `session.master` repasse à `null` immédiatement (broadcast `master_status`). Pendant un reconnect auto, un `MASTER_TAKEN` transitoire (heartbeat pas encore passé) déclenche un nouveau essai côté client plutôt qu'une éjection. Pas de `session.state` persisté : un client qui rejoint en cours reçoit simplement le prochain `cue`. Sécurité serveur : origin allowlist + rate limit/IP (10/min) + cap taille message 4 Ko.

## Rejoindre une session
Trois façons, en plus de la saisie manuelle (5 caractères sans I/O/0/1 ambigus) :
- **QR affiché par le maître** en permanence (`qrcode@1.5.3`, CDN jsdelivr : `/lib/browser.min.js`) encodant `${location.origin}${location.pathname}?join={code}` → scan via **appareil photo natif**. Dégradation gracieuse déjà en place : si le CDN est bloqué/hors-ligne, `renderQrInto()` masque le canvas et affiche le hint texte ("QR indisponible — utilise le code") au lieu de laisser un vide muet — `wsConnect()` n'est jamais bloqué par cet échec.
  **Deux bugs réels trouvés sur ce même mécanisme** (aucun des deux détectable en sandbox, qui n'a jamais eu d'accès réseau externe pour tester le CDN pour de vrai) : (1) l'URL CDN initiale (`/build/qrcode.min.js`) était **fausse** — 404 pour tout le monde depuis le début, jamais un problème réseau/ad-blocker de l'utilisateur. Vérifié avec `curl` en dehors du sandbox ; la bonne URL est `/lib/browser.min.js` (chemin donné par l'API jsdelivr `data.jsdelivr.com`, à revérifier si la version de la lib change). (2) Le check `typeof QRCode === 'undefined'` levait une `ReferenceError` dans le navigateur de test sandboxé au lieu de renvoyer `'undefined'` — comportement non standard mais le check a été remplacé par `!('QRCode' in window)`, strictement équivalent et sans ce risque, aucune régression possible sur un navigateur normal.
- **Bouton "🔗 Inviter" sur l'écran client** : n'importe qui déjà dans la session (pas seulement le créateur) peut rouvrir le QR + code dans un overlay pour inviter d'autres personnes — utilise la même fonction `renderQrInto()` que le maître, juste ciblée sur un autre canvas (`#share-qr-canvas`).
- **Scanner in-app** (bouton "📷 Scanner" sur l'accueil) : `BarcodeDetector` natif, **pas de lib CDN** — on a déjà eu un bug à cause d'un CDN bloqué pour l'encodeur QR, inutile de dupliquer ce risque de fragilité côté scan. Bouton caché si `'BarcodeDetector' in window` est faux ; code manuel ou scan natif restent disponibles. Décode soit l'URL `?join=`, soit un code brut. Overlay plein écran avec flux vidéo + cadre viewfinder CSS, polling `detect()` toutes les 250ms, caméra coupée proprement à la fermeture.
  **Correctif** : une version précédente de ce doc affirmait "Safari 17+" supporté — **faux**, vérifié via caniuse début : Safari (desktop et iOS, toutes versions) a `BarcodeDetector` "disabled by default", donc **jamais disponible en pratique**. Seuls Chrome/Edge/Samsung Internet/Android WebView l'exposent réellement. Sur iOS, le bouton scanner reste donc toujours caché (comportement correct, pas un bug) — la QR affichée par le maître + l'appareil photo natif restent la seule voie de scan sur iOS.

## Écrans
- **Maître** : sélection fichier audio · lecture/pause · QR + code · sélecteur couleur (`<input type=color>`, natif, pas de lib) · statut connexion · compteur peers · 3 mini-mètres basses/médiums/aigus (rouge/vert/bleu — mapping identique à la couleur réellement envoyée, sert à vérifier que la séparation de bandes fonctionne avant même de regarder un téléphone client)
- **Client** : saisie/scan code → `#flash-zone` plein écran (couleur réactive, voir § Couleur) + badges statut/peers/torche + bouton "Inviter" en overlay

## Analyse audio — détection de beat par bande
Symptôme corrigé : le flash "clignotait" sans vraiment suivre la musique. Cause : l'ancienne version envoyait une simple moyenne lissée (EMA) de la magnitude des basses — ça suit le volume, pas le rythme, et réagit au bruit frame-à-frame du signal plutôt qu'aux coups.

- `analyser.fftSize = 2048` (contre 256 avant) — résolution fréquentielle fine, indispensable pour séparer proprement 3 bandes. `smoothingTimeConstant = 0.2` (contre 0.6) — peu de lissage natif, on veut des transitoires nets ; c'est la détection de beat elle-même qui façonne le rendu final, pas l'analyser.
- 3 bandes calculées en Hz réels (pas en % de bins) via `audioCtx.sampleRate`, donc correctes quel que soit le sample rate du fichier : **bass** 20-250Hz, **mid** 250-4000Hz, **treble** 4000-12000Hz.
- Par bande, `createBandEnvelope()` : historique glissant (~0.7s) → moyenne récente = seuil adaptatif. Si l'énergie instantanée dépasse `moyenne × 1.5` (plancher absolu 0.15) **et** qu'au moins `MIN_BEAT_INTERVAL_MS` (120ms) s'est écoulé depuis le dernier coup détecté → **beat** → attaque quasi instantanée (`energy × 1.15`, clampé à 1). Sinon → décroissance exponentielle `× 0.88` par frame vers le prochain coup.
  **v1.2 avait un seuil trop bas (×1.25) et aucune période réfractaire** : un signal soutenu et fort (typiquement les basses) dépasse facilement `moyenne×1.25` à répétition frame après frame à cause de son propre bruit naturel, donnant un flicker rapide plutôt que des coups nets — vérifié avec un test unitaire Node simulant 5s de signal bruité + 2 vrais pics : ancien réglage = 5 déclenchements détectés (attendu 2), nouveau réglage = 2 exacts.
- Envoyé au client tel quel (`{bass, mid, treble}`), throttle serveur inchangé (~40Hz max), envoi client cadencé par `setInterval` (voir § Freeze) plutôt que `requestAnimationFrame`.

## Couleur — évolue avec la musique
La couleur choisie par le maître (défaut blanc) est une **teinte/palette**, pas une valeur figée : côté client, chaque canal RGB suit l'énergie de sa propre bande — `r = tint.r × bass`, `g = tint.g × mid`, `b = tint.b × treble`. En blanc (défaut), c'est directement une visualisation spectrale (basses → rouge, médiums → vert, aigus → bleu) qui **change de teinte en temps réel** selon le contenu de la musique, pas seulement d'intensité. Choisir une couleur saturée (ex. rouge pur) réduit de facto la variation aux bandes dont les canaux sont non-nuls — comportement prévisible : plus la teinte choisie est "large" (proche du blanc), plus l'effet spectral est visible.
Un changement de `color` ré-applique immédiatement les dernières valeurs bass/mid/treble connues, pas besoin d'attendre le prochain `cue`. Le serveur valide `color` par regex hex avant de relayer.

## Torche — implémentation
La torche ne peut physiquement pas être teintée : elle suit `latestIntensity = treble` (pas `max(bass,mid,treble)` comme en v1.2 — les aigus ont des transitoires plus nets, hi-hats/cymbales, contre des basses souvent plus soutenues donc moins nettes à détecter proprement ; changement demandé après test réel). `setupTorch()` : `getUserMedia({video:{facingMode:'environment', width/height ideal:64}})` (résolution minimale, le flux n'est jamais affiché) → `track.getCapabilities().torch` détermine le mode. Si dispo : `torchLoop()` auto-entretenue (boucle `setTimeout` qui relit `latestIntensity` à chaque tick de fenêtre 200ms) — **découplée du débit réseau des cues**, pour un vrai cycle on/off stable plutôt qu'un toggle au rythme des messages entrants (~30Hz, trop instable pour le hardware).

## Hébergement
Front : GitHub Pages — https://eliejesuran.github.io/flash/ (actif, déploie auto depuis `main`, pas d'Action nécessaire)
Serveur : Render — https://flash-a9yt.onrender.com (root dir `server/`, build `npm install`, start `npm start`, plan Free)
**TODO** : UptimeRobot ping `/healthz` toutes les 5min pour éviter la mise en veille du plan Free (pas encore configuré).

### Tester en local sans Render
`WS_SERVER` détecte `localhost`/`127.0.0.1` **et les IP réseau local** (`192.168.*`, `10.*`, `172.16-31.*`) et pointe alors vers `ws://<même hôte>:3001` — ça permet de tester depuis un vrai téléphone sur le même wifi que la machine qui fait tourner `server.js`, sans rien déployer. Le serveur autorise ces origines (`LOCAL_NETWORK_ORIGIN` dans `server.js`). **Piège** : ouvrir `index.html` en double-clic (`file://`) ne matche aucun de ces cas (`location.hostname` est vide) → `WS_SERVER_CONFIGURED` est `false`, message clair affiché au lieu de tenter une connexion vouée à l'échec. Il faut servir le dossier via un vrai serveur HTTP (`python3 -m http.server 5500` par ex.) en plus de `node server/server.js`.

## Backlog
**Livré (v1)** : join + cue broadcast naïf · flash écran · torche Android best-effort avec repli écran · fichier audio local + Web Audio API · dégradation gracieuse QR
**Livré (v1.1)** : heartbeat serveur (zombies) + reconnexion client avec backoff + reset visuel sur coupure · Screen Wake Lock · couleur du flash écran · scanner QR in-app (BarcodeDetector) · fix connexion locale (IP réseau/`file://`)
**Livré (v1.2)** : détection de beat par bande (bass/mid/treble, attaque/décroissance) au lieu d'une moyenne lissée · couleur spectrale réactive (teinte × bandes, évolue avec la musique) · QR/code partageable depuis l'écran client
**Livré (v1.3)** : QR CDN réparé (mauvaise URL depuis le début, jamais fonctionnel) · beat-detection moins nerveux (seuil + période réfractaire, fini le flicker rapide) · torche sur les aigus plutôt que le max des 3 bandes · fix freeze maître causé par le throttling de `requestAnimationFrame` en arrière-plan (`setInterval` à la place)
**v2+** : compensation d'offset horloge pour un vrai calcul de latence (le `ping/pong` applicatif existe déjà, l'offset n'est pas encore calculé/appliqué) · interpolation client entre deux `cue` (actuellement saut direct) · PWA/manifest (comme setlist) · multi-peers stress test (>20) · token de session pour fiabiliser la reprise de rôle maître (au lieu de compter sur le seul heartbeat) · réglages beat-detection exposés (seuil/décroissance/période réfractaire) si le tuning actuel ne convient toujours pas à certains styles de musique · gain par bande si une bande spécifique reste faible sur certains morceaux (ex. basses peu présentes dans le fichier source)

---
*Màj 16 juillet 2026 (f) — correctif doc : BarcodeDetector n'existe pas sur Safari/iOS (aucune version)*
