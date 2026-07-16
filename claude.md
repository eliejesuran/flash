# Flash — Light Show Synchronisé
**v2026-07-16l** · Elie JESURAN · GPL

Maître (téléphone) lit un fichier audio local → analyse 3 bandes de fréquence en temps réel → diffuse à N clients qui varient écran/torche en rythme. Join par QR, code, ou scan in-app (fonctionne sur iOS aussi, voir § Invariants). Thème clair/sombre selon l'appareil, installable en PWA.

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
| PWA | `manifest.json` + `icons/` (192/512/apple-touch, générées via `node-canvas`, source `icons/icon.svg`) — "Ajouter à l'écran d'accueil" sur mobile. Pas de service worker (l'app a besoin du WS en direct pour fonctionner, un cache offline n'apporterait rien) |
| TODO | UptimeRobot sur `/healthz` (5min) — pas configuré, Render s'endort après inactivité (cold start ~10-60s) |

## Protocole WS
`/session/{id}` · id `[a-zA-Z0-9-]{4,20}`

| Dir | Type | Payload |
|---|---|---|
| c→s | `identify` | `{role:'master'\|'client'}` |
| s→c | `joined` | `{sessionId,role,peers,torch,screen,hasMaster}` |
| s→c | `master_status` | `{hasMaster}` |
| s→c | `peers_update` | `{peers,torch,screen}` — décompte torche/écran séparé, voir § Rôles torche |
| c→s | `capability` | `{torch:bool}` — le client rapporte s'il a réellement obtenu la torche (envoyé à l'ouverture du socket avec la valeur connue, puis mis à jour dès que `setupTorch()` résout) |
| m→c | `cue` | `{bass,mid,treble:0..1,ts}` — ~30Hz |
| m→c | `track_control` | `{action:'play'\|'pause'\|'seek',position,ts}` |
| s→c | `color` | `{color:'#rrggbb'}` — **personnalisé par client** si ≥3 appareils (voir § Couleurs écran par appareil), sinon identique pour tous |
| s→c | `role` | `{role:'overall'\|'bass'\|'mid'\|'treble'\|'mid_bass'}` — **personnalisé par client** (pas un broadcast), voir § Rôles torche |
| c↔s | `ping/pong` | applicatif, 20s (distinct du heartbeat protocole WS serveur, 30s) |
| s→c | `error` | `{code,message}` — `MASTER_TAKEN`·`SESSION_FULL`·`MSG_TOO_LARGE`·`BAD_JSON`·`UNKNOWN_TYPE` |

Un seul maître/session (`ws === session.master`). Pas de `session.state` persisté — un join en cours de session reçoit juste le prochain `cue`. Origin allowlist + rate limit/IP + cap taille message côté serveur.

## Rôles torche (`recomputeRoles()` dans server.js)
Chaque client a un rôle qui détermine quelle bande pilote SA torche — pas la même pour tout le monde, pour casser l'effet "toutes les torches flashent en même temps" (trop stroboscope). Recalculé pour tous les clients (pas le maître) à chaque connexion/déconnexion d'un client, basé sur l'ordre d'arrivée dans `session.clients` (Set = ordre d'insertion conservé) :

| Nb clients | Rôles assignés |
|---|---|
| 1 | `overall` (moyenne des 3 bandes) |
| 2 | client 1 → `treble` · client 2 → `mid_bass` (moyenne médium+graves) |
| 3 | client 1 → `bass` · client 2 → `mid` · client 3 → `treble` |
| 4+ | les 3 premiers gardent le schéma à 3 ; le 4e et suivants reçoivent une bande aléatoire (`bass`/`mid`/`treble`) chacun |

Le message `role` est envoyé individuellement (`send(ws,...)`, pas `broadcast`) — chaque client reçoit potentiellement une valeur différente des autres. Le client stocke `myRole` et recalcule `latestIntensity` (ce qui pilote `torchLoop()`) via `roleIntensity()` à chaque `cue` reçu.

Le rôle assigné ne dit pas si la torche a réellement été obtenue (iOS n'en a jamais, Android peut refuser la permission caméra) : chaque client rapporte sa vraie capacité via `capability{torch}` juste après `identify`, puis à nouveau dès que `setupTorch()` résout (avant résolution, considéré `screen` par défaut — voir `ws._torch` dans `server.js`). Le serveur en tire un décompte torche/écran séparé (`broadcastCounts()`), affiché par le front comme un simple total si <3 appareils, ou détaillé (`🔦 T · 📱 S`) à partir de 3 — même seuil que la palette de couleurs ci-dessous.

## Couleurs écran par appareil (`recomputeColors()` dans server.js)
Sous les 3 appareils (torche + écran confondus), tout le monde affiche exactement `session.baseColor` (la couleur choisie par le maître) — petit groupe, pas besoin de varier. À partir de 3, chaque client reçoit une teinte différente : rotation par index sur le cercle chromatique (`h + index × 360/n`), même saturation/luminosité que la couleur du maître. Si cette couleur est neutre (blanc par défaut, saturation quasi nulle), la rotation de teinte n'aurait aucun effet visible -> substitution d'une base rouge vif saturée (`h=0,s=0.75,l=0.55`) pour que la palette soit réellement visible. Recalculé aux mêmes moments que les rôles torche (connexion/déconnexion) + à chaque changement de couleur par le maître. Contrairement aux rôles, s'applique à TOUS les clients (torche ou écran seul) — chacun a un écran, peu importe s'il a aussi une torche.

## Constantes qui comptent (ne pas re-tuner à l'aveugle)
| Constante | Valeur | Où |
|---|---|---|
| `fftSize` | 2048 | `setupAudio()` |
| `smoothingTimeConstant` | 0.2 | `setupAudio()` |
| Bandes | bass 20-250Hz · mid 250-4000Hz · treble 4000-12000Hz | `bandRanges`, calculé en Hz réels via `sampleRate` |
| Seuil beat | énergie > moyenne×1.5 ET >0.15 | `createBandEnvelope()` |
| Période réfractaire | 120ms | `MIN_BEAT_INTERVAL_MS` |
| Décroissance | ×0.88/tick | `createBandEnvelope()` |
| Plancher | `max(enveloppe, énergie×0.6)` | évite un rendu "mort" en passage soutenu/peu percussif. **0.6, pas 0.3** : pendant les ~0.7s de remplissage de `history` la moyenne est quasi nulle → chaque tick est un beat → rendu à pleine énergie ; la fenêtre remplie, les beats se raréfient en passage soutenu et tout retombe sur ce plancher — à 0.3 la chute mesurait 69% (simulée sur le code réel) et se voyait comme "les couleurs perdent en intensité après ~1s" (retour utilisateur 16/7), à 0.6 elle tombe à 39% |
| `HISTORY_SIZE` | 21 ticks (~0.7s à 33ms/tick — **pas** 60fps) | `createBandEnvelope()` |
| Cadence analyse | `setInterval(33ms)`, **pas** `requestAnimationFrame` | `analysisTick` |
| Throttle cue serveur | 25ms (~40Hz max) | `CUE_MIN_INTERVAL_MS` |
| Rate limit connexions | 60/min/IP | `RATE_LIMIT_MAX` — plusieurs téléphones = 1 IP (NAT wifi de salle), pas juste anti-abus |
| Heartbeat serveur | ping 30s, `terminate()` si pas de pong | `HEARTBEAT_INTERVAL_MS` |
| Reconnexion client | backoff 1s→8s, 8 tentatives max | `MAX_RECONNECT_ATTEMPTS` |
| Torche | fenêtre on/off 200ms, pilotée par `myRole` (voir § Rôles torche) | `torchLoop()` |
| Boost écran | `min(1, v^0.55 × 1.15)` appliqué au rendu RGB uniquement | `boostForDisplay()`, `SCREEN_GAMMA`/`SCREEN_GAIN` — rendu "trop fade" sinon ; n'affecte pas `latestBass/Mid/Treble` (utilisés par le rôle torche) ni le `cue` envoyé |
| Lissage cue client | EMA, `prev + (cible-prev) × 0.45` par cue reçu | `smoothTo()`, `CUE_SMOOTHING_ALPHA` — sans ça, écran+torche sautent instantanément à chaque cue (~40Hz max) et lisent comme un stroboscope même hors des vrais beats. Ne s'applique qu'aux cues réels, jamais à un reset (voir `clientResetDisplay()`) |
| Saturation écran | étirement contraste RGB autour de la moyenne des 3 canaux, ×2 | `boostSaturation()`, `SCREEN_SATURATION` — une base blanche + 3 bandes simultanément actives (plancher oblige) donne r≈g≈b la plupart du temps, donc gris "fade" même après le boost gamma/gain ci-dessus (qui ne touche que la luminosité) ; laisse un vrai gris inchangé (delta nul, pas de teinte inventée) |

## Invariants / pièges déjà mordus une fois — ne pas régresser
- **iOS = aucune torche, jamais, sur aucun navigateur.** WebKit n'implémente pas `MediaTrackConstraints.torch` ; tout navigateur iOS (Chrome/Firefox/Edge inclus) tourne sur WebKit (imposé par Apple hors UE/DMA, et même sous DMA aucun moteur alternatif ne l'implémente). Écran = mécanisme principal partout, torche = bonus Android/Chromium uniquement.
- **iOS = pas de `BarcodeDetector`, aucune version** (vérifié caniuse : "disabled by default" sur Safari desktop et iOS). D'où **jsQR** pour le scanner in-app (canvas + décodage pixel pur JS, zéro dépendance à une Shape Detection API) — fonctionne partout, iOS inclus. Même lib que `../mix`, déjà validée en usage réel avant d'être adoptée ici. Bouton scanner toujours visible (jamais caché en silence — a prêté à confusion en v1 avec BarcodeDetector), message clair au clic si `jsQR`/caméra indisponible.
- **QR affiché (encodage) : image générée par une API externe** (`api.qrserver.com`), pas de lib JS côté client — même technique que `../mix`. **Historique** : la génération client-side (lib `qrcode` npm via CDN) a cassé 3 fois de suite pour 3 raisons différentes (mauvaise URL → 404 ; bonne URL mais `require()` CommonJS inexécutable en navigateur ; `typeof` levant dans le sandbox de test) avant d'être abandonnée pour cette approche, beaucoup plus robuste. **Leçon générale : un `curl` qui vérifie le status HTTP, ou un `grep` sur un nom de symbole, ne prouve jamais qu'un script s'exécute réellement — il faut le faire tourner pour de vrai (Node, ou un vrai navigateur) avant de déclarer un fix résolu.**
- **`renderQrInto()`/le chargement du scanner doivent rester isolés de `wsConnect()`.** Tout ce qui peut échouer côté QR/scan (image qui ne charge pas, lib absente) ne doit jamais empêcher la connexion WS dans `startMaster()`/`startClient()`.
- **`requestAnimationFrame` ≠ Wake Lock.** rAF est throttled/suspendu dès que l'onglet perd le focus (changer de fenêtre/appli), indépendamment du verrouillage d'écran que couvre le Wake Lock. La boucle d'analyse du maître tourne sur `setInterval`, jamais rAF (le scanner QR, lui, reste sur rAF — pertinent seulement pendant qu'on regarde activement l'écran, pas de risque d'arrière-plan).
- **`playing` doit être piloté par les events natifs `play`/`pause` de l'`<audio>`, pas par le seul clic du bouton.** Toute pause hors-bouton (fin de piste, interruption audio OS sur mobile — appel, autre appli) désynchronise sinon l'état et gèle cues/torche/couleur en silence côté clients, sans notifier personne. `audioEl.loop = true` en complément, pour qu'une piste qui se termine n'éteigne pas le show.
- **Revoke `URL.createObjectURL`** à chaque nouveau fichier chargé ET à la sortie de session (`currentBlobUrl`), sinon fuite mémoire silencieuse.
- **Un client qui se reconnecte (ou dont la lecture est mise en pause) doit repasser par `clientResetDisplay()` immédiatement**, pas attendre le prochain `cue` — sinon l'écran ment sur l'état de la connexion (reste figé sur la dernière couleur). Ce reset doit rester un snap instantané, jamais passer par le chemin lissé (`clientApplyCue`/`smoothTo`) : un seul appel lissé ne parcourt qu'une fraction de la distance vers 0 et, faute de cues suivants pour continuer à converger, resterait figé à mi-chemin indéfiniment.
- **Pendant un reconnect auto, `MASTER_TAKEN` peut être transitoire** (heartbeat serveur pas encore passé sur l'ancienne connexion morte) — le client retente (`ws._isRetry`) plutôt que d'éjecter l'utilisateur avec une alerte.
- **`accept` du file input inclut des extensions explicites en plus de `audio/*`** (`.mp3,.m4a,.wav,.aac,.ogg`) — les pickers mobiles filtrent parfois sur un MIME-sniffing incorrect (`.m4a` en particulier est signalé de façon incohérente selon l'OS).
- **AirPlay-en-tant-que-récepteur est infaisable en web** — pas une question de code à trouver. Devenir un récepteur AirPlay demande une intégration OS native + licence Apple (MFi), aucune API web n'expose ça. Idem pour capter l'audio d'une autre appli **sur mobile** : bloqué par design (sécurité + sandboxing OS), `getDisplayMedia` n'existe ni sur iOS ni sur Android, aucun navigateur. D'où le micro comme seule voie **mobile** pour "écouter ce qui joue" (voir § Sprint suivant). **Nuance re-vérifiée le 16/7 : sur ORDINATEUR, la capture d'onglet avec audio marche réellement** — `getDisplayMedia({video:true,audio:true})` sur Chrome/Edge/Chromium desktop (depuis Chrome 74), l'utilisateur choisit un onglet et coche "Partager l'audio de l'onglet". Safari et Firefox ont l'API mais ignorent silencieusement l'audio (bug Firefox #1541425 ouvert depuis 2019). Donc : maître desktop Chrome → capter Spotify Web/YouTube d'un autre onglet est faisable (voir § Sprint suivant, option desktop) ; maître téléphone → toujours micro uniquement. Détails d'implémentation pièges : demander `video:true` obligatoirement (audio seul → TypeError sur Chrome) ; ne PAS connecter la source au `destination` (l'onglet capturé continue de jouer localement par défaut → sinon écho/doublage) ; et un embed dans la page (iframe YouTube, lecteur Spotify) ne remplace PAS la capture — média cross-origin/DRM = AnalyserNode muet (CORS taint).

## Sprint suivant — capture audio ambiante (micro) au lieu du fichier manuel
Objectif : le maître ne charge plus un fichier, il "écoute" ce qui joue déjà sur l'appareil (Spotify, Apple Music, YouTube, peu importe l'appli) et diffuse l'analyse en direct.

**Pourquoi pas un vrai "loopback" système :** aucune API web ne permet de capter "ce que l'OS joue" venant d'une autre appli — bloqué à la fois pour des raisons de sécurité (écoute audio silencieuse d'autres apps) et parce que les OS mobiles ne l'exposent tout simplement pas. `getDisplayMedia({audio:true})` capte de l'audio système/onglet mais desktop-only et inutilisable ici (cible = téléphones).

**Approche retenue : micro ambiant.** `getUserMedia({audio:true})` — le téléphone maître écoute littéralement ce qui sort de son propre haut-parleur (ou d'une enceinte externe à proximité). Fonctionne sur toute plateforme y compris iOS, indépendamment de l'appli source. Contrepartie : qualité dépendante du volume/de la distance/du bruit ambiant — inhérent à l'approche, pas un bug à corriger.

**Astuce qualité, même code** : si un câble aux relie la sortie casque de l'appareil source à l'entrée micro du maître (via adaptateur), `getUserMedia` capte un signal ligne propre au lieu du bruit ambiant — aucun changement de code, juste un setup physique à suggérer dans l'UI/doc utilisateur.

**Piège à ne pas rater en implémentant :** `getUserMedia({audio:true})` seul active par défaut `echoCancellation`/`noiseSuppression`/`autoGainControl` — pensés pour la voix en appel, ils écrasent la dynamique dont la détection de beat a besoin et peuvent supprimer du contenu musical légitime en le prenant pour du bruit/écho. Explicitement désactiver les trois :
```js
navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
})
```

**Réutilisation d'architecture — le point fort de cette approche :** `bandRanges`/`createBandEnvelope`/`bandEnergy`/`analysisTick` opèrent tous sur un `AnalyserNode`, indifférents à la source. Remplacer uniquement `audioCtx.createMediaElementSource(audioEl)` par `audioCtx.createMediaStreamSource(micStream)` — **tout le reste de la chaîne d'analyse ne change pas**. Aucun changement de protocole WS non plus (`cue{bass,mid,treble}` identique quelle que soit la source) : ce sprint touche uniquement le côté maître de `index.html`.

**Changements UI à prévoir :** remplacer `<input type=file>` par un bouton "Écouter" qui demande la permission micro ; plus de notion play/pause de piste (start/stop d'écoute à la place) ; plus de nom de fichier à afficher, les 3 mini-mètres deviennent le seul retour visuel de fonctionnement. **Question ouverte à trancher au démarrage du sprint** : garder le chargement de fichier comme mode alternatif (signal plus propre, utile pour tester sans bruit ambiant), ou le retirer complètement comme demandé.

**Option desktop complémentaire (non implémentée, faisabilité re-vérifiée 16/7) : capture d'onglet.** Si le maître est un ordinateur sous Chrome/Edge, `getDisplayMedia({video:true,audio:true})` permet de capter l'audio d'un autre onglet (Spotify Web, YouTube…) sans micro, signal parfaitement propre. Même branchement que le micro (`createMediaStreamSource`), chaîne d'analyse identique. Limites : desktop Chromium uniquement (Safari/Firefox sans audio, mobile sans l'API du tout — voir § Invariants pour les pièges : video obligatoire, pas de connexion au destination, embeds inutilisables) ; le picker d'onglet exige un vrai geste utilisateur et n'est pas automatisable → à tester à la main avant de déclarer fonctionnel. Bouton à n'afficher que si desktop+Chromium détecté, sinon il embrouille.

## Backlog
Compensation d'offset horloge pour la latence réelle (le `ping/pong` applicatif existe, l'offset n'est pas calculé/appliqué) · stress test réel >20 peers · token de session pour fiabiliser la reprise de rôle maître (au lieu du seul heartbeat) · réglages beat-detection exposés en UI si le tuning par défaut ne convient toujours pas à un style de musique donné · gain par bande si une bande reste faible sur certains fichiers sources (raw FFT magnitude naturellement inégale entre graves/aigus selon le mix) · service worker si un jour un mode offline fait sens · déploiement FTP Infomaniak en parallèle/à la place de GitHub Pages (voir échange du 16 juillet 2026 — action GitHub à écrire si retenu)

---
*Màj 16 juillet 2026 (l) — plancher enveloppe 0.3→0.6 (couleurs qui s'affadissaient après ~0.7s, une fois l'historique de beat rempli) ; faisabilité capture d'onglet desktop documentée (§ Invariants + § Sprint suivant)*
