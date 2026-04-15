        const canvas = document.getElementById('gameCanvas');
        const ctx = canvas.getContext('2d');
        
        function resizeCanvas() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        }
        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();

        // --- Firebase & Multiplayer ---
        let db, auth;
        let multiplayerSessionId = null;
        let multiplayerSessionCode = null;
        let isHost = false;
        let multiplayerPlayers = {}; // Remote players state
        let lobbyUnsubscribe = null;
        let playersUnsubscribe = null;
        let isAuthReady = false;

        async function initFirebase() {
            console.log("Initializing Firebase (Modular)...");
            try {
                const response = await fetch('/firebase-applet-config.json');
                if (!response.ok) throw new Error("Failed to fetch firebase-applet-config.json");
                const firebaseConfig = await response.json();
                console.log("Firebase config loaded:", firebaseConfig.projectId);
                
                const { initializeApp, getAuth, onAuthStateChanged, getFirestore } = window.firebaseModular;
                const app = initializeApp(firebaseConfig);
                
                if (firebaseConfig.firestoreDatabaseId) {
                    console.log("Using named database:", firebaseConfig.firestoreDatabaseId);
                    db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
                } else {
                    console.log("Using default database");
                    db = getFirestore(app);
                }
                
                auth = getAuth(app);
                
                onAuthStateChanged(auth, user => {
                    console.log("Auth state changed:", user ? `User logged in: ${user.uid}` : "No user");
                    if (user) {
                        isAuthReady = true;
                        document.getElementById('login-btn').classList.add('hidden');
                        document.getElementById('user-info').classList.remove('hidden');
                        document.getElementById('user-display-name').textContent = user.displayName || "Racer";
                        document.getElementById('multiplayer-actions').classList.remove('hidden');
                        console.log("Multiplayer ready.");
                    } else {
                        isAuthReady = false;
                        document.getElementById('login-btn').classList.remove('hidden');
                        document.getElementById('user-info').classList.add('hidden');
                        document.getElementById('multiplayer-actions').classList.add('hidden');
                    }
                });
            } catch (e) {
                console.error("Firebase init failed:", e);
                alert("Multiplayer initialization failed. See console for details.");
            }
        }
        initFirebase();

        async function loginWithGoogle() {
            const { GoogleAuthProvider, signInWithPopup } = window.firebaseModular;
            try {
                const provider = new GoogleAuthProvider();
                await signInWithPopup(auth, provider);
            } catch (err) {
                console.error("Login failed:", err);
                alert("Login failed: " + err.message);
            }
        }

        function openMultiplayerMenu() {
            showScreen('multiplayer-menu');
        }

        const OperationType = {
            CREATE: 'create',
            UPDATE: 'update',
            DELETE: 'delete',
            LIST: 'list',
            GET: 'get',
            WRITE: 'write',
        };

        function handleFirestoreError(error, operationType, path) {
            const u = auth?.currentUser;
            const errInfo = {
                error: error instanceof Error ? error.message : String(error),
                authInfo: u ? {
                    userId: u.uid,
                    emailVerified: u.emailVerified,
                    isAnonymous: u.isAnonymous,
                    tenantId: u.tenantId,
                    providerCount: u.providerData?.length ?? 0
                } : null,
                operationType,
                path
            };
            console.error('Firestore Error: ', JSON.stringify(errInfo, null, 2));
            // We don't always want to alert for background sync errors to avoid spamming
            if (operationType !== OperationType.UPDATE || !error.message.includes("permissions")) {
                // alert("Multiplayer Error: " + (error.message || "Unknown error"));
            }
            throw new Error(JSON.stringify(errInfo));
        }

        async function hostGame() {
            const { collection, doc, setDoc, serverTimestamp } = window.firebaseModular;
            const statusEl = document.getElementById('multiplayer-status');
            if (statusEl) statusEl.textContent = "";

            if (!db || !auth) {
                if (statusEl) statusEl.textContent = "Multiplayer not initialized. Please refresh.";
                return;
            }

            if (!isAuthReady || !auth.currentUser) {
                if (statusEl) statusEl.textContent = "Please login with Google first.";
                return;
            }
            const code = Math.random().toString(36).substring(2, 8).toUpperCase();
            multiplayerSessionCode = code;
            isHost = true;
            
            if (statusEl) statusEl.textContent = "Creating session...";
            
            try {
                const sessionRef = doc(collection(db, 'sessions'));
                multiplayerSessionId = sessionRef.id;
                
                const sessionData = {
                    code: code,
                    hostId: auth.currentUser.uid,
                    status: 'waiting',
                    trackId: currentMapIndex,
                    createdAt: serverTimestamp()
                };
                
                await setDoc(sessionRef, sessionData).catch(err => handleFirestoreError(err, OperationType.CREATE, 'sessions/' + multiplayerSessionId));
                
                if (statusEl) statusEl.textContent = "Session created! Joining lobby...";
                await joinLobby(multiplayerSessionId);
                if (statusEl) statusEl.textContent = "";
            } catch (err) {
                console.error("Host game failed:", err);
                if (statusEl) statusEl.textContent = "Host failed: " + err.message;
            }
        }

        async function joinGame() {
            console.log("joinGame called");
            const { collection, query, where, getDocs } = window.firebaseModular;
            const statusEl = document.getElementById('multiplayer-status');
            if (statusEl) statusEl.textContent = "";

            if (!db || !auth) {
                console.error("Firebase not initialized. db:", !!db, "auth:", !!auth);
                if (statusEl) statusEl.textContent = "Multiplayer not initialized. Please refresh.";
                return;
            }

            if (!isAuthReady || !auth.currentUser) {
                console.warn("Auth not ready or no user. isAuthReady:", isAuthReady, "user:", !!auth.currentUser);
                if (statusEl) statusEl.textContent = "Please login with Google first.";
                return;
            }

            const codeInput = document.getElementById('join-code-input');
            if (!codeInput) {
                console.error("Join code input not found");
                return;
            }

            const code = codeInput.value.trim().toUpperCase();
            console.log("User entered code:", code);
            if (!code) {
                if (statusEl) statusEl.textContent = "Enter a code!";
                return;
            }
            
            const joinBtn = codeInput.parentElement.querySelector('button');
            const originalBtnText = joinBtn ? joinBtn.textContent : "Join Game";
            if (joinBtn) {
                joinBtn.textContent = "JOINING...";
                joinBtn.disabled = true;
            }

            if (statusEl) statusEl.textContent = "Searching for session '" + code + "'...";
            
            try {
                console.log("Executing Firestore query for code:", code);
                const sessionsRef = collection(db, 'sessions');
                const q = query(sessionsRef, where('code', '==', code), where('status', '==', 'waiting'));
                
                // BUG FIX: getDocs result can be undefined if handleFirestoreError throws;
                // the outer try/catch handles it, but guard here to avoid confusing errors
                const snapshot = await getDocs(q).catch(err => handleFirestoreError(err, OperationType.LIST, 'sessions'));
                if (!snapshot) throw new Error('Failed to fetch sessions');
                console.log("Query completed. Snapshot empty:", snapshot.empty);
                
                if (snapshot.empty) {
                    console.warn("No session found with code:", code);
                    if (joinBtn) {
                        joinBtn.textContent = originalBtnText;
                        joinBtn.disabled = false;
                    }
                    if (statusEl) statusEl.textContent = "Session not found or already started.";
                    return;
                }
                
                const sessionDoc = snapshot.docs[0];
                multiplayerSessionId = sessionDoc.id;
                multiplayerSessionCode = code;
                isHost = false;
                
                console.log("Session found (ID: " + multiplayerSessionId + "), joining lobby...");
                if (statusEl) statusEl.textContent = "Joining lobby...";
                
                await joinLobby(multiplayerSessionId);
                
                if (joinBtn) {
                    joinBtn.textContent = originalBtnText;
                    joinBtn.disabled = false;
                }
                if (statusEl) statusEl.textContent = "";
            } catch (err) {
                console.error("Join game failed with error:", err);
                if (statusEl) statusEl.textContent = "Error: " + err.message;
                if (joinBtn) {
                    joinBtn.textContent = originalBtnText;
                    joinBtn.disabled = false;
                }
                alert("Join failed: " + err.message);
            }
        }

        // Add Enter key support directly
        (function() {
            const joinInput = document.getElementById('join-code-input');
            if (joinInput) {
                console.log("Attaching Enter key listener to join-code-input");
                joinInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        console.log("Enter key pressed in join-code-input");
                        joinGame();
                    }
                });
            } else {
                console.warn("Could not find join-code-input for Enter key listener");
            }
        })();

        async function joinLobby(sessionId) {
            const { doc, setDoc, onSnapshot, collection } = window.firebaseModular;
            if (!auth.currentUser) return;
            showScreen('lobby-menu');
            document.getElementById('lobby-code-display').textContent = multiplayerSessionCode;
            
            if (isHost) {
                document.getElementById('lobby-host-controls').classList.remove('hidden');
                document.getElementById('lobby-client-status').classList.add('hidden');
            } else {
                document.getElementById('lobby-host-controls').classList.add('hidden');
                document.getElementById('lobby-client-status').classList.remove('hidden');
            }
            
            // Add self to players
            let myColor = playerCustomColor || carTypes[selectedCarIndex].color;
            const playerPath = `sessions/${sessionId}/players/${auth.currentUser.uid}`;
            const playerRef = doc(db, 'sessions', sessionId, 'players', auth.currentUser.uid);
            const playerData = {
                uid: auth.currentUser.uid,
                name: auth.currentUser.displayName || ("Player_" + auth.currentUser.uid.substring(0, 4)),
                color: myColor,
                x: 0, y: 0, angle: 0, speed: 0, lap: 0, distanceDriven: 0, isFinished: false
            };
            
            await setDoc(playerRef, playerData).catch(err => handleFirestoreError(err, OperationType.CREATE, playerPath));
            
            // Listen for players
            if (playersUnsubscribe) playersUnsubscribe();
            playersUnsubscribe = onSnapshot(collection(db, 'sessions', sessionId, 'players'), snapshot => {
                const playersList = document.getElementById('lobby-players-list');
                playersList.innerHTML = '';
                snapshot.forEach(docSnap => {
                    const p = docSnap.data();
                    const div = document.createElement('div');
                    div.textContent = p.name + (p.uid === auth.currentUser.uid ? ' (YOU)' : '');
                    playersList.appendChild(div);
                });
            }, err => handleFirestoreError(err, OperationType.LIST, `sessions/${sessionId}/players`));
            
            // Listen for session status
            if (lobbyUnsubscribe) lobbyUnsubscribe();
            lobbyUnsubscribe = onSnapshot(doc(db, 'sessions', sessionId), docSnap => {
                const session = docSnap.data();
                if (session && session.status === 'starting') {
                    gameMode = 'MULTIPLAYER';
                    startLoadingScreen(session.trackId);
                }
            }, err => handleFirestoreError(err, OperationType.GET, `sessions/${sessionId}`));
        }

        function leaveLobby() {
            const { doc, deleteDoc } = window.firebaseModular;
            lastMultiplayerSyncTime = 0;
            if (playersUnsubscribe) playersUnsubscribe();
            if (lobbyUnsubscribe) lobbyUnsubscribe();
            if (multiplayerSessionId && auth.currentUser) {
                const playerPath = `sessions/${multiplayerSessionId}/players/${auth.currentUser.uid}`;
                deleteDoc(doc(db, 'sessions', multiplayerSessionId, 'players', auth.currentUser.uid))
                    .catch(err => handleFirestoreError(err, OperationType.DELETE, playerPath));
            }
            multiplayerSessionId = null;
            multiplayerSessionCode = null;
            openMainMenu();
        }

        function startMultiplayerGame() {
            const { doc, updateDoc } = window.firebaseModular;
            if (!isHost || !multiplayerSessionId) return;
            const sessionPath = `sessions/${multiplayerSessionId}`;
            updateDoc(doc(db, 'sessions', multiplayerSessionId), { status: 'starting' })
                .catch(err => handleFirestoreError(err, OperationType.UPDATE, sessionPath));
        }

        const MULTIPLAYER_SYNC_INTERVAL_MS = 80;
        let lastMultiplayerSyncTime = 0;

        function syncMultiplayerState() {
            const { doc, updateDoc } = window.firebaseModular;
            if (!multiplayerSessionId || !auth.currentUser || !player) return;
            const now = Date.now();
            if (now - lastMultiplayerSyncTime < MULTIPLAYER_SYNC_INTERVAL_MS) return;
            lastMultiplayerSyncTime = now;

            const playerPath = `sessions/${multiplayerSessionId}/players/${auth.currentUser.uid}`;
            updateDoc(doc(db, 'sessions', multiplayerSessionId, 'players', auth.currentUser.uid), {
                x: player.x,
                y: player.y,
                angle: player.angle,
                speed: player.speed,
                lap: player.lap,
                distanceDriven: player.distanceDriven,
                isFinished: player.finished
            }).catch(err => handleFirestoreError(err, OperationType.UPDATE, playerPath));
        }

        // --- Global Game Config & State ---
        let gameMode = 'QUICK_RACE';
        let cupState = { round: 1, tracks: [] };
        
        let gpState = { trackIndex: 0, tracks: [], standings: [] };
        const GP_POINTS = [15, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
        let droneView = {
            mapIndex: 0,
            centerX: 0,
            centerY: 0,
            zoom: 1,
            minZoom: 0.06,
            maxZoom: 1.8,
            fitZoom: 1
        };

        function getWaypointBounds(waypoints) {
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            (waypoints || []).forEach(wp => {
                minX = Math.min(minX, wp.x); maxX = Math.max(maxX, wp.x);
                minY = Math.min(minY, wp.y); maxY = Math.max(maxY, wp.y);
            });
            if (!Number.isFinite(minX)) {
                minX = 0; maxX = 0; minY = 0; maxY = 0;
            }
            return {
                minX,
                maxX,
                minY,
                maxY,
                width: Math.max(1, maxX - minX),
                height: Math.max(1, maxY - minY),
                centerX: (minX + maxX) / 2,
                centerY: (minY + maxY) / 2
            };
        }

        function clamp(value, min, max) {
            return Math.max(min, Math.min(max, value));
        }

        function getMapPreviewDescription(index) {
            let raw = trackDescriptions[index] || 'Solo scouting and time attack ready.';
            let firstSentence = raw.split('. ')[0] || raw;
            return firstSentence.endsWith('.') ? firstSentence : firstSentence + '.';
        }

        function getMapStats(map) {
            if (!map || !map.waypoints || map.waypoints.length < 2) return null;
            const wps = map.waypoints;
            // Track length (sum of segment distances, scaled to approximate meters)
            let totalDist = 0;
            for (let i = 0; i < wps.length; i++) {
                const a = wps[i], b = wps[(i + 1) % wps.length];
                totalDist += Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));
            }
            // Approximate meters: 1 world unit ≈ 0.04m at racing scale
            const lengthM = Math.round(totalDist * 0.04 / 100) * 100;
            // Corner count: count direction changes > 20 degrees
            let corners = 0;
            for (let i = 0; i < wps.length; i++) {
                const prev = wps[(i - 1 + wps.length) % wps.length];
                const curr = wps[i];
                const next = wps[(i + 1) % wps.length];
                const a1 = Math.atan2(curr.y - prev.y, curr.x - prev.x);
                const a2 = Math.atan2(next.y - curr.y, next.x - curr.x);
                let diff = Math.abs(a2 - a1);
                if (diff > Math.PI) diff = Math.PI * 2 - diff;
                if (diff > 0.35) corners++;
            }
            // Difficulty: based on corner density and length
            const density = corners / (lengthM / 100 || 1);
            let difficulty, diffColor;
            if (density < 0.8)       { difficulty = 'EASY';   diffColor = '#27ae60'; }
            else if (density < 1.4)  { difficulty = 'MEDIUM'; diffColor = '#f39c12'; }
            else if (density < 2.2)  { difficulty = 'HARD';   diffColor = '#e74c3c'; }
            else                     { difficulty = 'EXPERT'; diffColor = '#9b59b6'; }
            // Biome tag from theme
            let biome = 'CIRCUIT';
            const bg = (map.theme.bgOuter || '').toLowerCase();
            if (bg.includes('4a7c') || bg.includes('3d7a') || bg.includes('4caf')) biome = 'GRASS';
            else if (bg.includes('d4b') || bg.includes('c4a')) biome = 'DESERT';
            else if (bg.includes('808') || bg.includes('646')) biome = 'URBAN';
            else if (bg.includes('7a6') || bg.includes('8b7')) biome = 'MOUNTAIN';
            else if (bg.includes('e8d') || bg.includes('e8d5')) biome = 'COASTAL';
            else if (bg.includes('050') || bg.includes('0a0')) biome = 'NEON';
            else if (bg.includes('4caf')) biome = 'GRASS';
            return { lengthM, corners, difficulty, diffColor, biome };
        }

        function buildMapPreviewCanvas(map, width = 140, height = 100) {
            const mCanv = document.createElement('canvas');
            mCanv.className = 'map-canvas';
            mCanv.width = width;
            mCanv.height = height;
            let mCtx = mCanv.getContext('2d');
            let bounds = getWaypointBounds(map.waypoints);
            let scale = Math.min((width - 20) / bounds.width, (height - 20) / bounds.height);

            mCtx.fillStyle = map.theme.bgOuter;
            mCtx.fillRect(0, 0, width, height);

            mCtx.translate(width / 2, height / 2);
            mCtx.scale(scale, scale);
            mCtx.translate(-bounds.centerX, -bounds.centerY);

            mCtx.beginPath();
            mCtx.moveTo(map.waypoints[0].x, map.waypoints[0].y);
            for(let i=1; i<map.waypoints.length; i++) mCtx.lineTo(map.waypoints[i].x, map.waypoints[i].y);
            mCtx.closePath();

            mCtx.lineWidth = 10; mCtx.lineJoin = 'round'; mCtx.strokeStyle = map.theme.border; mCtx.stroke();

            if (map.theme.barrierColor) {
                mCtx.lineWidth = 6; mCtx.strokeStyle = map.theme.barrierColor;
                if (map.theme.barrierDash) mCtx.setLineDash(map.theme.barrierDash.map(d => d/4));
                mCtx.stroke();
                mCtx.setLineDash([]);
            }

            mCtx.lineWidth = 4; mCtx.strokeStyle = map.theme.track; mCtx.stroke();
            return mCanv;
        }

        function getDroneViewBounds() {
            if (activeWaypoints && activeWaypoints.length) ensureTrackRenderCache();
            let baseBounds = activeWaypoints && activeWaypoints.length ? (trackPathCache.bounds || getWaypointBounds(activeWaypoints)) : getWaypointBounds(mapsData[droneView.mapIndex].waypoints);
            let padding = Math.max(900, config.trackWidth * 3.5);
            return {
                minX: baseBounds.minX - padding,
                maxX: baseBounds.maxX + padding,
                minY: baseBounds.minY - padding,
                maxY: baseBounds.maxY + padding,
                width: baseBounds.width + padding * 2,
                height: baseBounds.height + padding * 2,
                centerX: baseBounds.centerX,
                centerY: baseBounds.centerY
            };
        }

        function updateDroneOverlay() {
            const title = document.getElementById('drone-view-title');
            const subtitle = document.getElementById('drone-view-subtitle');
            const zoomEl = document.getElementById('drone-view-zoom');
            let map = mapsData[droneView.mapIndex];
            let titleText = map ? `DRONE VIEW - ${map.name.toUpperCase()}` : 'DRONE VIEW';
            let subtitleText = map ? getMapPreviewDescription(droneView.mapIndex) : '';
            let zoomText = Math.round(droneView.zoom * 100) + '%';
            if (title && droneOverlayCache.title !== titleText) {
                title.textContent = titleText;
                droneOverlayCache.title = titleText;
            }
            if (subtitle && droneOverlayCache.subtitle !== subtitleText) {
                subtitle.textContent = subtitleText;
                droneOverlayCache.subtitle = subtitleText;
            }
            if (zoomEl && droneOverlayCache.zoom !== zoomText) {
                zoomEl.textContent = zoomText;
                droneOverlayCache.zoom = zoomText;
            }
        }

        function fitDroneView() {
            if (!mapsData[droneView.mapIndex]) return;
            let bounds = getDroneViewBounds();
            let fitZoom = Math.min(canvas.width / bounds.width, canvas.height / bounds.height);
            droneView.fitZoom = clamp(fitZoom, droneView.minZoom, droneView.maxZoom);
            droneView.zoom = droneView.fitZoom;
            droneView.centerX = bounds.centerX;
            droneView.centerY = bounds.centerY;
            updateDroneOverlay();
        }

        function clampDroneView() {
            let bounds = getDroneViewBounds();
            let halfW = canvas.width / (2 * droneView.zoom);
            let halfH = canvas.height / (2 * droneView.zoom);
            if (bounds.width <= halfW * 2) droneView.centerX = bounds.centerX;
            else droneView.centerX = clamp(droneView.centerX, bounds.minX + halfW, bounds.maxX - halfW);
            if (bounds.height <= halfH * 2) droneView.centerY = bounds.centerY;
            else droneView.centerY = clamp(droneView.centerY, bounds.minY + halfH, bounds.maxY - halfH);
        }

        function adjustDroneZoom(multiplier) {
            if (gameState !== 'DRONE_VIEW') return;
            droneView.zoom = clamp(droneView.zoom * multiplier, droneView.minZoom, droneView.maxZoom);
            clampDroneView();
            updateDroneOverlay();
        }

        function prepareDroneViewMap(mapIndex) {
            currentMapIndex = mapIndex;
            droneView.mapIndex = mapIndex;
            window.mapVariant = 'NORMAL';
            activeWaypoints = [...mapsData[mapIndex].waypoints];
            rebuildTrackRenderCache();
            resetUiRenderCaches();
            generateScenery(mapIndex);
            cars = [];
            player = null;
            player2 = null;
            finishOrder = [];
            raceEndTime = null;
            spectateTarget = -1;
            flyoverObj = null;
            lightningStrikes = [];
            movingHazards = [];
            zoneHazards = [];
            itemBoxes = [];
            projectiles = [];
            traps = [];
            coins = [];
            puddles = [];
            fx.particles = [];
            fx.skidMarks = [];
            fx.ripples = [];
            audio.updateEngine(0, false);
            audio.setScreech(false);
            audio.stopRain();
        }

        function openGrandPrix() {
            gameMode = 'GRAND_PRIX';
            playerBestLap = Infinity;
            audio.init();
            audio.startMusic('menu');
            gameState = 'CAR_SELECT';
            showScreen('car-select-menu');
        }

        function initGrandPrix() {
            generateOpponents(true);
            let pool = [0,1,2,3,4,5,6,7,8,9];
            gpState.tracks = [];
            for(let i=0; i<4; i++) {
                let idx = Math.floor(Math.random() * pool.length);
                gpState.tracks.push(pool.splice(idx, 1)[0]);
            }
            gpState.trackIndex = 0;
            gpState.standings = cars.map(c => ({ id: c.id, points: 0, color: c.color, isPlayer: c.isPlayer }));
            config.totalLaps = 3;
            startLoadingScreen(gpState.tracks[0]);
        }

        function gpNextRace() {
            gpState.trackIndex++;
            if (gpState.trackIndex < gpState.tracks.length) {
                startLoadingScreen(gpState.tracks[gpState.trackIndex]);
            } else {
                showGPPodium();
            }
        }

        function updateGPStandings() {
            racePositions.forEach((c, i) => {
                let s = gpState.standings.find(st => st.id === c.id);
                if (s) s.points += GP_POINTS[Math.min(i, GP_POINTS.length - 1)];
            });
            gpState.standings.sort((a, b) => b.points - a.points);
        }

        function showGPStandings() {
            screens.classList.remove('hidden');
            document.querySelectorAll('.screen-panel').forEach(p => p.classList.add('hidden'));
            document.getElementById('gp-standings-screen').classList.remove('hidden');
            uiLayer.classList.add('hidden');

            document.getElementById('gp-track-info').innerText = `Race ${gpState.trackIndex + 1} of ${gpState.tracks.length} Complete`;
            
            let list = document.getElementById('gp-standings-list');
            list.innerHTML = gpState.standings.map((s, i) => `
                <div style="display: flex; justify-content: space-between; padding: 10px; border-bottom: 1px solid #333; color: ${s.color}; font-weight: bold;">
                    <span>${i+1}. ${s.id} ${s.isPlayer ? '(YOU)' : ''}</span>
                    <span>${s.points} PTS</span>
                </div>
            `).join('');

            let nextBtn = document.getElementById('gp-next-btn');
            if (gpState.trackIndex === gpState.tracks.length - 1) {
                nextBtn.innerText = "View Final Results";
            } else {
                nextBtn.innerText = "Next Race";
            }
        }

        function showGPPodium() {
            showScreen('gp-podium-screen');
            let container = document.getElementById('gp-podium-container');
            container.innerHTML = '';
            
            let top3 = gpState.standings.slice(0, 3);
            let orders = [1, 0, 2]; // Silver, Gold, Bronze
            let heights = [120, 160, 100];
            let labels = ['2nd', '1st', '3rd'];
            let colors = ['#C0C0C0', '#FFD700', '#CD7F32'];

            orders.forEach(i => {
                let s = top3[i];
                if (!s) return;
                let step = document.createElement('div');
                step.className = 'podium-step';
                step.style.height = heights[i] + 'px';
                step.style.background = colors[i];
                step.innerHTML = `
                    <div class="podium-label" style="top: -100px; width: 120px; left: 50%; transform: translateX(-50%); position: absolute; text-align: center;">
                        <div style="color: ${s.color}; font-weight: 900; font-size: 18px; margin-bottom: 10px;">${s.id}</div>
                        <div style="color: #fff; font-size: 24px; font-weight: 900;">${labels[i]}</div>
                        <div style="color: rgba(255,255,255,0.8); font-size: 14px;">${s.points} PTS</div>
                    </div>
                `;
                container.appendChild(step);
            });
            
            if (top3[0] && top3[0].isPlayer) audio.playYouWin();
            else audio.victory();
        }

        
        const config = {
            trackWidth: 220,
            totalLaps: 3,
            fps: 60,
            grassFriction: 0.97,
            trackFriction: 0.98,
            difficulty: 'Normal',
            weather: 'Clear',
            opponentCount: 3
        };

        let cars = [];
        let player;
        let player2 = null;
        let keys = {};
        let camera = { x: 0, y: 0, rotation: 0, viewWidth: canvas.width, viewHeight: canvas.height, zoom: 1 };
        let cameraShake = 0; // GLOBAL CAMERA SHAKE TRAUMA
        let cameraShakeX = 0;
        let cameraShakeY = 0;
        let showMinimap = true;

        // Intro Camera Pan Sequence variables
        let introPanDuration = 0;
        let introPanStartTime = 0;
        let panStartX = 0, panStartY = 0, panEndX = 0, panEndY = 0;
        let introSilenceStartTime = 0;

        let gameState = 'ASSET_LOADING'; 
        let startTime = 0;
        let elapsedTime = 0;
        let racePositions = [];
        let finishOrder = [];
        let raceEndTime = null;
        let spectateTarget = -1;
        let currentMapIndex = 0;
        let activeWaypoints = [];
        let activeScenery = [];
        let itemBoxes = [];
        let projectiles = [];
        let traps = [];
        let movingHazards = [];
        let zoneHazards = [];
        let lightningStrikes = [];
        let coins = [];
        let raceCoins = 0;
        let raceCoins2 = 0;
        let playerCoins = parseInt(localStorage.getItem('webRacers_coins') || '0');
        let playerUpgrades = JSON.parse(localStorage.getItem('webRacers_upgrades') || '{"speed":0, "accel":0, "handling":0, "nitro":0}'); 
        let flyoverObj = null;
        let loadingInterval = null;
        
        let puddles = [];
        let lightningTimer = 0;
        let lightningFlash = 0;
        let puddleRippleTimer = 0;

        let playerBestLap = Infinity;
        let playerLapStartTime = 0;
        let bestLapBannerTimeout = null;

        // Attract Mode (Demo Race) variables
        let attractMode = {
            isActive: false,
            inactivityTimer: null,
            inactivityDuration: 20000, // 20 seconds
            lastActivityTime: Date.now()
        };

        // Open World Mode variables
        let openWorldMode = {
            isActive: false,
            currentRegion: null,
            loadedRegions: [],
            trafficCars: [],
            worldCoins: [],
            garageLocations: [],
            raceStartLocations: [],
            // Transition effect state
            transitionAlpha: 0,       // 0=none, goes to 1 then fades back
            transitionDir: 0,         // 1=fading in, -1=fading out
            transitionPendingRegion: null, // region to switch to when fully black
            // Region name banner
            regionBannerAlpha: 0,
            regionBannerText: '',
            regionBannerTimer: 0
        };

        const ALWAYS_RENDER_SCENERY_TYPES = new Set(['rect', 'cliff_face', 'runway_markings']);
        const NO_SHADOW_SCENERY_TYPES = new Set(['circle', 'sand_dots', 'animated_wave', 'wave', 'fence_post', 'runway_light', 'seagull', 'crosswalk', 'rect', 'cliff_face', 'runway_markings', 'streetlight', 'road_median', 'cracked_ground', 'airport_floor', 'terminal_glass', 'jetbridge', 'airport_shop', 'airport_bathroom', 'airport_terminal_door']);
        const LOW_DETAIL_DRONE_SCENERY_TYPES = new Set(['fence_post', 'runway_light', 'circle', 'desert_scrub', 'cracked_ground', 'seagull', 'streetlight']);
        let trackPathCache = { waypoints: null, mapIndex: -1, path: null, bounds: null };
        let minimapCache = { waypoints: null, canvasWidth: 0, canvasHeight: 0, path: null, scale: 1, centerX: 0, centerY: 0, xOffset: 0, yOffset: 0, size: 150 };
        let hudRenderCache = { speed: null, time: null, lap: null, posText: null, posColor: null, positionSignature: '', offroad: null, raceEndVisible: null, raceEndSeconds: null, nitroWidth: null, nitroClass: null };
        let droneOverlayCache = { title: null, subtitle: null, zoom: null };

        function buildClosedTrackPath(waypoints) {
            if (!waypoints || !waypoints.length) return null;
            const path = new Path2D();
            path.moveTo(waypoints[0].x, waypoints[0].y);
            for (let i = 1; i < waypoints.length; i++) {
                path.lineTo(waypoints[i].x, waypoints[i].y);
            }
            path.closePath();
            return path;
        }

        function rebuildTrackRenderCache() {
            trackPathCache.waypoints = activeWaypoints;
            trackPathCache.mapIndex = currentMapIndex;
            trackPathCache.bounds = getWaypointBounds(activeWaypoints);
            trackPathCache.path = buildClosedTrackPath(activeWaypoints);
            minimapCache.waypoints = null;
            minimapCache.path = null;
        }

        function ensureTrackRenderCache() {
            if (!trackPathCache.path || trackPathCache.waypoints !== activeWaypoints || trackPathCache.mapIndex !== currentMapIndex) {
                rebuildTrackRenderCache();
            }
        }

        function ensureMinimapCache() {
            if (!activeWaypoints || !activeWaypoints.length) return null;
            ensureTrackRenderCache();
            if (minimapCache.path && minimapCache.waypoints === activeWaypoints && minimapCache.canvasWidth === canvas.width && minimapCache.canvasHeight === canvas.height) {
                return minimapCache;
            }

            const size = 150;
            const padding = 20;
            const xOffset = canvas.width - size - padding;
            const yOffset = padding;
            const bounds = trackPathCache.bounds || getWaypointBounds(activeWaypoints);
            const scale = Math.min(size / (bounds.width || 1), size / (bounds.height || 1)) * 0.8;
            const cx = xOffset + size / 2;
            const cy = yOffset + size / 2;
            const path = new Path2D();

            path.moveTo(cx + (activeWaypoints[0].x - bounds.centerX) * scale, cy + (activeWaypoints[0].y - bounds.centerY) * scale);
            for (let i = 1; i < activeWaypoints.length; i++) {
                path.lineTo(cx + (activeWaypoints[i].x - bounds.centerX) * scale, cy + (activeWaypoints[i].y - bounds.centerY) * scale);
            }
            path.closePath();

            minimapCache = {
                waypoints: activeWaypoints,
                canvasWidth: canvas.width,
                canvasHeight: canvas.height,
                path,
                scale,
                centerX: bounds.centerX,
                centerY: bounds.centerY,
                xOffset,
                yOffset,
                size
            };
            return minimapCache;
        }

        function getWorldViewBounds(extraPadding = 0) {
            const camX = camera.x + cameraShakeX;
            const camY = camera.y + cameraShakeY;
            const viewWidth = gameState === 'DRONE_VIEW' ? canvas.width / Math.max(droneView.zoom, 0.08) : (camera.viewWidth || canvas.width);
            const viewHeight = gameState === 'DRONE_VIEW' ? canvas.height / Math.max(droneView.zoom, 0.08) : (camera.viewHeight || canvas.height);
            const rotation = gameState === 'DRONE_VIEW' ? 0 : Math.abs(camera.rotation || 0);
            const cos = Math.abs(Math.cos(rotation));
            const sin = Math.abs(Math.sin(rotation));
            const aabbWidth = viewWidth * cos + viewHeight * sin;
            const aabbHeight = viewWidth * sin + viewHeight * cos;
            const centerX = camX + viewWidth / 2;
            const centerY = camY + viewHeight / 2;
            return {
                minX: centerX - aabbWidth / 2 - extraPadding,
                maxX: centerX + aabbWidth / 2 + extraPadding,
                minY: centerY - aabbHeight / 2 - extraPadding,
                maxY: centerY + aabbHeight / 2 + extraPadding
            };
        }

        function getHeadingFollowCameraRotation(car) {
            if (!car || gameMode === 'LOCAL_MULTIPLAYER' || gameState === 'DRONE_VIEW') return 0;
            let speedFactor = Math.max(0, Math.min(1, (Math.abs(car.speed) - 1) / Math.max(car.maxSpeed * 0.7, 1)));
            if (speedFactor <= 0.02) return 0;
            let targetRotation = normalizeAngle((-Math.PI / 2) - car.angle);
            if (car.speed < -0.5) targetRotation = normalizeAngle(targetRotation + Math.PI);
            let followStrength = 0.28 + speedFactor * 0.72;
            if (car.isOffRoad) followStrength *= 0.74;
            if (car.isDrifting) followStrength *= 0.82;
            return normalizeAngle(targetRotation) * Math.min(1, followStrength);
        }

        function getSceneryCullRadius(s) {
            if (s.type === 'seagull') return 2200;
            let size = 80;
            if (s.w) size = Math.max(size, s.w * 0.6);
            if (s.h) size = Math.max(size, s.h * 0.6);
            if (s.r) size = Math.max(size, s.r);
            if (s.rx) size = Math.max(size, s.rx);
            if (s.ry) size = Math.max(size, s.ry);
            if (s.length) size = Math.max(size, 220);
            if (s.s) size = Math.max(size, s.s);
            return size + 120;
        }

        function resetHudRenderCache() {
            hudRenderCache.speed = null;
            hudRenderCache.time = null;
            hudRenderCache.lap = null;
            hudRenderCache.posText = null;
            hudRenderCache.posColor = null;
            hudRenderCache.positionSignature = '';
            hudRenderCache.offroad = null;
            hudRenderCache.raceEndVisible = null;
            hudRenderCache.raceEndSeconds = null;
            hudRenderCache.nitroWidth = null;
            hudRenderCache.nitroClass = null;
        }

        function resetUiRenderCaches() {
            minimapCache.waypoints = null;
            minimapCache.path = null;
            resetHudRenderCache();
            droneOverlayCache.title = null;
            droneOverlayCache.subtitle = null;
            droneOverlayCache.zoom = null;
        }

        // --- Car Types ---
        const carTypes = [
            { name: "SPEEDSTER", color: "#ff0033", maxSpeed: 20, baseAcceleration: 0.3, turnSpeed: 0.05, stats: { speed: 5, accel: 3, handling: 2 } },
            { name: "GRIP KING", color: "#009fff", maxSpeed: 15, baseAcceleration: 0.25, turnSpeed: 0.09, stats: { speed: 3, accel: 3, handling: 5 } },
            { name: "BALANCED", color: "#39ff14", maxSpeed: 17, baseAcceleration: 0.28, turnSpeed: 0.07, stats: { speed: 4, accel: 4, handling: 4 } },
            { name: "TANK", color: "#a200ff", maxSpeed: 13, baseAcceleration: 0.4, turnSpeed: 0.06, stats: { speed: 2, accel: 5, handling: 3 } }
        ];
        let selectedCarIndex = 2; // Default to Balanced
        let selectedCarIndex2 = 2; 
        let playerCustomColor = null;
        let playerCustomColor2 = null;
        let playerCustomEffect = 'None';
        let playerDisplayName = null;

        function updateCustomColor(color) {
            if (window.isP2Selecting) {
                playerCustomColor2 = color;
            } else {
                playerCustomColor = color;
            }
        }

        function setCarEffect(effect, btn) {
            playerCustomEffect = effect;
            document.querySelectorAll('#effect-options .btn-neon').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        }

        // --- AI Tiers ---
        const AI_TIERS = [
            { name: 'ROOKIE', class: 'rookie', speedMult: 0.7, accelMult: 0.7, turnMult: 0.8, names: ['Roxy', 'Dex', 'Pip', 'Nova'] },
            { name: 'RACER', class: 'racer', speedMult: 0.9, accelMult: 0.9, turnMult: 0.95, names: ['Kai', 'Zara', 'Ace', 'Finn'] },
            { name: 'PRO', class: 'pro', speedMult: 1.0, accelMult: 1.0, turnMult: 1.0, names: ['Blaze', 'Vex', 'Storm', 'Cruz'] },
            { name: 'RIVAL', class: 'rival', speedMult: 1.15, accelMult: 1.15, turnMult: 1.1, names: ['GHOST', 'NEMESIS', 'APEX', 'TITAN'] }
        ];
        const AI_COLORS = ['#ff00ea', '#009fff', '#fbc531', '#ff3333', '#a200ff', '#ff9933', '#ffffff', '#cccccc', '#ff00aa', '#00ffaa', '#aa00ff', '#ffff00', '#ff0055', '#5500ff', '#0055ff', '#39ff14'];
        let opponents = [];

        // --- Helper Function ---
        function formatTime(timeMs) {
            if (timeMs === Infinity) return '--:--.--';
            let ms = Math.floor((timeMs % 1000) / 10);
            let sec = Math.floor((timeMs / 1000) % 60);
            let min = Math.floor((timeMs / 60000));
            return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
        }

        // --- Particle System (Skids, Exhaust, Drift Smoke, Nitro, Ripples) ---
        class ParticleSystem {
            constructor() {
                this.particles = [];
                this.skidMarks = [];
                this.ripples = [];
            }

            addSkidMark(x, y, angle) {
                while (this.skidMarks.length >= 300) {
                    this.skidMarks.shift();
                }
                this.skidMarks.push({ x, y, angle, life: 180, maxLife: 180 });
            }

            addParticle(x, y, vx, vy, radius, color, life, expanding) {
                if (this.particles.length >= 220) {
                    this.particles.shift();
                }
                this.particles.push({ x, y, vx, vy, radius, color, life, maxLife: life, expanding });
            }

            addRipple(x, y) {
                if (this.ripples.length >= 48) {
                    this.ripples.shift();
                }
                this.ripples.push({x, y, radius: 5, maxRadius: 30, life: 30, maxLife: 30});
            }

            update() {
                for (let i = this.skidMarks.length - 1; i >= 0; i--) {
                    this.skidMarks[i].life--;
                    if (this.skidMarks[i].life <= 0) this.skidMarks.splice(i, 1);
                }
                for (let i = this.particles.length - 1; i >= 0; i--) {
                    let p = this.particles[i];
                    p.x += p.vx;
                    p.y += p.vy;
                    if (p.expanding) p.radius += 0.2;
                    p.life--;
                    if (p.life <= 0) this.particles.splice(i, 1);
                }
                for(let i=this.ripples.length-1; i>=0; i--) {
                    this.ripples[i].radius += (30 - 5) / 30;
                    this.ripples[i].life--;
                    if(this.ripples[i].life <= 0) this.ripples.splice(i, 1);
                }
            }

            drawSkidMarks(ctx) {
                this.skidMarks.forEach(sm => {
                    let alpha = sm.life < 60 ? (sm.life / 60) * 0.3 : 0.3;
                    ctx.save();
                    ctx.translate(sm.x, sm.y);
                    ctx.rotate(sm.angle);
                    ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
                    ctx.fillRect(-2, -4, 4, 8);
                    ctx.restore();
                });

            }

            drawParticles(ctx) {
                this.particles.forEach(p => {
                    ctx.save();
                    let lifeAlpha = p.life / p.maxLife;
                    let coreRadius = Math.max(0.1, p.radius);
                    ctx.translate(p.x, p.y);
                    ctx.globalAlpha = lifeAlpha * 0.4;
                    ctx.shadowColor = p.color;
                    ctx.shadowBlur = coreRadius * 3.5;
                    ctx.fillStyle = p.color;
                    ctx.beginPath();
                    ctx.arc(0, 0, coreRadius * 1.45, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.globalAlpha = lifeAlpha;
                    ctx.beginPath();
                    ctx.arc(0, 0, coreRadius, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.globalAlpha = lifeAlpha * 0.32;
                    ctx.fillStyle = 'rgba(255,255,255,0.92)';
                    ctx.beginPath();
                    ctx.arc(-coreRadius * 0.2, -coreRadius * 0.2, Math.max(0.1, coreRadius * 0.45), 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                });
            }

            drawRipples(ctx) {
                this.ripples.forEach(r => {
                    ctx.save();
                    ctx.beginPath();
                    ctx.arc(r.x, r.y, r.radius, 0, Math.PI*2);
                    ctx.strokeStyle = `rgba(255,255,255, ${r.life / r.maxLife * 0.5})`;
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                    ctx.restore();
                });
            }
        }
        const fx = new ParticleSystem();
        // --- Audio System (Pure Web Audio API / Tone.js Synthesizers) ---
        var audio = {
            isInit: false,
            muted: false,
            
            musicInterval: null,
            currentTrack: null,
            currentBeat: 0,
            nextNoteTime: 0,
            menuAudioElement: null,
            phxAudioElement: null,
            loadingAudioElement: null,

            init() {
                if (Tone.context.state !== 'running') {
                    Tone.start();
                }
                if (!this.raceAudioElements) {
                    const files = ['Noon_on_the_Oval.mp3', 'figure-8.mp3', 'city circut.mp3', 'desert speedway.mp3', 'mountainpass.mp3', 'seasidecircut.mp3', 'technical track.mp3', 'PHX.mp3', 'mini-monaco.mp3', 'infinity loop.mp3'];
                    this.raceAudioElements = files.map(f => { let a = new Audio(f); a.loop = true; return a; });
                }
                if (!this.menuAudioElement) {
                    this.menuAudioElement = new Audio('The_Final_Turn.mp3');
                    this.menuAudioElement.loop = true;
                }
                if (!this.phxAudioElement) {
                    this.phxAudioElement = new Audio('PHX.mp3');
                    this.phxAudioElement.loop = true;
                }
                if (!this.loadingAudioElement) {
                    this.loadingAudioElement = new Audio('loading.mp3');
                    this.loadingAudioElement.loop = true;
                }
                if (!this.engineOsc) {
                    this.engineOsc = new Tone.Oscillator(40, "sawtooth").start();
                    this.engineFilter = new Tone.Filter(200, "lowpass").toDestination();
                    this.engineOsc.connect(this.engineFilter);
                    this.engineOsc.volume.value = -Infinity;

                    // Second oscillator for harmonic richness per vehicle type
                    this.engineOsc2 = new Tone.Oscillator(60, "triangle").start();
                    this.engineOsc2.connect(this.engineFilter);
                    this.engineOsc2.volume.value = -Infinity;

                    this.screechNoise = new Tone.Noise("pink").start();
                    this.screechFilter = new Tone.Filter(1000, "highpass").toDestination();
                    this.screechNoise.connect(this.screechFilter);
                    this.screechNoise.volume.value = -Infinity;

                    // Engine sound profiles per car type
                    this.engineProfiles = {
                        SPEEDSTER:   { wave: 'sawtooth', baseFreq: 55, freqMult: 8, filterBase: 300, filterMult: 70, vol: -8,  wave2: 'square',   freq2Ratio: 1.5, vol2: -18 },
                        'GRIP KING': { wave: 'triangle', baseFreq: 45, freqMult: 6, filterBase: 250, filterMult: 55, vol: -10, wave2: 'sine',     freq2Ratio: 2.0, vol2: -16 },
                        BALANCED:    { wave: 'sawtooth', baseFreq: 40, freqMult: 5, filterBase: 200, filterMult: 50, vol: -10, wave2: 'triangle',  freq2Ratio: 1.5, vol2: -20 },
                        TANK:        { wave: 'square',   baseFreq: 28, freqMult: 3, filterBase: 150, filterMult: 40, vol: -6,  wave2: 'sawtooth',  freq2Ratio: 0.5, vol2: -14 }
                    };
        window.audio = audio;
                    this.activeEngineProfile = this.engineProfiles.BALANCED;
                }
            },

            async loadAssets(onProgress, onComplete) {
                if (this.isInit) {
                    if (onProgress) onProgress('All systems online!', 100);
                    if (onComplete) setTimeout(onComplete, 0);
                    return;
                }
                try {
                    await Tone.start();

                    this.musicVolumeNode = new Tone.Volume(0).toDestination();
                    if (this.muted) Tone.Destination.mute = true;

                    let steps = 10;
                    for (let i = 1; i <= steps; i++) {
                        if (onProgress) onProgress(`Synthesizing internal instruments...`, (i / steps) * 100);
                        await new Promise(r => setTimeout(r, 40)); 
                    }
                    
                    this.synths = {
                        piano: new Tone.PolySynth(Tone.Synth, {
                            oscillator: { type: "triangle" },
                            envelope: { attack: 0.01, decay: 0.5, sustain: 0.2, release: 1 }
                        }).connect(this.musicVolumeNode),
                        
                        trumpet: new Tone.PolySynth(Tone.Synth, {
                            oscillator: { type: "sawtooth" },
                            envelope: { attack: 0.05, decay: 0.2, sustain: 0.8, release: 0.5 }
                        }),
                        
                        trombone: new Tone.Synth({
                            oscillator: { type: "sawtooth" },
                            envelope: { attack: 0.1, decay: 0.3, sustain: 0.8, release: 0.5 },
                            portamento: 0.1
                        }),
                        
                        tuba: new Tone.Synth({
                            oscillator: { type: "fmsawtooth" },
                            envelope: { attack: 0.2, decay: 0.4, sustain: 0.8, release: 0.5 }
                        }),
                        
                        violin: new Tone.Synth({
                            oscillator: { type: "sawtooth" },
                            envelope: { attack: 0.2, decay: 0.1, sustain: 0.9, release: 0.8 }
                        }),
                        
                        cello: new Tone.Synth({
                            oscillator: { type: "sawtooth" },
                            envelope: { attack: 0.25, decay: 0.2, sustain: 0.9, release: 1.0 }
                        }),
                        
                        flute: new Tone.Synth({
                            oscillator: { type: "sine" },
                            envelope: { attack: 0.1, decay: 0.1, sustain: 0.9, release: 0.5 }
                        }),
                        
                        electricBass: new Tone.Synth({
                            oscillator: { type: "triangle" },
                            envelope: { attack: 0.01, decay: 0.3, sustain: 0.4, release: 0.5 }
                        }).connect(this.musicVolumeNode),
                        
                        synthBass: new Tone.Synth({
                            oscillator: { type: "square" },
                            envelope: { attack: 0.01, decay: 0.2, sustain: 0.2, release: 0.4 }
                        }),
                        
                        brassSection: new Tone.PolySynth(Tone.Synth, {
                            oscillator: { type: "sawtooth" },
                            envelope: { attack: 0.05, decay: 0.2, sustain: 0.8, release: 0.5 }
                        }),
                        
                        orchestraHit: new Tone.PolySynth(Tone.Synth, {
                            oscillator: { type: "fmsquare" },
                            envelope: { attack: 0.01, decay: 0.2, sustain: 0.1, release: 0.5 }
                        }).connect(this.musicVolumeNode),
                        
                        kickDrum: new Tone.MembraneSynth({
                            pitchDecay: 0.05, octaves: 4, oscillator: { type: "sine" },
                            envelope: { attack: 0.001, decay: 0.4, sustain: 0.01, release: 1.4, attackCurve: "exponential" }
                        }).connect(this.musicVolumeNode),
                        
                        snareDrum: new Tone.NoiseSynth({
                            noise: { type: "white" },
                            envelope: { attack: 0.001, decay: 0.2, sustain: 0, release: 0.2 }
                        }).connect(this.musicVolumeNode),
                        
                        hihat: new Tone.MetalSynth({
                            frequency: 200, envelope: { attack: 0.001, decay: 0.1, release: 0.01 },
                            harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5
                        }).connect(this.musicVolumeNode),
                        
                        cymbal: new Tone.MetalSynth({
                            frequency: 200, envelope: { attack: 0.001, decay: 1.4, release: 0.2 },
                            harmonicity: 5.1, modulationIndex: 32, resonance: 4000, octaves: 1.5
                        }).connect(this.musicVolumeNode),
                        
                        taikoDrum: new Tone.MembraneSynth({
                            pitchDecay: 0.08, octaves: 2, oscillator: { type: "triangle" },
                            envelope: { attack: 0.01, decay: 0.8, sustain: 0.1, release: 1.4 }
                        }).connect(this.musicVolumeNode),
                        
                        woodblock: new Tone.MembraneSynth({
                            pitchDecay: 0.01, octaves: 1.5, oscillator: { type: "sine" },
                            envelope: { attack: 0.001, decay: 0.1, sustain: 0, release: 0.1 }
                        }).connect(this.musicVolumeNode)
                    };

                    this.synths.trumpet.connect(new Tone.Distortion(0.1)).connect(this.musicVolumeNode);
                    this.synths.trombone.connect(new Tone.Filter(800, "lowpass")).connect(this.musicVolumeNode);
                    this.synths.tuba.connect(new Tone.Filter(400, "lowpass")).connect(this.musicVolumeNode);
                    this.synths.synthBass.connect(new Tone.Filter(800, "lowpass")).connect(this.musicVolumeNode);
                    this.synths.brassSection.connect(new Tone.Filter(1200, "lowpass")).connect(this.musicVolumeNode);

                    this.introAudioElement = new Audio('intro.m4a');
                    this.youWinAudioElement = new Audio('you win!.mp3');
                    this.youWinAudioElement.volume = 0.8;

                    const vibViolin = new Tone.Vibrato(5, 0.1).connect(this.musicVolumeNode);
                    const vibFlute = new Tone.Vibrato(4, 0.05).connect(this.musicVolumeNode);
                    this.synths.violin.connect(vibViolin);
                    this.synths.flute.connect(vibFlute);

                    this.isInit = true;
                    if (onProgress) onProgress('All systems online!', 100);
                    if (onComplete) setTimeout(onComplete, 500);
                } catch (error) {
                    this.isInit = false;
                    console.error('Audio asset loading failed:', error);
                    throw error;
                }
            },

            toggleMute() {
                this.muted = !this.muted;
                Tone.Destination.mute = this.muted;
                if (this.menuAudioElement) {
                    this.menuAudioElement.volume = this.muted ? 0 : 0.6;
                }
                if (this.phxAudioElement) {
                    this.phxAudioElement.volume = this.muted ? 0 : 0.6;
                }
                if (this.loadingAudioElement) {
                    this.loadingAudioElement.volume = this.muted ? 0 : 0.6;
                }
                if (this.raceAudioElements) {
                    this.raceAudioElements.forEach(a => a.volume = this.muted ? 0 : 0.6);
                }
                if (this.rainAudioElement) {
                    if (this.muted) {
                        this.rainAudioElement.volume = 0;
                    } else if (config && config.weather !== 'Clear' && gameState === 'PLAYING') {
                        this.rainAudioElement.volume = config.weather === 'Storm' ? 0.7 : 0.4;
                    }
                }
                const btn = document.getElementById('mute-btn-ui');
                if (btn) btn.innerText = this.muted ? '🔇' : '🔊';
                return this.muted;
            },

            playSynth(name, midi, time, duration, gain) {
                if (!this.isInit || this.muted || !this.synths[name]) return;
                let note = Tone.Frequency(midi, "midi").toNote();
                this.synths[name].triggerAttackRelease(note, duration, time, gain);
            },

            playFanfare(duration) {
                if (!this.isInit || this.muted) return;
                
                if (this.introAudioElement) {
                    this.introAudioElement.currentTime = 0;
                    this.introAudioElement.play().catch(() => {
                        this.playSynthFanfare(duration);
                    });
                } else {
                    this.playSynthFanfare(duration);
                }
            },

            playSynthFanfare(duration) {
                // Ensure music volume is up for the fanfare
                this.musicVolumeNode.volume.cancelScheduledValues(Tone.now());
                this.musicVolumeNode.volume.rampTo(0, 0.1);
                
                let t = Tone.now() + 0.1;
                
                // Racing Fanfare Melody (Mario Kart style)
                let melody = [
                    { note: 60, time: 0.0, dur: 0.2 },
                    { note: 67, time: 0.3, dur: 0.2 },
                    { note: 72, time: 0.6, dur: 0.4 },
                    { note: 67, time: 1.0, dur: 0.2 },
                    { note: 72, time: 1.2, dur: 0.2 },
                    { note: 76, time: 1.4, dur: 0.6 },
                    { note: 79, time: 2.0, dur: 1.0 }
                ];
                
                let scaleFactor = duration / 3.0; 
                
                this.playSynth('orchestraHit', 48, t, 2, 0.8);
                
                melody.forEach(m => {
                    let start = t + m.time * scaleFactor;
                    let dur = m.dur * scaleFactor;
                    this.playSynth('brassSection', m.note, start, dur * 1.2, 0.6);
                    this.playSynth('trumpet', m.note, start, dur, 0.5);
                });
                
                // Final chord
                this.playSynth('orchestraHit', 48, t + duration - 0.2, 4, 0.8);
                this.playSynth('brassSection', 55, t + duration - 0.5, 3, 0.6);
                this.playSynth('brassSection', 60, t + duration - 0.5, 3, 0.6);
                this.playSynth('brassSection', 64, t + duration - 0.5, 3, 0.6);
                this.playSynth('brassSection', 67, t + duration - 0.5, 3, 0.6);
            },

            stopFanfare() {
                if (this.introAudioElement) {
                    this.introAudioElement.pause();
                    this.introAudioElement.currentTime = 0;
                }
            },

            setEngineProfile(carTypeName) {
                if (!this.engineProfiles) return;
                let p = this.engineProfiles[carTypeName] || this.engineProfiles.BALANCED;
                this.activeEngineProfile = p;
                if (this.engineOsc) this.engineOsc.type = p.wave;
                if (this.engineOsc2) this.engineOsc2.type = p.wave2;
            },
            updateEngine(speed, isPlaying) {
                if (!this.isInit || this.muted || !this.engineOsc) return;
                let p = this.activeEngineProfile || this.engineProfiles.BALANCED;
                if (!isPlaying) {
                    this.engineOsc.volume.rampTo(-Infinity, 0.1);
                    if (this.engineOsc2) this.engineOsc2.volume.rampTo(-Infinity, 0.1);
                    return;
                }
                this.engineOsc.volume.rampTo(p.vol, 0.1);
                if (this.engineOsc2) this.engineOsc2.volume.rampTo(p.vol2, 0.1);
                const absSpeed = Math.abs(speed);
                let freq = p.baseFreq + (absSpeed * p.freqMult);
                this.engineOsc.frequency.rampTo(freq, 0.1);
                if (this.engineOsc2) this.engineOsc2.frequency.rampTo(freq * p.freq2Ratio, 0.1);
                this.engineFilter.frequency.rampTo(p.filterBase + (absSpeed * p.filterMult), 0.1);
            },
            setScreech(active) {
                if (!this.isInit || this.muted || !this.screechNoise) return;
                if (active) {
                    this.screechNoise.volume.rampTo(-15, 0.1);
                } else {
                    this.screechNoise.volume.rampTo(-Infinity, 0.1);
                }
            },
            beep() { this.playSynth('synthBass', 69, Tone.now(), 0.2, 0.1); }, // A4
            goBeep() { this.playSynth('synthBass', 81, Tone.now(), 0.4, 0.15); }, // A5
            lapJingle() { 
                let t = Tone.now();
                this.playSynth('trumpet', 72, t, 0.2, 0.4);
                this.playSynth('trumpet', 76, t + 0.1, 0.2, 0.4);
                this.playSynth('trumpet', 79, t + 0.2, 0.4, 0.4);
            },

            playJetFlyover() {
                if (!this.isInit || this.muted) return;
                let t = Tone.now();
                let dur = 3.5;
                let filter = new Tone.Filter({ type: "lowpass", frequency: 200 });
                filter.frequency.setValueAtTime(200, t);
                filter.frequency.exponentialRampToValueAtTime(1500, t + dur/2);
                filter.frequency.exponentialRampToValueAtTime(100, t + dur);
                let panner = new Tone.Panner(-1);
                panner.pan.linearRampToValueAtTime(1, t + dur);
                let env = new Tone.AmplitudeEnvelope({ attack: dur/2, decay: 0, sustain: 1.0, release: dur/2 });
                let noise = new Tone.Noise("pink");
                noise.chain(filter, panner, env, Tone.Destination);
                noise.start(t).stop(t + dur);
                noise.onstop = () => { noise.dispose(); filter.dispose(); panner.dispose(); env.dispose(); };
                env.triggerAttackRelease(dur, t);
            },
            
            // --- SYNTH DRUMS ---
            playKick(time, style=0) {
                if (!this.isInit || this.muted) return;
                if (style === 'desert') this.synths.kickDrum.triggerAttackRelease("C2", 0.5, time, 0.8);
                else if (style === 'mountain') this.synths.taikoDrum.triggerAttackRelease("C2", 0.5, time, 1.0);
                else this.synths.kickDrum.triggerAttackRelease("C1", 0.5, time, 1.0);
            },
            playSnare(time, style=0) {
                if (!this.isInit || this.muted) return;
                if (style === 'desert') this.synths.woodblock.triggerAttackRelease("C4", 0.1, time, 0.6);
                else if (style === 'seaside') this.synths.snareDrum.triggerAttackRelease("8n", time, 0.3);
                else this.synths.snareDrum.triggerAttackRelease("8n", time, 0.8);
            },
            playHihat(time, style=0) {
                if (!this.isInit || this.muted) return;
                if (style === 'technical') this.synths.woodblock.triggerAttackRelease("C5", 0.1, time, 0.5);
                else this.synths.hihat.triggerAttackRelease("16n", time, 0.3);
            },
            playCymbal(time) {
                if (!this.isInit || this.muted) return;
                this.synths.cymbal.triggerAttackRelease("2n", time, 0.6);
            },

            // --- WEAPON & ITEM SOUND EFFECTS ---
            playLaserShot() {
                if (!this.isInit || this.muted) return;
                let t = Tone.now();
                let osc2 = new Tone.Oscillator({ type: 'sawtooth', frequency: 2400 }).toDestination();
                osc2.volume.value = -20;
                osc2.frequency.setValueAtTime(2400, t);
                osc2.frequency.exponentialRampToValueAtTime(600, t + 0.08);
                osc2.start(t).stop(t + 0.08);
                osc2.onstop = () => osc2.dispose();
                let osc = new Tone.Oscillator({ type: 'square', frequency: 1800 }).toDestination();
                osc.volume.value = -14;
                osc.frequency.setValueAtTime(1800, t);
                osc.frequency.exponentialRampToValueAtTime(300, t + 0.12);
                osc.start(t).stop(t + 0.12);
                osc.onstop = () => osc.dispose();
            },
            playMissileLaunch() {
                if (!this.isInit || this.muted) return;
                let t = Tone.now();
                let filter = new Tone.Filter({ type: 'bandpass', frequency: 400 }).toDestination();
                filter.frequency.setValueAtTime(400, t);
                filter.frequency.exponentialRampToValueAtTime(2000, t + 0.25);
                let osc = new Tone.Oscillator({ type: 'sawtooth', frequency: 80 }).toDestination();
                osc.volume.value = -12;
                osc.frequency.setValueAtTime(80, t);
                osc.frequency.exponentialRampToValueAtTime(300, t + 0.3);
                osc.start(t).stop(t + 0.3);
                osc.onstop = () => osc.dispose();
                let noise = new Tone.Noise('white');
                noise.volume.value = -16;
                noise.connect(filter);
                noise.start(t).stop(t + 0.35);
                noise.onstop = () => { noise.dispose(); filter.dispose(); };
            },
            playMineDrop() {
                if (!this.isInit || this.muted) return;
                let t = Tone.now();
                let click = new Tone.Noise('white').toDestination();
                click.volume.value = -18;
                click.start(t).stop(t + 0.03);
                click.onstop = () => click.dispose();
                let osc = new Tone.Oscillator({ type: 'sine', frequency: 120 }).toDestination();
                osc.volume.value = -10;
                osc.frequency.setValueAtTime(120, t);
                osc.frequency.exponentialRampToValueAtTime(40, t + 0.15);
                osc.start(t).stop(t + 0.15);
                osc.onstop = () => osc.dispose();
            },
            playExplosion() {
                if (!this.isInit || this.muted) return;
                let t = Tone.now();
                let filter = new Tone.Filter({ type: 'lowpass', frequency: 2000 }).toDestination();
                filter.frequency.setValueAtTime(2000, t);
                filter.frequency.exponentialRampToValueAtTime(80, t + 0.4);
                let boom = new Tone.Oscillator({ type: 'sine', frequency: 60 }).toDestination();
                boom.volume.value = -6;
                boom.frequency.setValueAtTime(60, t);
                boom.frequency.exponentialRampToValueAtTime(20, t + 0.3);
                boom.start(t).stop(t + 0.3);
                boom.onstop = () => boom.dispose();
                let noise = new Tone.Noise('brown');
                noise.volume.value = -8;
                noise.connect(filter);
                noise.start(t).stop(t + 0.4);
                noise.onstop = () => { noise.dispose(); filter.dispose(); };
            },
            playShieldUp() {
                if (!this.isInit || this.muted) return;
                let t = Tone.now();
                this.playSynth('trumpet', 72, t, 0.15, 0.3);
                this.playSynth('trumpet', 76, t + 0.08, 0.15, 0.3);
                this.playSynth('trumpet', 79, t + 0.16, 0.15, 0.3);
                this.playSynth('trumpet', 84, t + 0.24, 0.3, 0.35);
            },
            playShieldBreak() {
                if (!this.isInit || this.muted) return;
                let t = Tone.now();
                let noise = new Tone.Noise('white').toDestination();
                noise.volume.value = -14;
                noise.start(t).stop(t + 0.15);
                noise.onstop = () => noise.dispose();
                this.playSynth('synthBass', 50, t, 0.2, 0.4);
                this.playSynth('synthBass', 45, t + 0.08, 0.15, 0.3);
            },
            playNitroBoost() {
                if (!this.isInit || this.muted) return;
                let t = Tone.now();
                let osc = new Tone.Oscillator({ type: 'sawtooth', frequency: 200 }).toDestination();
                osc.volume.value = -16;
                osc.frequency.setValueAtTime(200, t);
                osc.frequency.exponentialRampToValueAtTime(800, t + 0.2);
                osc.start(t).stop(t + 0.25);
                osc.onstop = () => osc.dispose();
                let noise = new Tone.Noise('pink').toDestination();
                noise.volume.value = -18;
                noise.start(t).stop(t + 0.3);
                noise.onstop = () => noise.dispose();
            },

            startRain(intensity) {
                if (!this.isInit || this.muted) return;
                if (!this.rainAudioElement) {
                    this.rainAudioElement = new Audio('Rain.mp3');
                    this.rainAudioElement.loop = true;
                    this.rainAudioElement.volume = 0;
                }
                if (this.rainAudioElement.paused) {
                    this.rainAudioElement.play().catch(() => {});
                }
                this.rainAudioElement.volume = intensity;
            },
            stopRain() {
                if (this.rainAudioElement) {
                    this.rainAudioElement.volume = 0;
                    this.rainAudioElement.pause();
                }
            },
            playThunder() {
                if (!this.isInit || this.muted) return;
                let t = Tone.now();
                let dur = 2.5;
                let filter = new Tone.Filter({ type: "lowpass", frequency: 800 });
                filter.frequency.setValueAtTime(800, t);
                filter.frequency.exponentialRampToValueAtTime(100, t + 0.2);
                filter.frequency.exponentialRampToValueAtTime(40, t + dur);
                let env = new Tone.AmplitudeEnvelope({ attack: 0.05, decay: dur, sustain: 0, release: 0.1 });
                let noise = new Tone.Noise("brown");
                noise.chain(filter, env, Tone.Destination);
                noise.start(t).stop(t + dur);
                noise.onstop = () => { noise.dispose(); filter.dispose(); env.dispose(); };
                env.triggerAttackRelease(dur, t);

                let rumbleEnv = new Tone.AmplitudeEnvelope({ attack: 0.2, decay: dur, sustain: 0, release: 0.1 });
                let rumble = new Tone.Oscillator({ type: "sine", frequency: 60 });
                rumble.chain(rumbleEnv, Tone.Destination);
                rumble.frequency.exponentialRampToValueAtTime(20, t + dur);
                rumble.start(t).stop(t + dur);
                rumble.onstop = () => { rumble.dispose(); rumbleEnv.dispose(); };
                rumbleEnv.triggerAttackRelease(dur, t);
            },

            victory() {
                let t = Tone.now();
                let notes = [72, 76, 79, 84];
                notes.forEach((midi, i) => this.playSynth('brassSection', midi, t + i * 0.15, 0.4, 0.5));
            },
            
            playYouWin() {
                if (!this.isInit || this.muted) return;
                if (this.youWinAudioElement) {
                    this.youWinAudioElement.currentTime = 0;
                    this.youWinAudioElement.play().catch(() => {});
                }
            },

            stopVictory() {
                if (this.youWinAudioElement) {
                    this.youWinAudioElement.pause();
                    this.youWinAudioElement.currentTime = 0;
                }
            },

            startMusic(trackName) {
                if (!this.isInit) return;
                this.musicVolumeNode.volume.cancelScheduledValues(Tone.now());
                this.musicVolumeNode.volume.value = 0; // 0 dB

                if (this.currentTrack === trackName) {
                    // Already playing — clear any stray interval that shouldn't be running
                    if (this.musicInterval) { clearInterval(this.musicInterval); this.musicInterval = null; }
                    return;
                }
                this.stopMusic();
                this.currentTrack = trackName;

                if (trackName === 'menu' && this.menuAudioElement) {
                    this.menuAudioElement.currentTime = 0;
                    this.menuAudioElement.volume = this.muted ? 0 : 0.6;
                    this.menuAudioElement.play().catch(e => {
                        console.log("Menu audio play prevented/missing:", e);
                        // Fail silently — no procedural fallback to avoid interval overlap
                    });
                    return;
                }

                if (trackName === 'loading' && this.loadingAudioElement) {
                    this.loadingAudioElement.currentTime = 0;
                    this.loadingAudioElement.volume = this.muted ? 0 : 0.6;
                    this.loadingAudioElement.play().catch(e => {
                        console.log("Loading audio play prevented/missing:", e);
                    });
                    return;
                }

                if (trackName === 'race_7' && this.phxAudioElement) {
                    this.phxAudioElement.currentTime = 0;
                    this.phxAudioElement.volume = this.muted ? 0 : 0.6;
                    this.phxAudioElement.play().catch(e => {});
                    return;
                }

                if (trackName.startsWith('race_')) {
                    let idx = parseInt(trackName.split('_')[1]);
                    let a = this.raceAudioElements[idx];
                    if (a) {
                        a.currentTime = 0;
                        a.volume = this.muted ? 0 : 0.6;
                        a.play().catch(e => console.log("Audio play prevented:", e));
                        return; // Prevent starting the procedural scheduleMusic loop
                    }
                }

                this.currentBeat = 0;
                this.nextNoteTime = Tone.now() + 0.1;
                this.musicInterval = setInterval(() => this.scheduleMusic(), 50);
            },
            fadeOutMusic(durationSecs) {
                if (!this.isInit || !this.musicVolumeNode) return;
                this.musicVolumeNode.volume.cancelScheduledValues(Tone.now());
                this.musicVolumeNode.volume.rampTo(-60, durationSecs);
                
                if (this.menuAudioElement && this.currentTrack === 'menu') {
                    let startVol = this.menuAudioElement.volume;
                    let steps = 20;
                    let stepTime = (durationSecs * 1000) / steps;
                    let stepVol = startVol / steps;
                    let fadeInterval = setInterval(() => {
                        if (this.menuAudioElement && this.menuAudioElement.volume > stepVol) {
                            this.menuAudioElement.volume -= stepVol;
                        } else {
                            if (this.menuAudioElement) this.menuAudioElement.volume = 0;
                            clearInterval(fadeInterval);
                        }
                    }, stepTime);
                }

                if (this.phxAudioElement && this.currentTrack === 'race_7') {
                    let startVol = this.phxAudioElement.volume;
                    let steps = 20;
                    let stepTime = (durationSecs * 1000) / steps;
                    let stepVol = startVol / steps;
                    let fadeInterval = setInterval(() => {
                        if (this.phxAudioElement && this.phxAudioElement.volume > stepVol) {
                            this.phxAudioElement.volume -= stepVol;
                        } else {
                            if (this.phxAudioElement) this.phxAudioElement.volume = 0;
                            clearInterval(fadeInterval);
                        }
                    }, stepTime);
                }

                if (this.loadingAudioElement && this.currentTrack === 'loading') {
                    let startVol = this.loadingAudioElement.volume;
                    let steps = 20;
                    let stepTime = (durationSecs * 1000) / steps;
                    let stepVol = startVol / steps;
                    let fadeInterval = setInterval(() => {
                        if (this.loadingAudioElement && this.loadingAudioElement.volume > stepVol) {
                            this.loadingAudioElement.volume -= stepVol;
                        } else {
                            if (this.loadingAudioElement) this.loadingAudioElement.volume = 0;
                            clearInterval(fadeInterval);
                        }
                    }, stepTime);
                }
                
                if (this.raceAudioElements) {
                    this.raceAudioElements.forEach(a => {
                        if (!a.paused && a.volume > 0) {
                            let startVol = a.volume;
                            let steps = 20;
                            let stepTime = (durationSecs * 1000) / steps;
                            let stepVol = startVol / steps;
                            let fadeInterval = setInterval(() => {
                                if (a.volume > stepVol) a.volume -= stepVol;
                                else { a.volume = 0; clearInterval(fadeInterval); }
                            }, stepTime);
                        }
                    });
                }
                
                setTimeout(() => this.stopMusic(), durationSecs * 1000);
            },
            stopMusic() {
                if (this.musicInterval) {
                    clearInterval(this.musicInterval);
                    this.musicInterval = null;
                }
                // Release any pre-scheduled Tone.js notes to prevent audible bleed-through
                if (this.synths) {
                    Object.values(this.synths).forEach(s => {
                        try { if (s && s.releaseAll) s.releaseAll(); } catch(e) {}
                    });
                }
                if (this.menuAudioElement) {
                    this.menuAudioElement.pause();
                }
                if (this.phxAudioElement) {
                    this.phxAudioElement.pause();
                }
                if (this.loadingAudioElement) {
                    this.loadingAudioElement.pause();
                }
                if (this.raceAudioElements) {
                    this.raceAudioElements.forEach(a => a.pause());
                }
                this.currentTrack = null;
            },
            scheduleMusic() {
                if (!this.currentTrack) return;
                let trackType = this.currentTrack.split('_')[0];
                let trackIdx = parseInt(this.currentTrack.split('_')[1] || 0);
                
                // Track Tempos
                let bpms = [150, 130, 140, 160, 120, 135, 145, 155, 140, 145];
                let bpm = trackType === 'menu' ? 120 : bpms[trackIdx];
                let stepTime = 15 / bpm; // 16th note duration

                if(this.muted) {
                    let scheduleAhead = 0.1;
                    while (this.nextNoteTime < Tone.now() + scheduleAhead) {
                        this.nextNoteTime += stepTime;
                        this.currentBeat++;
                    }
                    return;
                }

                let scheduleAhead = 0.1;
                while (this.nextNoteTime < Tone.now() + scheduleAhead) {
                    let time = this.nextNoteTime;
                    
                    if (trackType === 'menu') {
                        let b = this.currentBeat % 64;
                        let root = (b < 16) ? 45 : (b < 32) ? 41 : (b < 48) ? 48 : 43; // A2, F2, C3, G2
                        if (b % 2 === 0) this.playSynth('synthBass', root - 12, time, 0.15, 0.3);
                        let arp = [0, 7, 12, 19][b % 4];
                        this.playSynth('piano', root + arp + 12, time, 0.2, 0.3);
                        if (b % 8 === 0) this.playKick(time);
                        if (b % 8 === 4) this.playSnare(time);
                    } else if (trackType === 'race') {
                        let b = this.currentBeat % 512; 
                        let m = Math.floor(b / 16); 
                        let s = Math.floor(b / 128); 
                        
                        let styleIdx = trackIdx;
                        if (styleIdx === 8) styleIdx = 2; // Monaco shares City
                        if (styleIdx === 9) styleIdx = 6; // Infinity shares Technical

                        switch(styleIdx) {
                            case 0: { // Classic Oval (NASCAR Rock, 150 BPM)
                                let prog = [48, 53, 45, 55]; // C, F, Am, G
                                let root = prog[Math.floor(m / 2) % 4];
                                if (b % 2 === 0) this.playSynth('electricBass', root - 12, time, 0.2, 0.6);
                                if (b % 4 === 0) this.playKick(time);
                                if (b % 8 === 4) this.playSnare(time);
                                if (b % 2 === 0) this.playHihat(time);
                                if (s > 0 && m % 4 === 0 && b % 16 === 0) this.playCymbal(time);
                                if (s === 1 || s === 3) {
                                    let leadNotes = [0, -1, 0, 4, 7, -1, 7, 12, 12, 12, -1, 7, 4, -1, 4, 7];
                                    let note = leadNotes[b % 16];
                                    if (note !== -1) {
                                        this.playSynth('brassSection', root + note + 12, time, 0.3, 0.5);
                                    }
                                }
                                break;
                            }
                            case 1: { // Figure-8 (Quirky/Chaotic, 130 BPM)
                                let prog = [48, 49, 50, 51]; 
                                let root = prog[m % 4];
                                if (b % 4 === 2) this.playSynth('synthBass', root - 12, time, 0.1, 0.5);
                                if ((b % 8 === 0 || b % 8 === 3)) this.playKick(time);
                                if (b % 8 === 6) this.playSnare(time, 'seaside');
                                if (b % 2 === 1) this.playHihat(time);
                                if (s > 0) {
                                    let arp = [0, 4, 7, 10, 12, 10, 7, 4][b % 8];
                                    if (b % 2 === 0) this.playSynth('piano', root + arp + 12, time, 0.1, 0.5);
                                }
                                break;
                            }
                            case 2: { // City Circuit (Synthwave, 140 BPM)
                                let prog = [45, 41, 48, 43]; 
                                let root = prog[Math.floor(m / 2) % 4];
                                if (b % 4 === 0) this.playSynth('synthBass', root - 12, time, 0.4, 0.7);
                                if (b % 4 === 0) this.playKick(time);
                                if (b % 8 === 4) this.playSnare(time);
                                if (b % 1 === 0) this.playHihat(time);
                                if (s > 0 && (b % 8 === 0 || b % 8 === 3 || b % 8 === 6)) {
                                    this.playSynth('trumpet', root + 12, time, 0.2, 0.5);
                                }
                                break;
                            }
                            case 3: { // Desert Speedway (Fast relentless, 160 BPM)
                                let prog = [40, 38, 36, 35]; 
                                let root = prog[Math.floor(m / 4) % 4];
                                if ((b % 2 === 0 || b % 4 === 3)) this.playSynth('electricBass', root - 12, time, 0.15, 0.7);
                                if ((b % 16 === 0 || b % 16 === 10)) this.playKick(time, 'desert');
                                if (b % 16 === 4 || b % 16 === 12) this.playSnare(time, 'desert');
                                if (s === 1 || s === 3) {
                                    if (b % 16 === 0) this.playSynth('flute', root + 36, time, 0.8, 0.5);
                                    if (b % 16 === 8) this.playSynth('flute', root + 39, time, 0.4, 0.5);
                                }
                                break;
                            }
                            case 4: { // Mountain Pass (Epic/Cinematic, 120 BPM)
                                let prog = [38, 34, 41, 36]; 
                                let root = prog[Math.floor(m / 4) % 4];
                                if (b % 16 === 0) this.playSynth('brassSection', root - 12, time, 1.5, 0.6);
                                if ((b % 16 === 0 || b % 16 === 10)) this.playKick(time, 'mountain'); // taiko
                                if (m % 4 === 0 && b % 16 === 0) this.playCymbal(time);
                                if (s > 0) {
                                    let leadRhythm = [0, -1, -1, -1, 4, -1, -1, -1, 7, -1, -1, -1, 12, -1, 10, 9];
                                    let note = leadRhythm[b % 16];
                                    if (note !== -1) {
                                        this.playSynth('cello', root + note + 12, time, 0.5, 0.6);
                                        this.playSynth('violin', root + note + 24, time, 0.5, 0.4);
                                    }
                                }
                                break;
                            }
                            case 5: { // Seaside Circuit (Ocean vibes, 135 BPM)
                                let prog = [41, 40, 38, 36]; 
                                let root = prog[Math.floor(m / 2) % 4];
                                if ((b % 16 === 0 || b % 16 === 6 || b % 16 === 10)) this.playSynth('electricBass', root - 12, time, 0.3, 0.5);
                                if (b % 8 === 0) this.playKick(time);
                                if (b % 4 === 2) this.playSnare(time, 'seaside');
                                if (b % 2 === 0) this.playHihat(time);
                                let arp = [0, 4, 7, 11][b % 4];
                                this.playSynth('piano', root + arp + 12, time, 0.3, 0.4);
                                if (s > 0 && (b % 8 === 0 || b % 8 === 5)) {
                                    this.playSynth('flute', root + 24, time, 0.4, 0.4);
                                }
                                break;
                            }
                            case 6: { // Technical Track (Precision, 145 BPM)
                                let root = 36; 
                                if ((b % 4 === 2 || b % 16 === 14)) this.playSynth('synthBass', root - 12, time, 0.1, 0.6);
                                if (b % 4 === 0) this.playKick(time);
                                if (b % 8 === 4) this.playSnare(time);
                                if (b % 2 === 1) this.playHihat(time, 'technical');
                                if (s > 0) {
                                    let seq = [0, 12, 0, 7, 0, 10, 0, 3];
                                    let note = seq[Math.floor(b / 2) % 8];
                                    if (b % 2 === 0) this.playSynth('piano', root + 12 + note, time, 0.1, 0.6);
                                }
                                break;
                            }
                            case 7: { // Phoenix Sky Harbor (Urgent, 155 BPM)
                                let prog = [41, 39, 37, 36]; 
                                let root = prog[Math.floor(m / 2) % 4];
                                if (b % 1 === 0) this.playSynth('synthBass', root - 12, time, 0.1, 0.4);
                                if (b % 4 === 0) this.playKick(time);
                                if (b % 8 === 4) this.playSnare(time);
                                if (b % 1 === 0) this.playHihat(time);
                                if (s === 2 || s === 3) {
                                    if ((b % 4 === 0 || b % 4 === 3)) {
                                        this.playSynth('brassSection', root + 24, time, 0.2, 0.6);
                                    }
                                }
                                break;
                            }
                        }
                    }

                    this.nextNoteTime += stepTime; 
                    this.currentBeat++;
                }
            }
        };

        // --- Maps Themes & Data ---
        const mapsData = [
            { 
                name: "Classic Oval", 
                waypoints: [{x:0,y:0}, {x:6000,y:0}, {x:7000,y:1500}, {x:6000,y:3000}, {x:0,y:3000}, {x:-1000,y:1500}],
                theme: { bgOuter: '#4a7c59', bgInner: '#5a9a6e', track: '#2a2a2a', border: '#b0b0b0', barrierColor: '#ffffff', barrierDash: [], line: 'white' },
                features: [{type: 'boost', x: 3000, y: 0, angle: 0}, {type: 'boost', x: 3000, y: 3000, angle: Math.PI}]
            },
            { 
                name: "Figure-8", 
                waypoints: [{x:0,y:0}, {x:4000,y:0}, {x:6000,y:2000}, {x:4000,y:4000}, {x:1000,y:4000}, {x:-1000,y:0}, {x:-4000,y:0}, {x:-6000,y:2000}, {x:-4000,y:4000}, {x:-1000,y:4000}],
                theme: { bgOuter: '#3d7a3d', track: '#1e1e1e', border: '#ffffff', barrierColor: '#ffcc00', barrierDash: [20, 20], line: 'yellow_dash' },
                features: [{type: 'ramp', x: 2500, y: 2000, angle: Math.atan2(4000, 4000)}, {type: 'ramp', x: -2500, y: 2000, angle: Math.atan2(-4000, -4000)}]
            },
            { 
                name: "City Circuit", 
                waypoints: [{x:0,y:0}, {x:3000,y:0}, {x:3000,y:2000}, {x:6000,y:2000}, {x:6000,y:5000}, {x:0,y:5000}, {x:0,y:3000}, {x:-3000,y:3000}, {x:-3000,y:0}],
                theme: { bgOuter: '#808080', track: '#111111', border: '#ffffff', barrierColor: '#cc0000', barrierDash: [40, 40], line: 'white', surfaceType: 'concrete', shoulder: '#666b72', shoulderDust: '#8b9198', roadEdge: '#272a2f', asphaltHighlight: '#515761', laneColor: '#d7dbe0', sunAngle: -0.55, fogColor: 'rgba(220,220,230,0.05)' },
                features: [{type: 'boost', x: 1500, y: 0, angle: 0}, {type: 'oil', x: 4500, y: 2000, angle: 0}]
            },
            { 
                name: "Desert Speedway", 
                waypoints: [{x:0,y:0}, {x:12000,y:0}, {x:13000,y:2000}, {x:12000,y:4000}, {x:0,y:4000}, {x:-1000,y:2000}],
                theme: { bgOuter: '#d4b896', bgInner: '#c4a882', track: '#b8a882', border: '#c1440e', barrierColor: '#e67e22', barrierDash: [], line: 'white', surfaceType: 'sand', shoulder: '#c69d66', shoulderDust: '#e1bf87', roadEdge: '#8f6e45', asphaltHighlight: '#d8c19a', laneColor: '#efe6d6', sunAngle: -0.3, fogColor: 'rgba(255, 220, 170, 0.08)' },
                features: [{type: 'ramp', x: 6000, y: 0, angle: 0}, {type: 'ramp', x: 6000, y: 4000, angle: Math.PI}]
            },
            { 
                name: "Mountain Pass", 
                waypoints: [{x:0,y:0}, {x:4000,y:0}, {x:5000,y:2000}, {x:1000,y:2000}, {x:0,y:4000}, {x:4000,y:4000}, {x:5000,y:6000}, {x:-2000,y:6000}, {x:-2000,y:3000}],
                theme: { bgOuter: '#7a6a5a', track: '#555555', border: '#8b6914', barrierColor: '#aaaaaa', barrierDash: [40, 20], line: 'white_dash' },
                features: [{type: 'boost', x: 2000, y: 0, angle: 0}, {type: 'boost', x: 2000, y: 4000, angle: 0}]
            },
            { 
                name: "Seaside Circuit", 
                waypoints: [{x:0,y:0}, {x:3000,y:-1000}, {x:6000,y:0}, {x:8000,y:3000}, {x:6000,y:6000}, {x:3000,y:5000}, {x:0,y:6000}, {x:-2500,y:3000}],
                theme: { bgOuter: '#e8d5a3', track: '#9a9a8a', border: '#d4c4a0', barrierColor: '#ffffff', barrierDash: [], line: 'white' },
                features: [{type: 'boost', x: 1500, y: -500, angle: Math.atan2(-1000, 3000)}, {type: 'ramp', x: 7000, y: 1500, angle: Math.atan2(3000, 2000)}]
            },
            { 
                name: "Technical Track", 
                waypoints: [{x:0,y:0}, {x:2500,y:0}, {x:3000,y:-2000}, {x:5000,y:-2000}, {x:6000,y:0}, {x:6000,y:5000}, {x:4000,y:5000}, {x:4000,y:3000}, {x:2500,y:3000}, {x:2500,y:5000}, {x:0,y:5000}],
                theme: { bgOuter: '#4CAF50', track: '#1a1a1a', border: '#ffffff', barrierColor: '#cc0000', barrierDash: [30, 30], line: 'white' },
                features: [{type: 'oil', x: 1250, y: 0, angle: 0}, {type: 'oil', x: 4000, y: -2000, angle: 0}]
            },
            { 
                name: "Phoenix Sky Harbor", 
                waypoints: [{x:0,y:0}, {x:6000,y:0}, {x:7000,y:-2000}, {x:11000,y:-2000}, {x:12000,y:0}, {x:16000,y:0}, {x:17000,y:2000}, {x:16000,y:4000}, {x:0,y:4000}, {x:-1000,y:2000}],
                theme: { bgOuter: '#646b75', bgInner: '#7b8591', track: '#2a2b2e', border: '#FFD700', barrierColor: '#ffffff', barrierDash: [40, 40], line: 'white_dash', specialStart: 'hold_short', surfaceType: 'concrete', shoulder: '#707780', shoulderDust: '#8e97a3', roadEdge: '#1e2328', asphaltHighlight: '#5d6570', laneColor: '#f4e3a2', sunAngle: -0.42, fogColor: 'rgba(220,230,245,0.07)' },
                features: [{type: 'boost', x: 3000, y: 0, angle: 0}, {type: 'boost', x: 14000, y: 0, angle: 0}]
            },
            { 
                name: "Mini-Monaco", 
                waypoints: [{x:0,y:0}, {x:3000,y:0}, {x:4000,y:1500}, {x:3000,y:3000}, {x:1000,y:3000}, {x:0,y:1500}],
                theme: { bgOuter: '#8B7355', track: '#0d0d0d', border: '#ffffff', barrierColor: '#cc0000', barrierDash: [30, 30], line: 'white' },
                features: [{type: 'boost', x: 1500, y: 0, angle: 0}]
            },
            { 
                name: "Infinity Loop", 
                waypoints: [{x:0,y:0}, {x:3000,y:-2000}, {x:6000,y:0}, {x:6000,y:3000}, {x:3000,y:5000}, {x:0,y:3000}, {x:-3000,y:5000}, {x:-6000,y:3000}, {x:-6000,y:0}, {x:-3000,y:-2000}],
                theme: { bgOuter: '#050510', track: '#0a0a0f', border: '#6a0dad', borderStyle: 'neon', barrierColor: '#00f3ff', barrierDash: [50, 50], line: 'neon' },
                features: [{type: 'boost', x: 1500, y: -1000, angle: Math.atan2(-2000, 3000)}, {type: 'ramp', x: -1500, y: -1000, angle: Math.atan2(-2000, -3000)}]
            }
        ];

        const trackDescriptions = [
            "The legend. A pure speed oval where only the bravest take the outside line.",
            "Danger at every crossing! Watch out for cross-traffic at the center!",
            "Navigate tight city streets and hairpin corners in this urban nightmare.",
            "Blazing hot tarmac and long straights. Perfect for NOS abuse.",
            "Treacherous mountain switchbacks. One wrong move and you're off the cliff!",
            "Salt air and speed! A flowing coastal track with sweeping curves.",
            "Precision required. This track separates the racers from the rookies.",
            "Phoenix Sky Harbor International. A massive high-speed loop. Go under the terminal bridge and race down the main runway!",
            "Tight, luxurious, and unforgiving. The ultimate street racing test.",
            "Mind-bending neon geometry. Where the road ends, the future begins."
        ];

        // --- Open World Data ---
        const openWorldData = {
            // biomeColor: used for map background fill per region, biomeLabel: short type tag for minimap
            regions: [
                {
                    id: 'city',
                    name: 'City Center',
                    mapIndex: 2,
                    position: { x: 0, y: 0 },
                    connections: ['suburbs', 'desert', 'coastal', 'airport'],
                    hasGarage: true,
                    hasRaceStart: true,
                    raceStartLocation: { x: 0, y: 0, angle: 0 },
                    biomeColor: '#3a3f4a',
                    biomeLabel: 'CITY',
                    mmColor: '#7ec8e3'
                },
                {
                    id: 'suburbs',
                    name: 'Green Suburbs',
                    mapIndex: 0,
                    position: { x: -55000, y: 0 },
                    connections: ['city', 'forest'],
                    hasGarage: true,
                    hasRaceStart: true,
                    raceStartLocation: { x: -55000, y: 0, angle: 0 },
                    biomeColor: '#4a6741',
                    biomeLabel: 'SUBURB',
                    mmColor: '#90ee90'
                },
                {
                    id: 'desert',
                    name: 'Desert Highway',
                    mapIndex: 3,
                    position: { x: 65000, y: 0 },
                    connections: ['city', 'mountain'],
                    hasGarage: false,
                    hasRaceStart: true,
                    raceStartLocation: { x: 65000, y: 0, angle: 0 },
                    biomeColor: '#c4a060',
                    biomeLabel: 'DESERT',
                    mmColor: '#f4d03f'
                },
                {
                    id: 'coastal',
                    name: 'Seaside Circuit',
                    mapIndex: 5,
                    position: { x: 0, y: 65000 },
                    connections: ['city', 'beach'],
                    hasGarage: true,
                    hasRaceStart: true,
                    raceStartLocation: { x: 0, y: 65000, angle: 0 },
                    biomeColor: '#2a6070',
                    biomeLabel: 'COAST',
                    mmColor: '#1abc9c'
                },
                {
                    id: 'mountain',
                    name: 'Mountain Pass',
                    mapIndex: 4,
                    position: { x: 65000, y: 50000 },
                    connections: ['desert', 'industrial'],
                    hasGarage: false,
                    hasRaceStart: true,
                    raceStartLocation: { x: 65000, y: 50000, angle: 0 },
                    biomeColor: '#5a5a6a',
                    biomeLabel: 'MOUNTAIN',
                    mmColor: '#bdc3c7'
                },
                {
                    id: 'airport',
                    name: 'Sky Harbor',
                    mapIndex: 7,
                    position: { x: 30000, y: -40000 },
                    connections: ['city'],
                    hasGarage: true,
                    hasRaceStart: true,
                    raceStartLocation: { x: 30000, y: -40000, angle: 0 },
                    biomeColor: '#505870',
                    biomeLabel: 'AIRPORT',
                    mmColor: '#a0aec0'
                },
                {
                    id: 'beach',
                    name: 'Sunset Beach',
                    mapIndex: 5,
                    position: { x: 30000, y: 105000 },
                    connections: ['coastal'],
                    hasGarage: false,
                    hasRaceStart: true,
                    raceStartLocation: { x: 30000, y: 105000, angle: 0 },
                    biomeColor: '#d4a050',
                    biomeLabel: 'BEACH',
                    mmColor: '#f39c12'
                },
                {
                    id: 'forest',
                    name: 'Pine Forest',
                    mapIndex: 4,
                    position: { x: -55000, y: -55000 },
                    connections: ['suburbs'],
                    hasGarage: false,
                    hasRaceStart: true,
                    raceStartLocation: { x: -55000, y: -55000, angle: 0 },
                    biomeColor: '#2d5a27',
                    biomeLabel: 'FOREST',
                    mmColor: '#27ae60'
                },
                {
                    id: 'industrial',
                    name: 'Industrial Zone',
                    mapIndex: 6,
                    position: { x: 65000, y: 105000 },
                    connections: ['mountain', 'beach'],
                    hasGarage: true,
                    hasRaceStart: true,
                    raceStartLocation: { x: 65000, y: 105000, angle: 0 },
                    biomeColor: '#3a3028',
                    biomeLabel: 'INDUSTRIAL',
                    mmColor: '#e67e22'
                }
            ],
            highways: [
                {
                    // City(0,0) ←→ Suburbs(-55000,0)  — straight westbound highway with gentle curves
                    id: 'city-to-suburbs',
                    from: 'city',
                    to: 'suburbs',
                    width: 280,
                    waypoints: [
                        {x:  -8000, y:  1200},
                        {x: -18000, y:  2800},
                        {x: -30000, y:  1500},
                        {x: -42000, y: -1000},
                        {x: -50000, y:   800},
                        {x: -54500, y:     0}
                    ],
                    roadColor: '#3a3f3a',
                    shoulderColor: '#4a6741',
                    lineColor: '#ffff99'
                },
                {
                    // City(0,0) ←→ Desert(65000,0)  — straight eastbound desert highway
                    id: 'city-to-desert',
                    from: 'city',
                    to: 'desert',
                    width: 320,
                    waypoints: [
                        {x:  8000, y:  -800},
                        {x: 20000, y:  1200},
                        {x: 32000, y:   400},
                        {x: 44000, y:  1600},
                        {x: 56000, y:  -400},
                        {x: 64500, y:     0}
                    ],
                    roadColor: '#2c2820',
                    shoulderColor: '#b89050',
                    lineColor: '#ffffff'
                },
                {
                    // City(0,0) ←→ Coastal(0,65000)  — straight southbound highway
                    id: 'city-to-coastal',
                    from: 'city',
                    to: 'coastal',
                    width: 300,
                    waypoints: [
                        {x:  -800, y:  8000},
                        {x:  1200, y: 20000},
                        {x: -1000, y: 32000},
                        {x:  1600, y: 44000},
                        {x:  -400, y: 56000},
                        {x:     0, y: 64500}
                    ],
                    roadColor: '#2a2a2a',
                    shoulderColor: '#607860',
                    lineColor: '#ffff00'
                },
                {
                    // City(0,0) ←→ Airport(30000,-40000)  — diagonal NE highway
                    id: 'city-to-airport',
                    from: 'city',
                    to: 'airport',
                    width: 340,
                    waypoints: [
                        {x:  5000, y: -6000},
                        {x: 10000, y:-13000},
                        {x: 16000, y:-21000},
                        {x: 22000, y:-29000},
                        {x: 28000, y:-36000},
                        {x: 30000, y:-39500}
                    ],
                    roadColor: '#28303c',
                    shoulderColor: '#505870',
                    lineColor: '#ffffff'
                },
                {
                    // Desert(65000,0) ←→ Mountain(65000,50000)  — straight southbound
                    id: 'desert-to-mountain',
                    from: 'desert',
                    to: 'mountain',
                    width: 280,
                    waypoints: [
                        {x: 64200, y:  7000},
                        {x: 65800, y: 16000},
                        {x: 64500, y: 26000},
                        {x: 65500, y: 36000},
                        {x: 64800, y: 44000},
                        {x: 65000, y: 49500}
                    ],
                    roadColor: '#444040',
                    shoulderColor: '#6a5a40',
                    lineColor: '#ffffff'
                },
                {
                    // Coastal(0,65000) ←→ Beach(30000,105000)  — SE curve down to beach
                    id: 'coastal-to-beach',
                    from: 'coastal',
                    to: 'beach',
                    width: 260,
                    waypoints: [
                        {x:  4000, y: 70000},
                        {x: 10000, y: 77000},
                        {x: 16000, y: 84000},
                        {x: 22000, y: 91000},
                        {x: 28000, y: 99000},
                        {x: 30000, y:104500}
                    ],
                    roadColor: '#9a8a60',
                    shoulderColor: '#c4a060',
                    lineColor: '#ffeeaa'
                },
                {
                    // Suburbs(-55000,0) ←→ Forest(-55000,-55000)  — straight northbound
                    id: 'suburbs-to-forest',
                    from: 'suburbs',
                    to: 'forest',
                    width: 240,
                    waypoints: [
                        {x: -54200, y: -7000},
                        {x: -55800, y:-17000},
                        {x: -54500, y:-28000},
                        {x: -55500, y:-38000},
                        {x: -54800, y:-47000},
                        {x: -55000, y:-54500}
                    ],
                    roadColor: '#303830',
                    shoulderColor: '#2d5a27',
                    lineColor: '#ccffcc'
                },
                {
                    // Mountain(65000,50000) ←→ Industrial(65000,105000)  — straight southbound
                    id: 'mountain-to-industrial',
                    from: 'mountain',
                    to: 'industrial',
                    width: 280,
                    waypoints: [
                        {x: 64200, y: 57000},
                        {x: 65800, y: 67000},
                        {x: 64500, y: 77000},
                        {x: 65500, y: 87000},
                        {x: 64800, y: 97000},
                        {x: 65000, y:104500}
                    ],
                    roadColor: '#383430',
                    shoulderColor: '#4a4038',
                    lineColor: '#ffcc66'
                },
                {
                    // Beach(30000,105000) ←→ Industrial(65000,105000)  — straight eastbound
                    id: 'beach-to-industrial',
                    from: 'beach',
                    to: 'industrial',
                    width: 260,
                    waypoints: [
                        {x: 36000, y:104200},
                        {x: 44000, y:105800},
                        {x: 52000, y:104500},
                        {x: 60000, y:105500},
                        {x: 64500, y:105000}
                    ],
                    roadColor: '#383430',
                    shoulderColor: '#4a4038',
                    lineColor: '#ffcc66'
                }
            ]
        };

        // --- Math & Helper Functions ---
        const dist2 = (v, w) => Math.pow(v.x - w.x, 2) + Math.pow(v.y - w.y, 2);
        function distToSegmentSquared(p, v, w) {
            let l2 = dist2(v, w);
            if (l2 === 0) return dist2(p, v);
            let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
            t = Math.max(0, Math.min(1, t));
            return dist2(p, { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) });
        }
        function normalizeAngle(angle) {
            while (angle > Math.PI) angle -= 2 * Math.PI;
            while (angle < -Math.PI) angle += 2 * Math.PI;
            return angle;
        }

        function hexToRgb(hex) {
            let result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            return result ? {
                r: parseInt(result[1], 16),
                g: parseInt(result[2], 16),
                b: parseInt(result[3], 16)
            } : {r:0, g:0, b:0};
        }
        function rgbToHex(r, g, b) {
            return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
        }

        function adjustHexColor(hex, delta) {
            if (typeof hex !== 'string' || !/^#([a-f\d]{6})$/i.test(hex)) return hex;
            let { r, g, b } = hexToRgb(hex);
            return rgbToHex(r + delta, g + delta, b + delta);
        }

        function hexToRgba(hex, alpha) {
            if (typeof hex !== 'string' || !/^#([a-f\d]{6})$/i.test(hex)) return `rgba(255, 255, 255, ${alpha})`;
            let { r, g, b } = hexToRgb(hex);
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }

        function stableNoise(x, y, seed = 0) {
            let value = Math.sin(x * 0.013 + y * 0.017 + seed * 0.19) * 43758.5453123;
            return value - Math.floor(value);
        }

        const materialPatternCache = {};
        function getMaterialPattern(type, baseColor, accentColor, detailColor) {
            let key = [type, baseColor, accentColor, detailColor].join('|');
            if (materialPatternCache[key]) return materialPatternCache[key];

            let patternCanvas = document.createElement('canvas');
            patternCanvas.width = 96;
            patternCanvas.height = 96;
            let pctx = patternCanvas.getContext('2d');

            pctx.fillStyle = baseColor;
            pctx.fillRect(0, 0, patternCanvas.width, patternCanvas.height);

            if (type === 'sand') {
                for (let i = 0; i < 180; i++) {
                    let x = stableNoise(i, 13, 1) * patternCanvas.width;
                    let y = stableNoise(i, 29, 2) * patternCanvas.height;
                    let radius = 1 + stableNoise(i, 47, 3) * 3;
                    pctx.fillStyle = i % 3 === 0 ? accentColor : detailColor;
                    pctx.globalAlpha = 0.1 + stableNoise(i, 61, 4) * 0.18;
                    pctx.beginPath();
                    pctx.arc(x, y, radius, 0, Math.PI * 2);
                    pctx.fill();
                }
                pctx.globalAlpha = 1;
                pctx.strokeStyle = hexToRgba(detailColor, 0.14);
                pctx.lineWidth = 2;
                for (let i = 0; i < 6; i++) {
                    let y = i * 16 + stableNoise(i, 73, 5) * 8;
                    pctx.beginPath();
                    pctx.moveTo(0, y);
                    pctx.quadraticCurveTo(30, y - 6, 64, y + 4);
                    pctx.quadraticCurveTo(82, y + 8, 96, y + 2);
                    pctx.stroke();
                }
            } else if (type === 'concrete') {
                for (let i = 0; i < 260; i++) {
                    let x = stableNoise(i, 11, 6) * patternCanvas.width;
                    let y = stableNoise(i, 37, 7) * patternCanvas.height;
                    let size = 1 + stableNoise(i, 53, 8) * 2;
                    pctx.fillStyle = i % 2 === 0 ? accentColor : detailColor;
                    pctx.globalAlpha = 0.08 + stableNoise(i, 67, 9) * 0.12;
                    pctx.fillRect(x, y, size, size);
                }
                pctx.globalAlpha = 1;
                pctx.strokeStyle = hexToRgba(detailColor, 0.18);
                pctx.lineWidth = 1;
                for (let i = 0; i < 5; i++) {
                    let pos = 8 + i * 20 + stableNoise(i, 83, 10) * 6;
                    pctx.beginPath();
                    pctx.moveTo(pos, 0);
                    pctx.lineTo(pos + stableNoise(i, 97, 11) * 8 - 4, 96);
                    pctx.stroke();
                }
            } else {
                for (let i = 0; i < 320; i++) {
                    let x = stableNoise(i, 19, 12) * patternCanvas.width;
                    let y = stableNoise(i, 41, 13) * patternCanvas.height;
                    let size = 1 + stableNoise(i, 59, 14) * 3;
                    pctx.fillStyle = i % 3 === 0 ? accentColor : detailColor;
                    pctx.globalAlpha = 0.07 + stableNoise(i, 71, 15) * 0.14;
                    pctx.fillRect(x, y, size, size);
                }
                pctx.globalAlpha = 1;
                pctx.strokeStyle = hexToRgba(detailColor, 0.15);
                pctx.lineWidth = 1.4;
                for (let i = 0; i < 8; i++) {
                    let x = stableNoise(i, 89, 16) * 96;
                    let y = stableNoise(i, 103, 17) * 96;
                    pctx.beginPath();
                    pctx.moveTo(x, y);
                    pctx.lineTo(x + 18, y + stableNoise(i, 113, 18) * 14 - 7);
                    pctx.lineTo(x + 26, y + stableNoise(i, 131, 19) * 18 - 9);
                    pctx.stroke();
                }
            }

            materialPatternCache[key] = ctx.createPattern(patternCanvas, 'repeat');
            return materialPatternCache[key];
        }

        function getTrackVisuals(theme) {
            let surfaceType = theme.surfaceType || 'asphalt';
            let shoulderColor = theme.shoulder || adjustHexColor(theme.bgOuter || '#5a7a5a', -14);
            let shoulderDust = theme.shoulderDust || adjustHexColor(shoulderColor, 18);
            let roadEdgeColor = theme.roadEdge || adjustHexColor(theme.track || '#2a2a2a', -20);
            let asphaltHighlight = theme.asphaltHighlight || adjustHexColor(theme.track || '#2a2a2a', 18);
            let asphaltShadow = theme.asphaltShadow || hexToRgba(theme.track || '#2a2a2a', 0.22);
            let racingLine = theme.racingLine || hexToRgba('#111111', surfaceType === 'sand' ? 0.12 : 0.18);
            let laneColor = theme.laneColor || (theme.line === 'yellow_dash' ? '#FFD700' : '#ffffff');
            let surfacePatternType = surfaceType === 'concrete' ? 'concrete' : (surfaceType === 'sand' ? 'sand' : 'asphalt');
            return {
                surfaceType,
                shoulderColor,
                shoulderDust,
                roadEdgeColor,
                asphaltHighlight,
                asphaltShadow,
                racingLine,
                laneColor,
                sunAngle: theme.sunAngle !== undefined ? theme.sunAngle : -0.8,
                fogColor: theme.fogColor || (surfaceType === 'sand' ? 'rgba(255, 220, 170, 0.06)' : 'rgba(255,255,255,0.03)'),
                surfacePattern: getMaterialPattern(surfacePatternType, theme.track || '#2a2a2a', asphaltHighlight, roadEdgeColor),
                shoulderPattern: getMaterialPattern(surfaceType === 'sand' ? 'sand' : 'concrete', shoulderColor, shoulderDust, adjustHexColor(shoulderColor, -20))
            };
        }
        // --- Environment Generator ---
        function generateScenery(mapIndex) {
            activeScenery = []; itemBoxes = []; projectiles = []; traps = []; movingHazards = []; zoneHazards = []; coins = [];
            let map = mapsData[mapIndex];

            // Generate items and coins along the track path
            for(let i=0; i<map.waypoints.length; i++) {
                let wp1 = map.waypoints[i];
                let wp2 = map.waypoints[(i+1)%map.waypoints.length];
                let dx = wp2.x - wp1.x, dy = wp2.y - wp1.y;
                let dist = Math.sqrt(dx*dx + dy*dy);
                let cx = wp1.x + dx/2, cy = wp1.y + dy/2;
                let perpX = -dy/dist, perpY = dx/dist;
                
                if (dist > 2000) {
                    itemBoxes.push(new ItemBox(cx, cy));
                    itemBoxes.push(new ItemBox(cx + perpX * 160, cy + perpY * 160));
                    itemBoxes.push(new ItemBox(cx - perpX * 160, cy - perpY * 160));
                }
                
                if (dist > 500) {
                    for(let j=0; j<Math.floor(dist/600); j++) {
                        let offset = (Math.random()-0.5)*200;
                        coins.push(new Coin(cx + offset + (Math.random()-0.5)*50, cy + offset + (Math.random()-0.5)*50));
                    }
                }
            }

            // --- Dynamic Track Hazards Generation ---
            if (mapIndex === 2) { // City Circuit
                movingHazards.push(new MovingHazard('civilian_car', 1500, -1000, 1500, 1000, 15, 50));
                movingHazards.push(new MovingHazard('civilian_car', 4500, 3000, 4500, 1000, 18, 50));
            } else if (mapIndex === 3) { // Desert Speedway
                movingHazards.push(new MovingHazard('train', 8000, -2000, 8000, 2000, 25, 150));
                movingHazards.push(new MovingHazard('tumbleweed', 4000, -1000, 4000, 1000, 8, 30));
                movingHazards.push(new MovingHazard('tumbleweed', 10000, 5000, 10000, 3000, 6, 30));
            } else if (mapIndex === 9) { // Infinity Loop
                // Teleporter shortcut!
                zoneHazards.push(new ZoneHazard('teleporter', -3000, 5000, 150, 0, 3000, 0)); 
                zoneHazards.push(new ZoneHazard('wind', 3000, 5000, 400, -1, 0, 8)); // Blows left
            }

            
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            map.waypoints.forEach(w => { minX=Math.min(minX,w.x); maxX=Math.max(maxX,w.x); minY=Math.min(minY,w.y); maxY=Math.max(maxY,w.y); });
            minX -= 1500; maxX += 1500; minY -= 1500; maxY += 1500;

            function isNearTrack(x, y, safeDist) {
                for (let i = 0; i < map.waypoints.length; i++) {
                    let p1 = map.waypoints[i], p2 = map.waypoints[(i + 1) % map.waypoints.length];
                    if (Math.sqrt(distToSegmentSquared({x, y}, p1, p2)) < safeDist) return true;
                }
                return false;
            }

            if (mapIndex === 0) { // Classic Oval
                for(let i=0; i<60; i++) {
                    activeScenery.push({ type: 'tree_detailed', x: 900 + (Math.random()-0.5)*3000, y: 400 + (Math.random()-0.5)*2000 });
                }
                for(let i=0; i<10; i++) {
                    activeScenery.push({ type: 'grandstand', x: 900 + (i-5)*150, y: -300, angle: 0 }); 
                    activeScenery.push({ type: 'grandstand', x: 900 + (i-5)*150, y: 1100, angle: Math.PI }); 
                }
                activeScenery.push({ type: 'pit_lane', x: 900, y: 650, w: 800, h: 40 });
                for(let i=0; i<5; i++) {
                    activeScenery.push({ type: 'pit_garage', x: 500 + i*200, y: 700, w: 180, h: 50, angle: 0 });
                }
            } else if (mapIndex === 1) { // Fig-8
                for(let i=0; i<120; i++) {
                    activeScenery.push({ type: 'pine_tree', x: minX + Math.random()*(maxX-minX), y: minY + Math.random()*(maxY-minY), s: 20+Math.random()*40 });
                }
                let wps = map.waypoints;
                for(let i=0; i<wps.length; i++) {
                    let p1 = wps[i], p2 = wps[(i+1)%wps.length];
                    let dist = Math.sqrt(dist2(p1,p2));
                    let ang = Math.atan2(p2.y-p1.y, p2.x-p1.x);
                    let perp = ang + Math.PI/2;
                    for(let d=0; d<dist; d+=40) {
                        let px = p1.x + Math.cos(ang)*d;
                        let py = p1.y + Math.sin(ang)*d;
                        activeScenery.push({type: 'fence_post', x: px + Math.cos(perp)*140, y: py + Math.sin(perp)*140});
                        activeScenery.push({type: 'fence_post', x: px - Math.cos(perp)*140, y: py - Math.sin(perp)*140});
                        if (d % 200 < 40) {
                            activeScenery.push({ type: 'tire_wall', x: px + Math.cos(perp)*180, y: py + Math.sin(perp)*180, w: 100, angle: ang });
                            activeScenery.push({ type: 'tire_wall', x: px - Math.cos(perp)*180, y: py - Math.sin(perp)*180, w: 100, angle: ang });
                        }
                    }
                }
            } else if (mapIndex === 2) { // City
                for(let i=0; i<40; i++) {
                    let w = 80+Math.random()*120, h = 80+Math.random()*120;
                    activeScenery.push({ type: 'building_lit', x: minX + Math.random()*(maxX-minX), y: minY + Math.random()*(maxY-minY), w: w, h: h, c: Math.random()>0.5?'#2b2b2b':(Math.random()>0.5?'#3a3a4a':'#1a1a1a') });
                }
                activeScenery.push({ type: 'crosswalk', x: 500, y: 0, w: config.trackWidth, h: 40, angle: 0 });
                activeScenery.push({ type: 'crosswalk', x: 500, y: 800, w: config.trackWidth, h: 40, angle: 0 });
                activeScenery.push({ type: 'crosswalk', x: 2500, y: 1000, w: config.trackWidth, h: 40, angle: Math.PI/2 });
                activeScenery.push({ type: 'parking_lot', x: 1500, y: -850, w: 720, h: 320, angle: 0 });
                activeScenery.push({ type: 'parking_lot', x: 4700, y: 880, w: 560, h: 280, angle: Math.PI/2 });
                activeScenery.push({ type: 'parking_lot', x: -1850, y: 1200, w: 620, h: 320, angle: 0 });
                activeScenery.push({ type: 'road_median', x: 1500, y: 1000, w: 420, h: 26, angle: 0 });
                activeScenery.push({ type: 'road_median', x: 3000, y: 1000, w: 340, h: 26, angle: Math.PI/2 });
                activeScenery.push({ type: 'road_median', x: 4500, y: 3500, w: 360, h: 26, angle: 0 });
                activeScenery.push({ type: 'billboard', x: 6200, y: 700, w: 220, h: 110, angle: Math.PI/2, c: '#67d5ff', accent: '#1b1f2a', text: 'NIGHT RACE' });
                activeScenery.push({ type: 'billboard', x: -3200, y: 1200, w: 200, h: 100, angle: -Math.PI/2, c: '#ff6b6b', accent: '#2b2b2b', text: 'DRIFT ZONE' });
                for(let x=150; x<4000; x+=150) {
                    activeScenery.push({ type: 'streetlight', x: x, y: -160, angle: 0 });
                    activeScenery.push({ type: 'streetlight', x: x, y: 160, angle: Math.PI });
                    activeScenery.push({ type: 'streetlight', x: x, y: 1840, angle: 0 });
                    activeScenery.push({ type: 'streetlight', x: x, y: 2160, angle: Math.PI });
                }
            } else if (mapIndex === 3) { // Desert
                for(let i=0; i<60; i++) {
                    activeScenery.push({ type: 'cactus_detailed', x: minX + Math.random()*(maxX-minX), y: minY + Math.random()*(maxY-minY) });
                }
                for(let i=0; i<30; i++) {
                    let pts = [];
                    for(let j=0; j<10; j++) {
                        let a = (j/10)*Math.PI*2;
                        let r = 40 + Math.random()*80;
                        pts.push({x: Math.cos(a)*r, y: Math.sin(a)*r});
                    }
                    activeScenery.push({type: 'rock_formation', x: minX+Math.random()*(maxX-minX), y: minY+Math.random()*(maxY-minY), pts: pts});
                }
                let dots = [];
                for(let i=0; i<3000; i++) dots.push({x: minX+Math.random()*(maxX-minX), y: minY+Math.random()*(maxY-minY)});
                activeScenery.push({type: 'sand_dots', dots: dots});
                for(let i=0; i<15; i++) {
                    activeScenery.push({ type: 'palm_tree', x: minX + Math.random()*(maxX-minX), y: minY + Math.random()*(maxY-minY) });
                }
                for(let i=0; i<18; i++) {
                    let x = minX + Math.random()*(maxX-minX), y = minY + Math.random()*(maxY-minY);
                    if(!isNearTrack(x, y, config.trackWidth/2 + 80)) activeScenery.push({ type: 'dune', x: x, y: y, rx: 100 + Math.random()*120, ry: 30 + Math.random()*35, angle: Math.random()*Math.PI, c: '#d6b176', shade: '#bc8b54' });
                }
                for(let i=0; i<70; i++) {
                    let x = minX + Math.random()*(maxX-minX), y = minY + Math.random()*(maxY-minY);
                    if(!isNearTrack(x, y, config.trackWidth/2 + 40)) activeScenery.push({ type: 'desert_scrub', x: x, y: y, s: 8 + Math.random()*10 });
                }
                for(let i=0; i<25; i++) {
                    let x = minX + Math.random()*(maxX-minX), y = minY + Math.random()*(maxY-minY);
                    if(!isNearTrack(x, y, config.trackWidth/2 + 50)) activeScenery.push({ type: 'cracked_ground', x: x, y: y, r: 20 + Math.random()*30 });
                }
                activeScenery.push({ type: 'billboard', x: 3000, y: -900, w: 240, h: 110, angle: 0, c: '#f0c05a', accent: '#553311', text: 'DESERT CUP' });
                activeScenery.push({ type: 'billboard', x: 9500, y: 4900, w: 240, h: 110, angle: Math.PI, c: '#f0c05a', accent: '#553311', text: 'PIT WATER' });
            } else if (mapIndex === 4) { // Mountain
                for(let i=1; i<6; i++) {
                    activeScenery.push({ type: 'mountain_peak', x: minX+(maxX-minX)*(i*0.15), y: minY, w: 300+Math.random()*400, h: 500+Math.random()*500 });
                }
                for(let i=0; i<200; i++) {
                    activeScenery.push({ type: 'pine_tree', x: minX + Math.random()*(maxX-minX), y: minY + Math.random()*(maxY-minY), s: 25+Math.random()*35 });
                }
                let cliffPts = [];
                for(let x=minX-500; x<maxX+500; x+=100) cliffPts.push({x: x, y: minY + 300 + Math.random()*200});
                activeScenery.push({type: 'cliff_face', pts: cliffPts});
            } else if (mapIndex === 5) { // Seaside
                activeScenery.push({ type: 'rect', x: minX, y: minY, w: maxX-minX, h: (maxY-minY)/2, c: '#1a7ab8' }); 
                for(let i=0; i<150; i++) {
                    let x = minX + Math.random()*(maxX-minX), y = minY + Math.random()*((maxY-minY)/2 - 50);
                    activeScenery.push({ type: 'animated_wave', x, y, w: 60+Math.random()*80, c: 'rgba(255,255,255,0.4)' });
                }
                for(let i=0; i<50; i++) {
                    activeScenery.push({ type: 'palm_tree', x: minX + Math.random()*(maxX-minX), y: (minY+maxY)/2 + 100 + Math.random()*((maxY-minY)/2 - 100) });
                }
                for(let i=0; i<20; i++) {
                    activeScenery.push({ type: 'seagull', x: minX + Math.random()*(maxX-minX), y: minY + Math.random()*(maxY-minY), offsetX: Math.random()*1000 });
                }
            } else if (mapIndex === 6) { // Technical
                for(let i=0; i<6; i++) {
                    activeScenery.push({ type: 'pit_garage', x: 100 + i*220, y: 180, w: 200, h: 60, angle: 0 }); 
                }
                activeScenery.push({ type: 'pit_lane', x: 400, y: 100, w: 1200, h: 30 });
                for(let i=0; i<15; i++) {
                    activeScenery.push({ type: 'tire_wall', x: 800 + i*160, y: -250, w: 150, angle: 0 });
                    activeScenery.push({ type: 'tire_wall', x: 1200 + i*160, y: -250, w: 150, angle: 0 });
                }
                for(let i=0; i<8; i++) {
                    activeScenery.push({ type: 'grandstand', x: 1500, y: 1000 + i*200, angle: -Math.PI/2 });
                }
            } else if (mapIndex === 7) { // Phoenix Sky Harbor
                activeScenery.push({ type: 'runway_markings', x: 0, y: 0, length: 16000 });
                activeScenery.push({ type: 'runway_markings', x: 0, y: 2400, length: 16000 });
                
                // AIRPORT INTERIOR
                activeScenery.push({ type: 'airport_floor', x: 9100, y: -2520, w: 5600, h: 1460 });
                for(let i=7050; i<=11150; i+=550) {
                    activeScenery.push({ type: 'terminal_glass', x: i, y: -3080, w: 430, h: 220 });
                }
                for(let i=7800; i<=10200; i+=1200) {
                    activeScenery.push({ type: 'jetbridge', x: i, y: -2660, w: 190, h: 74, angle: Math.PI / 2 });
                }
                for(let i=7600; i<=10450; i+=950) {
                    activeScenery.push({ type: 'airport_shop', x: i, y: -2840, w: 360, h: 180 });
                }
                activeScenery.push({ type: 'airport_bathroom', x: 8850, y: -2360, w: 320, h: 150 });
                activeScenery.push({ type: 'airport_bathroom', x: 10100, y: -2360, w: 300, h: 150 });
                activeScenery.push({ type: 'airport_terminal_door', x: 8250, y: -1890, w: 170, h: 118 });
                activeScenery.push({ type: 'airport_terminal_door', x: 9950, y: -1890, w: 170, h: 118 });
                activeScenery.push({ type: 'parking_lot', x: 13200, y: -900, w: 920, h: 340, angle: 0 });
                activeScenery.push({ type: 'hangar', x: 2450, y: 5050, w: 1600, h: 620 });
                activeScenery.push({ type: 'hangar', x: 14450, y: 5050, w: 1800, h: 660 });
                activeScenery.push({ type: 'radar_tower', x: 15450, y: -2920, h: 380 });
                activeScenery.push({ type: 'fuel_tank', x: 12680, y: 5160, r: 74 });
                activeScenery.push({ type: 'fuel_tank', x: 12930, y: 5160, r: 66 });
                activeScenery.push({ type: 'cargo_stack', x: 11850, y: -1280, w: 260, h: 130, c: '#4f7db3' });
                activeScenery.push({ type: 'cargo_stack', x: 12220, y: -1280, w: 260, h: 130, c: '#d97c37' });
                for(let x=0; x<16500; x+=150) {
                    activeScenery.push({ type: 'runway_light', x: x, y: -120 });
                    activeScenery.push({ type: 'runway_light', x: x, y: 120 });
                    activeScenery.push({ type: 'runway_light', x: x, y: 2280 });
                    activeScenery.push({ type: 'runway_light', x: x, y: 2520 });
                }
                for(let px = 1800; px <= 8000; px += 350) {
                    if (Math.random() > 0.3) activeScenery.push({ type: 'airplane', x: px, y: 600 + Math.random()*200, angle: Math.PI + (Math.random()-0.5)*0.2, c: '#eeeeee', accent: '#1a7ab8' });
                    if (Math.random() > 0.3) activeScenery.push({ type: 'airplane', x: px + 150, y: 1800 - Math.random()*200, angle: (Math.random()-0.5)*0.2, c: '#dddddd', accent: '#e63946' });
                }
                for(let i=0; i<10; i++) {
                    activeScenery.push({ type: 'service_vehicle', x: 6800 + i*520, y: -920 - (i%2)*130, angle: Math.PI / 2, c: i % 2 === 0 ? '#f5c542' : '#ffffff' });
                }
                for(let i=0; i<7; i++) {
                    activeScenery.push({ type: 'service_vehicle', x: 9800 + i*620, y: 4600 + (i%2)*80, angle: 0, c: i % 3 === 0 ? '#8ad0ff' : '#e8e8e8' });
                }
            } else if (mapIndex === 8) { // Monaco
                activeScenery.push({ type: 'rect', x: minX, y: minY, w: (maxX-minX)/2, h: maxY-minY, c: '#1565C0' }); // Ocean left
                for(let i=0; i<80; i++) {
                    let x = minX + Math.random()*((maxX-minX)/2 - 50), y = minY + Math.random()*(maxY-minY);
                    activeScenery.push({ type: 'animated_wave', x, y, w: 40+Math.random()*50, c: 'rgba(255,255,255,0.4)' });
                }
                for(let i=0; i<30; i++) {
                    activeScenery.push({ type: 'palm_tree', x: (minX+maxX)/2 + 50 + Math.random()*150, y: minY + Math.random()*(maxY-minY) });
                }
                for(let i=0; i<80; i++) {
                    let x = (minX+maxX)/2 + 150 + Math.random()*((maxX-minX)/2 - 200), y = minY + Math.random()*(maxY-minY);
                    if(!isNearTrack(x, y, config.trackWidth/2 + 50)) {
                        activeScenery.push({ type: 'building_lit', x: x, y: y, w: 80+Math.random()*80, h: 80+Math.random()*100, c: Math.random()>0.5?'#F5DEB3':'#E6C280' }); 
                    }
                }
            } else if (mapIndex === 9) { // Infinity
                for(let i=0; i<600; i++) {
                    let x = minX + Math.random()*(maxX-minX), y = minY + Math.random()*(maxY-minY);
                    activeScenery.push({ type: 'circle', x, y, r: 1+Math.random()*4, c: Math.random()>0.7?'#ff00ea':(Math.random()>0.5?'#fff':'#00f3ff') });
                }
                for(let i=0; i<60; i++) {
                    let w = 100 + Math.random()*200, h = 100 + Math.random()*200;
                    activeScenery.push({ type: 'building_lit', x: minX + Math.random()*(maxX-minX), y: minY + Math.random()*(maxY-minY), w: w, h: h, c: '#0a0a1a' });
                }
            }
        }

        function renderScenery(ctx) {
            const cullPadding = gameState === 'DRONE_VIEW' ? Math.max(600, 320 / Math.max(droneView.zoom, 0.08)) : 280;
            const cullBounds = getWorldViewBounds(cullPadding);
            const lowDetailDroneView = gameState === 'DRONE_VIEW' && droneView.zoom < 0.16;
            activeScenery.forEach(s => {
                if (lowDetailDroneView && LOW_DETAIL_DRONE_SCENERY_TYPES.has(s.type)) return;
                if (s.type !== 'sand_dots' && !ALWAYS_RENDER_SCENERY_TYPES.has(s.type) && s.x !== undefined && s.y !== undefined) {
                    let cullRadius = getSceneryCullRadius(s);
                    if (s.x + cullRadius < cullBounds.minX || s.x - cullRadius > cullBounds.maxX || s.y + cullRadius < cullBounds.minY || s.y - cullRadius > cullBounds.maxY) return;
                }
                ctx.save();
                let noShadow = NO_SHADOW_SCENERY_TYPES.has(s.type);
                if (!noShadow) {
                    ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 5;
                }
                if(s.x !== undefined && s.y !== undefined) {
                    ctx.translate(s.x, s.y);
                    if(s.angle !== undefined) ctx.rotate(s.angle);
                }
                
                if (s.type === 'rect') {
                    ctx.fillStyle = s.c;
                    ctx.fillRect(0, 0, s.w, s.h);
                } else if (s.type === 'tree_detailed') {
                    ctx.fillStyle = '#654321'; ctx.fillRect(-4, 0, 8, 25); 
                    ctx.fillStyle = '#1e5128'; ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI*2); ctx.fill();
                    ctx.fillStyle = '#4a7c59'; ctx.beginPath(); ctx.arc(-4, -4, 10, 0, Math.PI*2); ctx.fill();
                } else if (s.type === 'grandstand') {
                    ctx.fillStyle = '#666'; ctx.fillRect(-40, -15, 80, 30);
                    ctx.fillStyle = '#888'; ctx.fillRect(-35, -20, 70, 5); 
                    let colors = ['#00f3ff', '#ff0033', '#fbc531'];
                    for(let r=0; r<3; r++) {
                        ctx.fillStyle = colors[r];
                        for(let d=0; d<15; d++) {
                            ctx.fillRect(-35 + d*5, -10 + r*8, 3, 3);
                        }
                    }
                } else if (s.type === 'pine_tree') {
                    ctx.fillStyle = '#1a4314'; ctx.beginPath(); ctx.moveTo(0, -s.s); ctx.lineTo(s.s*0.8, s.s); ctx.lineTo(-s.s*0.8, s.s); ctx.fill();
                } else if (s.type === 'fence_post') {
                    ctx.fillStyle = '#5c4033'; ctx.fillRect(-2, -2, 4, 4);
                } else if (s.type === 'building_lit') { ctx.shadowBlur = 20; ctx.shadowOffsetY = 15;
                    ctx.fillStyle = s.c; ctx.fillRect(-s.w/2, -s.h/2, s.w, s.h);
                    ctx.fillStyle = '#fbc531';
                    for(let wx = -s.w/2 + 10; wx < s.w/2 - 10; wx += 15) {
                        for(let wy = -s.h/2 + 10; wy < s.h/2 - 10; wy += 15) {
                            if ((wx * wy) % 7 > 2) ctx.fillRect(wx, wy, 8, 8);
                        }
                    }
                } else if (s.type === 'crosswalk') {
                    ctx.fillStyle = '#fff';
                    for(let i=-s.w/2; i<=s.w/2; i+=15) ctx.fillRect(i, -s.h/2, 8, s.h);
                } else if (s.type === 'parking_lot') {
                    ctx.fillStyle = '#6a7179'; ctx.fillRect(-s.w/2, -s.h/2, s.w, s.h);
                    ctx.fillStyle = 'rgba(255,255,255,0.16)';
                    for(let i=-s.w/2 + 16; i<s.w/2 - 10; i+=40) {
                        ctx.fillRect(i, -s.h/2 + 18, 2, s.h - 36);
                    }
                    ctx.fillStyle = 'rgba(0,0,0,0.14)';
                    ctx.fillRect(-s.w/2, -s.h/2, s.w, 12);
                } else if (s.type === 'road_median') {
                    ctx.fillStyle = '#515b3a'; ctx.fillRect(-s.w/2, -s.h/2, s.w, s.h);
                    ctx.fillStyle = '#7d8b57'; ctx.fillRect(-s.w/2 + 6, -s.h/2 + 4, s.w - 12, s.h - 8);
                    ctx.fillStyle = '#d9c27a';
                    for(let i=-s.w/2 + 18; i<s.w/2 - 8; i+=34) ctx.fillRect(i, -2, 10, 4);
                } else if (s.type === 'billboard') {
                    ctx.fillStyle = '#444'; ctx.fillRect(-8, -s.h/2 + 10, 16, s.h + 60);
                    ctx.fillStyle = s.accent || '#222'; ctx.fillRect(-s.w/2, -s.h/2, s.w, s.h);
                    ctx.fillStyle = s.c || '#67d5ff'; ctx.fillRect(-s.w/2 + 8, -s.h/2 + 8, s.w - 16, s.h - 16);
                    ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(-s.w/2 + 12, -s.h/2 + 12, s.w - 24, 18);
                    ctx.fillStyle = '#111'; ctx.font = 'bold 24px Orbitron'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(s.text || 'RACE', 0, 2);
                } else if (s.type === 'streetlight') {
                    ctx.fillStyle = '#444'; ctx.fillRect(-2, -20, 4, 40); 
                    ctx.fillStyle = '#222'; ctx.fillRect(-15, -22, 20, 4); 
                    ctx.fillStyle = '#ffffbb'; ctx.shadowColor = '#fbc531'; ctx.shadowBlur = 15;
                    ctx.beginPath(); ctx.arc(-10, -20, 4, 0, Math.PI*2); ctx.fill(); ctx.shadowBlur = 0;
                } else if (s.type === 'cactus_detailed') {
                    ctx.fillStyle = '#2e5a2e'; ctx.fillRect(-4, -20, 8, 40); 
                    ctx.fillRect(-12, -5, 8, 4); ctx.fillRect(-12, -15, 4, 10); 
                    ctx.fillRect(4, 5, 8, 4); ctx.fillRect(8, -5, 4, 10); 
                } else if (s.type === 'rock_formation') {
                    ctx.fillStyle = '#c1440e';
                    ctx.beginPath();
                    ctx.moveTo(s.pts[0].x, s.pts[0].y);
                    for(let i=1; i<s.pts.length; i++) ctx.lineTo(s.pts[i].x, s.pts[i].y);
                    ctx.closePath(); ctx.fill();
                } else if (s.type === 'sand_dots') {
                    if (!lowDetailDroneView) {
                        ctx.fillStyle = '#b8a882';
                        s.dots.forEach(d => {
                            if (d.x >= cullBounds.minX && d.x <= cullBounds.maxX && d.y >= cullBounds.minY && d.y <= cullBounds.maxY) {
                                ctx.fillRect(d.x, d.y, 3, 3);
                            }
                        });
                    }
                } else if (s.type === 'dune') {
                    let duneGrad = ctx.createLinearGradient(-s.rx, -s.ry, s.rx, s.ry);
                    duneGrad.addColorStop(0, s.c || '#d6b176');
                    duneGrad.addColorStop(0.6, adjustHexColor(s.c || '#d6b176', -10));
                    duneGrad.addColorStop(1, s.shade || '#bc8b54');
                    ctx.fillStyle = duneGrad;
                    ctx.beginPath(); ctx.ellipse(0, 0, s.rx, s.ry, 0, 0, Math.PI * 2); ctx.fill();
                    ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.ellipse(-s.rx * 0.15, -s.ry * 0.12, s.rx * 0.55, s.ry * 0.34, 0, Math.PI, Math.PI * 2); ctx.stroke();
                } else if (s.type === 'desert_scrub') {
                    ctx.strokeStyle = '#7d7c45'; ctx.lineWidth = 2;
                    for(let i=0; i<6; i++) {
                        let ang = (i / 6) * Math.PI * 2;
                        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(ang) * s.s, Math.sin(ang) * s.s * 0.7); ctx.stroke();
                    }
                    ctx.fillStyle = '#8c7b43'; ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
                } else if (s.type === 'cracked_ground') {
                    ctx.strokeStyle = 'rgba(146, 101, 54, 0.55)'; ctx.lineWidth = 1.5;
                    for(let i=0; i<5; i++) {
                        let ang = (i / 5) * Math.PI * 2;
                        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(ang) * s.r, Math.sin(ang) * s.r * 0.6); ctx.stroke();
                    }
                } else if (s.type === 'mountain_peak') {
                    ctx.fillStyle = '#555'; ctx.beginPath(); ctx.moveTo(0, -s.h); ctx.lineTo(s.w, s.h); ctx.lineTo(-s.w, s.h); ctx.fill();
                    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(0, -s.h); ctx.lineTo(s.w*0.3, -s.h*0.4); ctx.lineTo(-s.w*0.3, -s.h*0.4); ctx.fill();
                } else if (s.type === 'cliff_face') {
                    ctx.strokeStyle = '#333'; ctx.lineWidth = 15; ctx.lineJoin = 'bevel';
                    ctx.beginPath(); ctx.moveTo(s.pts[0].x, s.pts[0].y);
                    for(let i=1; i<s.pts.length; i++) ctx.lineTo(s.pts[i].x, s.pts[i].y);
                    ctx.stroke();
                } else if (s.type === 'animated_wave') { ctx.shadowColor = 'transparent';
                    let time = Date.now() / 1000;
                    ctx.strokeStyle = '#6495ED'; ctx.lineWidth = 3;
                    ctx.beginPath();
                    for(let i=0; i<s.w; i+=10) {
                        ctx.lineTo(i, Math.sin(time*2 + i*0.05)*5);
                    }
                    ctx.stroke();
                } else if (s.type === 'palm_tree') {
                    ctx.strokeStyle = '#8B4513'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(0,10); ctx.quadraticCurveTo(5,0, 0,-15); ctx.stroke();
                    ctx.strokeStyle = '#228B22'; ctx.lineWidth = 3;
                    for(let i=0; i<5; i++) {
                        ctx.beginPath(); ctx.moveTo(0,-15); ctx.quadraticCurveTo(Math.cos(i)*15, Math.sin(i)*15 - 20, Math.cos(i)*20, Math.sin(i)*20 - 15); ctx.stroke();
                    }
                } else if (s.type === 'seagull') {
                    let time = Date.now() / 1000;
                    let driftX = (time * 30 + s.offsetX) % 2000 - 500;
                    let driftY = Math.sin(time + s.offsetX) * 20;
                    ctx.translate(driftX, driftY);
                    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
                    ctx.beginPath(); ctx.moveTo(-10, -5); ctx.quadraticCurveTo(-5, 0, 0, -2); ctx.quadraticCurveTo(5, 0, 10, -5); ctx.stroke();
                } else if (s.type === 'runway_markings') {
                    ctx.fillStyle = '#fff';
                    for(let i=0; i<8; i++) {
                        ctx.fillRect(50, -60 + i*17, 100, 8); 
                        ctx.fillRect(s.length - 150, -60 + i*17, 100, 8); 
                    }
                    for(let tz = 300; tz < 1500; tz += 250) {
                        ctx.fillRect(tz, -40, 150, 10);
                        ctx.fillRect(tz, 30, 150, 10);
                        ctx.fillRect(s.length - tz - 150, -40, 150, 10);
                        ctx.fillRect(s.length - tz - 150, 30, 150, 10);
                    }
                } else if (s.type === 'pit_garage') {
                    ctx.fillStyle = '#e67e22'; ctx.fillRect(-s.w/2, -s.h/2, s.w, s.h);
                    ctx.fillStyle = '#222';
                    for(let i=0; i<3; i++) ctx.fillRect(-s.w/2 + 10 + i*60, -s.h/2 + 10, 40, s.h-20);
                } else if (s.type === 'pit_lane') {
                    ctx.fillStyle = '#333'; ctx.fillRect(-s.w/2, -s.h/2, s.w, s.h); 
                    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([10, 10]);
                    ctx.strokeRect(-s.w/2, -s.h/2, s.w, s.h); 
                    ctx.setLineDash([]);
                    ctx.strokeStyle = '#fbc531';
                    for(let i=-s.w/2 + 20; i<s.w/2 - 20; i+=40) {
                        ctx.strokeRect(i, -s.h/2 + 5, 30, s.h - 10);
                    }
                } else if (s.type === 'tire_wall') {
                    for(let i=0; i<s.w; i+=12) {
                        ctx.fillStyle = (i/12)%2===0 ? '#cc0000' : '#ffffff';
                        ctx.fillRect(-s.w/2 + i, -5, 12, 10);
                    }
                } else if (s.type === 'runway_light') { ctx.shadowColor = s.c; ctx.shadowBlur = 15; ctx.shadowOffsetY = 0;
                    ctx.fillStyle = '#FFD700'; ctx.shadowColor = '#FFD700'; ctx.shadowBlur = 10;
                    ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI*2); ctx.fill(); ctx.shadowBlur = 0;
                } else if (s.type === 'airplane') {
                    ctx.fillStyle = s.c;
                    ctx.beginPath(); ctx.roundRect(-25, -120, 50, 240, 25); ctx.fill();
                    ctx.fillStyle = '#111';
                    ctx.beginPath(); ctx.arc(0, -100, 15, 0, Math.PI, true); ctx.fill();
                    ctx.fillStyle = s.c;
                    ctx.beginPath(); ctx.moveTo(-25, -20); ctx.lineTo(-140, 40); ctx.lineTo(-140, 70); ctx.lineTo(-25, 40); ctx.fill();
                    ctx.beginPath(); ctx.moveTo(25, -20); ctx.lineTo(140, 40); ctx.lineTo(140, 70); ctx.lineTo(25, 40); ctx.fill();
                    ctx.fillStyle = '#666'; ctx.fillRect(-80, 20, 15, 30); ctx.fillRect(65, 20, 15, 30);
                    ctx.fillStyle = s.accent;
                    ctx.beginPath(); ctx.moveTo(-10, 90); ctx.lineTo(-40, 130); ctx.lineTo(40, 130); ctx.lineTo(10, 90); ctx.fill();
                    ctx.fillStyle = s.c;
                    ctx.beginPath(); ctx.moveTo(-10, 100); ctx.lineTo(-50, 120); ctx.lineTo(-50, 130); ctx.lineTo(-10, 115); ctx.fill();
                    ctx.beginPath(); ctx.moveTo(10, 100); ctx.lineTo(50, 120); ctx.lineTo(50, 130); ctx.lineTo(10, 115); ctx.fill();
                } else if (s.type === 'circle') { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
                    ctx.fillStyle = s.c; ctx.beginPath(); ctx.arc(0, 0, s.r, 0, Math.PI*2); ctx.fill();
                } else if (s.type === 'airport_floor') {
                    let apronGrad = ctx.createLinearGradient(-s.w/2, -s.h/2, s.w/2, s.h/2);
                    apronGrad.addColorStop(0, '#dde4ec');
                    apronGrad.addColorStop(0.48, '#c9d2dc');
                    apronGrad.addColorStop(1, '#aeb8c3');
                    ctx.fillStyle = apronGrad;
                    ctx.fillRect(-s.w/2, -s.h/2, s.w, s.h);
                    ctx.strokeStyle = 'rgba(120,128,138,0.44)';
                    ctx.lineWidth = 2;
                    for (let i = -s.w/2; i < s.w/2; i += 120) {
                        ctx.beginPath(); ctx.moveTo(i, -s.h/2); ctx.lineTo(i, s.h/2); ctx.stroke();
                    }
                    for (let j = -s.h/2; j < s.h/2; j += 120) {
                        ctx.beginPath(); ctx.moveTo(-s.w/2, j); ctx.lineTo(s.w/2, j); ctx.stroke();
                    }
                    ctx.fillStyle = 'rgba(255,255,255,0.08)';
                    for (let i = -s.w/2 + 70; i < s.w/2; i += 190) ctx.fillRect(i, -s.h/2, 18, s.h);
                    ctx.fillStyle = 'rgba(117,126,136,0.34)';
                    ctx.fillRect(-s.w/2, s.h/2 - 170, s.w, 170);
                    ctx.fillStyle = 'rgba(255,255,255,0.22)';
                    ctx.fillRect(-s.w/2, s.h/2 - 170, s.w, 10);
                } else if (s.type === 'terminal_glass') {
                    ctx.fillStyle = '#59616b'; ctx.fillRect(-s.w/2, -s.h/2, s.w, s.h);
                    let glassGrad = ctx.createLinearGradient(-s.w/2, -s.h/2, s.w/2, s.h/2);
                    glassGrad.addColorStop(0, 'rgba(180,220,255,0.78)');
                    glassGrad.addColorStop(0.55, 'rgba(80,125,170,0.58)');
                    glassGrad.addColorStop(1, 'rgba(28,42,58,0.92)');
                    ctx.fillStyle = glassGrad;
                    ctx.fillRect(-s.w/2 + 8, -s.h/2 + 8, s.w - 16, s.h - 16);
                    ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.lineWidth = 3;
                    for (let i = -s.w/2 + 40; i < s.w/2 - 10; i += 52) {
                        ctx.beginPath(); ctx.moveTo(i, -s.h/2 + 10); ctx.lineTo(i, s.h/2 - 10); ctx.stroke();
                    }
                    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(-s.w/2 + 10, -s.h/2 + 12, s.w - 20, 20);
                } else if (s.type === 'jetbridge') {
                    let bridgeGrad = ctx.createLinearGradient(-s.w/2, -s.h/2, s.w/2, s.h/2);
                    bridgeGrad.addColorStop(0, '#dfe5ec');
                    bridgeGrad.addColorStop(0.55, '#b8c3cf');
                    bridgeGrad.addColorStop(1, '#8b96a1');
                    ctx.fillStyle = '#cfd7df';
                    ctx.beginPath(); ctx.roundRect(-s.w/2, -s.h/2, s.w, s.h, 10); ctx.fill();
                    ctx.fillStyle = bridgeGrad;
                    ctx.beginPath(); ctx.roundRect(-s.w/2 + 4, -s.h/2 + 4, s.w - 8, s.h - 8, 8); ctx.fill();
                    ctx.strokeStyle = 'rgba(70,80,92,0.26)'; ctx.lineWidth = 2;
                    for (let i = -s.w/2 + 24; i < s.w/2 - 10; i += 30) { ctx.beginPath(); ctx.moveTo(i, -s.h/2 + 10); ctx.lineTo(i, s.h/2 - 10); ctx.stroke(); }
                    ctx.fillStyle = 'rgba(150,180,210,0.3)';
                    ctx.fillRect(-s.w/2 + 16, -s.h/2 + 14, s.w - 32, 14);
                    ctx.fillStyle = '#7d8791';
                    ctx.fillRect(-18, s.h/2 - 8, 36, 14);
                } else if (s.type === 'hangar') {
                    ctx.fillStyle = '#79818b'; ctx.fillRect(-s.w/2, -s.h/2, s.w, s.h);
                    ctx.fillStyle = '#646d77'; ctx.beginPath(); ctx.moveTo(-s.w/2, -s.h/2); ctx.lineTo(-s.w/2 + 130, -s.h/2 - 70); ctx.lineTo(s.w/2 - 130, -s.h/2 - 70); ctx.lineTo(s.w/2, -s.h/2); ctx.closePath(); ctx.fill();
                    ctx.fillStyle = '#cfd7df'; ctx.fillRect(-s.w/2 + 120, -s.h/2 + 90, s.w - 240, s.h - 150);
                    ctx.strokeStyle = 'rgba(90,100,110,0.5)'; ctx.lineWidth = 5; ctx.strokeRect(-s.w/2 + 120, -s.h/2 + 90, s.w - 240, s.h - 150);
                } else if (s.type === 'radar_tower') {
                    ctx.strokeStyle = '#c1c9d3'; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(0, s.h/2); ctx.lineTo(0, -s.h/2 + 50); ctx.stroke();
                    ctx.strokeStyle = '#8d97a2'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(-32, s.h/2); ctx.lineTo(0, -10); ctx.lineTo(32, s.h/2); ctx.stroke();
                    ctx.fillStyle = '#dfe7ef'; ctx.beginPath(); ctx.arc(0, -s.h/2 + 28, 22, 0, Math.PI * 2); ctx.fill();
                    ctx.strokeStyle = '#7e8792'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(0, -s.h/2 + 18, 36, -Math.PI * 0.2, Math.PI * 0.8); ctx.stroke();
                } else if (s.type === 'fuel_tank') {
                    let tankGrad = ctx.createRadialGradient(-s.r * 0.2, -s.r * 0.3, 6, 0, 0, s.r);
                    tankGrad.addColorStop(0, '#f0f3f6');
                    tankGrad.addColorStop(0.55, '#d1d7de');
                    tankGrad.addColorStop(1, '#97a1ab');
                    ctx.fillStyle = tankGrad; ctx.beginPath(); ctx.arc(0, 0, s.r, 0, Math.PI * 2); ctx.fill();
                    ctx.strokeStyle = 'rgba(90,100,110,0.5)'; ctx.lineWidth = 4; ctx.stroke();
                    ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fillRect(-s.r * 0.5, -s.r * 0.55, s.r, 12);
                } else if (s.type === 'cargo_stack') {
                    ctx.fillStyle = adjustHexColor(s.c || '#4f7db3', -18); ctx.fillRect(-s.w/2, -s.h/2 + 16, s.w, s.h - 16);
                    ctx.fillStyle = s.c || '#4f7db3'; ctx.fillRect(-s.w/2 + 8, -s.h/2, s.w - 16, s.h - 18);
                    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 2;
                    for (let i = -s.w/2 + 30; i < s.w/2 - 10; i += 46) { ctx.beginPath(); ctx.moveTo(i, -s.h/2 + 8); ctx.lineTo(i, s.h/2 - 20); ctx.stroke(); }
                } else if (s.type === 'service_vehicle') {
                    ctx.fillStyle = s.c || '#f5c542'; ctx.beginPath(); ctx.roundRect(-34, -18, 68, 36, 8); ctx.fill();
                    ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(-12, -14, 26, 12);
                    ctx.fillStyle = '#2d3136'; ctx.fillRect(-24, -22, 18, 6); ctx.fillRect(-24, 16, 18, 6); ctx.fillRect(8, -22, 18, 6); ctx.fillRect(8, 16, 18, 6);
                    ctx.fillStyle = '#ffde66'; ctx.fillRect(26, -9, 8, 8); ctx.fillRect(26, 1, 8, 8);
                } else if (s.type === 'airport_terminal_door') {
                    ctx.fillStyle = '#667180'; ctx.fillRect(-s.w/2, -s.h/2, s.w, s.h);
                    ctx.fillStyle = '#9ad6ff'; ctx.fillRect(-s.w/2 + 14, -s.h/2 + 12, s.w - 28, s.h - 24);
                    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(-s.w/2 + 14, -s.h/2 + 12, s.w - 28, 18);
                    ctx.strokeStyle = '#dce7f2'; ctx.lineWidth = 3;
                    ctx.beginPath(); ctx.moveTo(0, -s.h/2 + 12); ctx.lineTo(0, s.h/2 - 12); ctx.stroke();
                    ctx.fillStyle = '#4d5660'; ctx.fillRect(-s.w/2 + 18, s.h/2 - 14, s.w - 36, 8);
                } else if (s.type === 'airport_shop') {
                    ctx.fillStyle = '#88ccff'; ctx.fillRect(-s.w/2, -s.h/2, s.w, s.h);
                    ctx.fillStyle = '#111'; ctx.font = 'bold 24px Orbitron'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('DUTY FREE', 0, 0);
                } else if (s.type === 'airport_bathroom') {
                    ctx.fillStyle = '#eeeeee'; ctx.fillRect(-s.w/2, -s.h/2, s.w, s.h);
                    ctx.fillStyle = '#111'; ctx.font = 'bold 20px Orbitron'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('RESTROOMS', 0, 0);
                }
                ctx.restore();
            });
        }

        
        
        class MovingHazard {
            constructor(type, startX, startY, endX, endY, speed, size) {
                this.type = type; this.startX = startX; this.startY = startY; 
                this.endX = endX; this.endY = endY; this.speed = speed; this.size = size;
                this.x = startX; this.y = startY;
                let dx = endX - startX, dy = endY - startY;
                this.angle = Math.atan2(dy, dx);
                this.distTotal = Math.sqrt(dx*dx + dy*dy);
                this.progress = 0;
            }
            update() {
                this.progress += this.speed;
                if (this.progress > this.distTotal) this.progress = 0;
                this.x = this.startX + Math.cos(this.angle) * this.progress;
                this.y = this.startY + Math.sin(this.angle) * this.progress;

                // Collision with cars
                cars.forEach(c => {
                    let dx = c.x - this.x, dy = c.y - this.y;
                    if (dx*dx + dy*dy < this.size * this.size) {
                        if (c.shieldTimer > 0) {
                            c.shieldTimer = 0;
                            if (c.isPlayer) audio.playSynth('synthBass', 40, 0, 0.2, 0.5);
                        } else if (c.spinTimer <= 0) {
                            c.spinTimer = 45; c.speed *= 0.2;
                            c.x += Math.cos(this.angle) * 30; // Push
                            c.y += Math.sin(this.angle) * 30;
                            if (c.isPlayer) { cameraShake = Math.max(cameraShake, 12); audio.playSynth('orchestraHit', 35, 0, 1, 0.7); }
                        }
                    }
                });
            }
            draw(ctx) {
                ctx.save(); ctx.translate(this.x, this.y); ctx.rotate(this.angle);
                if (this.type === 'train') {
                    ctx.fillStyle = '#444'; ctx.fillRect(-150, -40, 300, 80);
                    ctx.fillStyle = '#222'; ctx.fillRect(-140, -30, 280, 60);
                    ctx.fillStyle = '#ffcc00'; ctx.fillRect(130, -10, 20, 20); // headlight
                } else if (this.type === 'civilian_car') {
                    ctx.fillStyle = '#3498db'; ctx.fillRect(-30, -20, 60, 40);
                    ctx.fillStyle = '#111'; ctx.fillRect(-10, -18, 30, 36); // roof/windows
                    ctx.fillStyle = '#fff'; ctx.fillRect(25, -15, 5, 10); ctx.fillRect(25, 5, 5, 10); // headlights
                } else if (this.type === 'tumbleweed') {
                    ctx.rotate(this.progress * 0.05);
                    ctx.strokeStyle = '#c2a578'; ctx.lineWidth = 3;
                    for (let i=0; i<5; i++) {
                        ctx.beginPath(); ctx.ellipse(0, 0, 20 + Math.random()*5, 15 + Math.random()*10, i, 0, Math.PI*2); ctx.stroke();
                    }
                }
                ctx.restore();
            }
        }

        
        class LightningStrike {
            constructor(x, y) { this.x = x; this.y = y; this.life = 40; this.impacted = false; }
            update() {
                this.life--;
                if (this.life <= 10 && !this.impacted) {
                    this.impacted = true;
                    cars.forEach(c => {
                        if (dist2(this, c) < 40000) { // 200px radius
                            if (c.shieldTimer > 0) { c.shieldTimer = 0; }
                            else { c.spinTimer = 120; c.speed = 0; if(c.isPlayer) cameraShake = 30; }
                        }
                    });
                }
            }
            draw(ctx) {
                if (this.life <= 0) return;
                ctx.save(); ctx.translate(this.x, this.y);
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 10;
                ctx.shadowColor = '#00f3ff'; ctx.shadowBlur = 30;
                ctx.beginPath();
                ctx.moveTo(0, -1000); ctx.lineTo(-40, -600); ctx.lineTo(40, -400); ctx.lineTo(0, 0);
                ctx.stroke();
                if (this.impacted) {
                    ctx.fillStyle = 'rgba(255,255,255,0.8)';
                    ctx.beginPath(); ctx.arc(0,0,100,0,Math.PI*2); ctx.fill();
                }
                ctx.restore();
            }
        }

        class ZoneHazard {
            constructor(type, x, y, radius, dirX, dirY, force) {
                this.type = type; this.x = x; this.y = y; this.radius = radius; 
                this.dirX = dirX; this.dirY = dirY; this.force = force;
                this.animOffset = 0;
            }
            update() {
                this.animOffset += 2;
                cars.forEach(c => {
                    let dx = c.x - this.x, dy = c.y - this.y;
                    if (dx*dx + dy*dy < this.radius * this.radius) {
                        if (this.type === 'wind' || this.type === 'conveyor') {
                            c.x += this.dirX * this.force;
                            c.y += this.dirY * this.force;
                            if (Math.random() < 0.2) fx.addParticle(c.x, c.y, this.dirX*5, this.dirY*5, 3, '#fff', 15, false);
                        } else if (this.type === 'teleporter' && c.teleportCooldown <= 0) {
                            c.x = this.dirX; c.y = this.dirY;
                            c.teleportCooldown = 60;
                            if(c.isPlayer) audio.playSynth('trumpet', 84, Tone.now(), 0.5, 0.4);
                            fx.addParticle(c.x, c.y, 0, 0, 50, '#ff00ea', 20, false);
                        }
                    }
                });
            }
            draw(ctx) {
                ctx.save(); ctx.translate(this.x, this.y);
                if (this.type === 'wind') {
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'; ctx.lineWidth = 4;
                    for(let i=0; i<5; i++) {
                        let px = (this.animOffset + i*40) % (this.radius*2) - this.radius;
                        let py = (Math.sin(px*0.05) * 20);
                        let ang = Math.atan2(this.dirY, this.dirX);
                        ctx.save(); ctx.rotate(ang); ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + 20, py); ctx.stroke(); ctx.restore();
                    }
                } else if (this.type === 'teleporter') {
                    ctx.rotate(this.animOffset * 0.05);
                    let grad = ctx.createRadialGradient(0,0,0, 0,0,this.radius);
                    grad.addColorStop(0, 'rgba(255, 0, 234, 0.8)');
                    grad.addColorStop(1, 'rgba(0, 243, 255, 0)');
                    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(0,0,this.radius,0,Math.PI*2); ctx.fill();
                    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
                }
                ctx.restore();
            }
        }
        
        class Coin {
            constructor(x, y) { this.x = x; this.y = y; this.active = true; this.angle = 0; }
            update() { this.angle += 0.1; }
            draw(ctx) {
                if (!this.active) return;
                ctx.save(); ctx.translate(this.x, this.y); ctx.rotate(this.angle); ctx.scale(Math.sin(Date.now()/200)*0.5+0.8, 1);
                ctx.shadowColor = '#ffcc00'; ctx.shadowBlur = 15; ctx.shadowOffsetY = 10; ctx.fillStyle = '#ffcc00'; ctx.beginPath(); ctx.arc(0,0,14,0,Math.PI*2); ctx.fill();
                ctx.strokeStyle = '#ff9900'; ctx.lineWidth = 3; ctx.stroke();
                ctx.fillStyle = '#b8860b'; ctx.font = 'bold 16px Orbitron'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('$', 0, 0);
                ctx.restore();
            }
        }
        class ItemBox {
            constructor(x, y) { this.x = x; this.y = y; this.active = true; this.respawnTimer = 0; this.angle = 0; }
            update() {
                this.angle += 0.05;
                if (!this.active) { this.respawnTimer--; if (this.respawnTimer <= 0) this.active = true; }
            }
            draw(ctx) {
                if (!this.active) return;
                ctx.save();
                this.yOffset = Math.sin(Date.now() / 200) * 10;
                ctx.translate(this.x, this.y + this.yOffset); ctx.rotate(this.angle);
                ctx.shadowColor = '#00f3ff'; ctx.shadowBlur = 20; ctx.fillStyle = 'rgba(0, 255, 255, 0.4)'; ctx.fillRect(-25, -25, 50, 50);
                ctx.strokeStyle = '#00f3ff'; ctx.lineWidth = 4; ctx.strokeRect(-25, -25, 50, 50);
                ctx.fillStyle = '#fff'; ctx.font = 'bold 36px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText('?', 0, 0);
                ctx.restore();
            }
        }
        class Projectile {
            constructor(x, y, angle, type, owner) {
                this.x = x; this.y = y; this.angle = angle; this.type = type; this.owner = owner;
                this.speed = type === 'Laser' ? 40 : 25;
                this.life = type === 'Laser' ? 80 : 300;
                this.target = null;
                if (type === 'Missile') {
                    let bestDist = Infinity;
                    cars.forEach(c => {
                        if (c !== owner) {
                            let dx = c.x - this.x, dy = c.y - this.y;
                            let ang = Math.atan2(dy, dx);
                            let angDiff = Math.abs(normalizeAngle(ang - this.angle));
                            let d2 = dx*dx + dy*dy;
                            if (angDiff < Math.PI/2 && d2 < bestDist) { bestDist = d2; this.target = c; }
                        }
                    });
                }
            }
            update() {
                this.life--;
                if (this.type === 'Missile' && this.target) {
                    let dx = this.target.x - this.x, dy = this.target.y - this.y;
                    let targetAngle = Math.atan2(dy, dx);
                    this.angle += normalizeAngle(targetAngle - this.angle) * 0.1;
                }
                this.x += Math.cos(this.angle) * this.speed;
                this.y += Math.sin(this.angle) * this.speed;
                
                fx.addParticle(this.x, this.y, 0, 0, 4, this.type === 'Laser' ? '#ff00ea' : '#ff3300', 15, false);
                
                cars.forEach(c => {
                    if (c !== this.owner && dist2(this, c) < 2500) {
                        this.life = 0;
                        if (c.shieldTimer > 0) { c.shieldTimer = 0; if(c.isPlayer) audio.playShieldBreak(); }
                        else {
                            c.spinTimer = 45; c.speed *= 0.3;
                            if (c.isPlayer) cameraShake = Math.max(cameraShake, 10);
                            if (c.isPlayer || this.owner.isPlayer) audio.playExplosion();
                        }
                    }
                });
            }
            draw(ctx) {
                ctx.save();
                this.yOffset = Math.sin(Date.now() / 200) * 10;
                ctx.translate(this.x, this.y + this.yOffset); ctx.rotate(this.angle);
                if (this.type === 'Laser') {
                    ctx.strokeStyle = '#ff00ea'; ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(-30, 0); ctx.lineTo(30, 0); ctx.stroke();
                } else {
                    ctx.fillStyle = '#ff3300'; ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI*2); ctx.fill();
                    ctx.fillStyle = '#fff'; ctx.fillRect(-20, -6, 20, 12);
                }
                ctx.restore();
            }
        }
        class Trap {
            constructor(x, y, type, owner) {
                this.x = x; this.y = y; this.type = type; this.owner = owner; this.life = 3000; this.activeDelay = 30;
            }
            update() {
                this.life--;
                if (this.activeDelay > 0) this.activeDelay--;
                else {
                    cars.forEach(c => {
                        if (dist2(this, c) < 2500) {
                            this.life = 0;
                            fx.addParticle(this.x, this.y, 0, 0, 30, '#ffaa00', 20, false);
                            if (c.shieldTimer > 0) { c.shieldTimer = 0; if(c.isPlayer) audio.playShieldBreak(); }
                            else {
                                c.spinTimer = 60; c.speed *= 0.3;
                                if (c.isPlayer) cameraShake = Math.max(cameraShake, 15);
                                if (c.isPlayer || this.owner.isPlayer) audio.playExplosion();
                            }
                        }
                    });
                }
            }
            draw(ctx) {
                ctx.save(); ctx.translate(this.x, this.y);
                ctx.fillStyle = '#222'; ctx.beginPath(); ctx.arc(0, 0, 16, 0, Math.PI*2); ctx.fill();
                ctx.fillStyle = '#ff0000'; ctx.beginPath(); ctx.arc(0, 0, 8, 0, Math.PI*2); ctx.fill();
                if (this.life % 20 < 10) { ctx.fillStyle = '#ffff00'; ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI*2); ctx.fill(); }
                ctx.restore();
            }
        }

        // --- Car Class ---
        class Car {
            constructor(x, y, color, isPlayer, id, tier, isRemote = false) {
                this.id = id;
                this.x = x; this.y = y;
                this.width = 24; this.height = 44;
                this.color = color;
                this.isPlayer = isPlayer;
                this.tier = tier;
                this.isRemote = isRemote;
                this.effect = isPlayer ? playerCustomEffect : 'None';
                
                this.targetX = x;
                this.targetY = y;
                this.targetAngle = 0;

                this.speed = 0;
                
                let wSpeedMod = 1.0;
                let wHandMod = 1.0;
                if (config.weather === 'Rain') { wSpeedMod = 0.85; wHandMod = 0.8; }
                else if (config.weather === 'Storm') { wSpeedMod = 0.75; wHandMod = 0.7; }
                else if (config.weather === 'Snow') { wSpeedMod = 0.8; wHandMod = 0.6; }
                else if (config.weather === 'Blizzard') { wSpeedMod = 0.6; wHandMod = 0.4; }
                else if (config.weather === 'Hurricane') { wSpeedMod = 0.5; wHandMod = 0.5; }

                if (this.isPlayer) {
                    let pIdx = (this.id === 'Player 2' || (typeof player !== 'undefined' && player)) ? selectedCarIndex2 : selectedCarIndex;
                    if (typeof player !== 'undefined' && player && this !== player) pIdx = selectedCarIndex2;
                    else pIdx = selectedCarIndex;
                    
                    let ct = carTypes[pIdx];
                    this.maxSpeed = ct.maxSpeed * wSpeedMod;
                    this.baseAcceleration = ct.baseAcceleration;
                    this.turnSpeed = ct.turnSpeed * wHandMod;
                } else {
                    let ct = carTypes[selectedCarIndex] || carTypes[2];
                    let upgSpeed = 1 + playerUpgrades.speed * 0.05;
                    let upgAccel = 1 + playerUpgrades.accel * 0.10;
                    let upgHand = 1 + playerUpgrades.handling * 0.08;
                    this.maxSpeed = ct.maxSpeed * wSpeedMod * upgSpeed;
                    this.baseAcceleration = ct.baseAcceleration * upgAccel;
                    this.turnSpeed = ct.turnSpeed * wHandMod * upgHand;
                }

                let tierSkill = this.tier ? (((this.tier.speedMult || 1) + (this.tier.accelMult || 1) + (this.tier.turnMult || 1)) / 3) : 1;
                let difficultySkill = config.difficulty === 'Hard' ? 1.14 : (config.difficulty === 'Easy' ? 1.0 : 1.08);
                this.aiSkill = this.isPlayer ? 1 : tierSkill * difficultySkill;
                this.aiPrecision = this.isPlayer ? 1 : Math.min(0.992, 0.88 + this.aiSkill * 0.14);
                this.aiCornerGrip = this.isPlayer ? 1 : Math.min(1.38, 1.04 + this.aiSkill * 0.24);
                this.aiRecoverySkill = this.isPlayer ? 1 : Math.min(1.58, 1.12 + this.aiSkill * 0.32);
                this.aiLookaheadScale = this.isPlayer ? 1 : Math.min(1.52, 1.12 + this.aiSkill * 0.3);
                this.aiNitroSkill = this.isPlayer ? 1 : Math.min(1.48, 1.08 + this.aiSkill * 0.3);
                this.aiPaceComp = this.isPlayer ? 1 : Math.min(1.38, 1.18 + Math.max(0, this.aiSkill - 0.72) * 0.42);
                this.aiLineVariance = this.isPlayer ? 0 : config.trackWidth * (0.008 + Math.max(0.004, 1 - this.aiPrecision) * 0.09);
                this.aiPreferredSide = this.isPlayer ? 0 : (Math.random() > 0.5 ? 1 : -1);
                this.aiAttackBias = this.isPlayer ? 1 : Math.min(1.6, 1.04 + Math.max(0, this.aiSkill - 0.6) * 0.82);
                
                this.acceleration = this.baseAcceleration;
                this.braking = 0.5;
                this.reverseSpeed = 4;
                this.angle = 0; 
                this.lastAngle = this.angle;
                
                this.lap = 0;
                this.distanceDriven = 0; 
                this.finished = false;
                this.isOffRoad = false;
                this.onTrack = true;
                this.offTrackTimer = 0;
                
                this.aiTargetWaypoint = 1;
                this.aiError = (Math.random() - 0.5) * (this.aiLineVariance || 0);

                this.lastX = x;
                this.lastY = y;
                this.stuckFrames = 0;
                this.reverseTimer = 0;
                this.currentSegment = 0;
                this.jumpTimer = 0;
                this.spinTimer = 0;
                this.item = null;
                this.itemRouletteTimer = 0;
                this.shieldTimer = 0;
                this.isDrifting = false;
                this.driftTimer = 0;
                this.driftDir = 1;
                this.miniTurboTimer = 0;
                this.wallContactFrames = 0;
                this.wallNormalX = 0;
                this.wallNormalY = 0;
                this.wallTrackAngle = 0;

                this.teleportTimer = 0;
                this.teleportStartX = 0;
                this.teleportStartY = 0;
                this.teleportEndX = 0;
                this.teleportEndY = 0;
                this.teleportCooldown = 0;

                // Nitro system variables
                this.nitro = 100;
                this.nitroActive = false;
                this.nitroLocked = false;
                this.aiUpcomingTurn = 0;
                this.aiAlignmentError = 0;
                this.aiCornerCharge = 0;

                // Drafting system
                this.isDrafting = false;
                
                if (this.tier && this.tier.name === 'RIVAL') {
                    this.aiNitroTimer = (Math.random() * 1.0 + 1.2) * config.fps / (this.aiNitroSkill || 1); 
                } else {
                    this.aiNitroTimer = (Math.random() * 1.3 + 1.5) * config.fps / (this.aiNitroSkill || 1); 
                }
                
                // Weather slip physics
                this.slipTimer = 0;
                this.slipForce = 0;
            }

            update(keys) {
                if (this.isRemote) {
                    this.x += (this.targetX - this.x) * 0.2;
                    this.y += (this.targetY - this.y) * 0.2;
                    this.angle += normalizeAngle(this.targetAngle - this.angle) * 0.2;
                    return;
                }
                if (this.teleportTimer > 0) {
                    this.teleportTimer--;
                    let t = 1 - (this.teleportTimer / 18); // 0 to 1 over 18 frames (0.3s)
                    let ease = 1 - Math.pow(1 - t, 3); // ease out cubic
                    this.x = this.teleportStartX + (this.teleportEndX - this.teleportStartX) * ease;
                    this.y = this.teleportStartY + (this.teleportEndY - this.teleportStartY) * ease;
                    if (this.teleportTimer === 0) {
                        this.isOffRoad = false;
                        this.onTrack = true;
                        this.stuckFrames = 0;
                        this.wallContactFrames = 0;
                    }
                } else {
                    if (gameState === 'PLAYING' || gameState === 'OPEN_WORLD' || this.finished) {

                        // Drafting Logic: Check if following closely behind another car
                        this.isDrafting = false;
                        if (!this.isOffRoad) {
                            for (let other of cars) {
                                if (other === this || other.isOffRoad) continue;
                                let dx = other.x - this.x;
                                let dy = other.y - this.y;
                                let distSq = dx*dx + dy*dy;
                                
                                // Check distance range (roughly 30 to 250 pixels away)
                                if (distSq > 900 && distSq < 62500) {
                                    let angleToOther = Math.atan2(dy, dx);
                                    let angleDiff = Math.abs(normalizeAngle(angleToOther - this.angle));
                                    let otherAngleDiff = Math.abs(normalizeAngle(other.angle - this.angle));
                                    
                                    // Must be aiming at them, and they must be aiming similarly
                                    if (angleDiff < 0.25 && otherAngleDiff < 0.5) {
                                        this.isDrafting = true;
                                        break;
                                    }
                                }
                            }
                        }

                        // Nitro Logic
                        let wantsNitro = false;
                        if (this.isPlayer) {
                            if (gameMode === 'LOCAL_MULTIPLAYER') {
                                wantsNitro = (this === player) ? (keys['Shift']) : keys['/'];
                            } else {
                                wantsNitro = keys['Shift'] || keys['Nitro'];
                            }
                        } else {
                            this.aiNitroTimer--;
                            let straightEnough = (this.aiUpcomingTurn || 0) < Math.PI * 0.24;
                            let alignedEnough = Math.abs(this.aiAlignmentError || 0) < 0.32;
                            let chasingLead = racePositions.length > 0 && racePositions[0] !== this;
                            let exitBoostWindow = (this.aiUpcomingTurn || 0) < Math.PI * 0.12 || this.miniTurboTimer > 0;
                            if (this.aiNitroTimer <= 0 && this.nitro > 12 && this.onTrack && straightEnough && alignedEnough && this.speed > this.maxSpeed * (chasingLead ? 0.58 : 0.7)) {
                                wantsNitro = true;
                            } else if (chasingLead && this.nitro > 24 && this.onTrack && exitBoostWindow && alignedEnough && this.speed > this.maxSpeed * 0.64) {
                                wantsNitro = true;
                            }
                        }

                        if (wantsNitro && this.nitro > 0 && !this.nitroLocked && !this.isOffRoad) {
                            if (!this.nitroActive && this.isPlayer) audio.playNitroBoost();
                            this.nitroActive = true;
                            this.nitro -= 20 / config.fps;
                            if (this.nitro <= 0) {
                                this.nitro = 0;
                                this.nitroActive = false;
                                this.nitroLocked = true;
                                if (!this.isPlayer) {
                                    this.aiNitroTimer = (Math.random() * 0.9 + 1.0) * config.fps / (this.aiNitroSkill || 1);
                                }
                            }
                        } else {
                            this.nitroActive = false;
                            if (!this.isPlayer && this.aiNitroTimer <= 0) {
                                this.aiNitroTimer = (Math.random() * 0.7 + 0.9) * config.fps / (this.aiNitroSkill || 1);
                            }
                            if (this.onTrack) {
                                this.nitro += 8 / config.fps;
                                let maxN = this.isPlayer ? 100 + playerUpgrades.nitro * 20 : 100;
                                if (this.nitro > maxN) this.nitro = maxN;
                                if (this.nitroLocked && this.nitro >= 20) {
                                    this.nitroLocked = false;
                                }
                            }
                        }

                        if (this.isPlayer && !this.finished) {
                            this.handlePlayerInput(keys);
                        } else {
                            this.handleAI();
                        }

                        // Car-to-Car Collisions (All cars)
                        let wasCollisionPushed = false;
                        cars.forEach(other => {
                            if (other !== this) {
                                let dx = this.x - other.x;
                                let dy = this.y - other.y;
                                let distSq = dx*dx + dy*dy;
                                if (distSq > 0 && distSq < 900) {
                                    let dist = Math.sqrt(distSq);
                                    let overlap = 30 - dist;

                                    // Push apart (reduced factor to limit double-push)
                                    this.x += (dx / dist) * overlap * 0.3;
                                    this.y += (dy / dist) * overlap * 0.3;
                                    wasCollisionPushed = true;

                                    // Sparks
                                    if (Math.abs(this.speed - other.speed) > 2 || Math.abs(this.speed) > 5) {
                                        if (Math.random() < 0.3) {
                                            let midX = (this.x + other.x) / 2;
                                            let midY = (this.y + other.y) / 2;
                                            fx.addParticle(midX, midY, (Math.random()-0.5)*5, (Math.random()-0.5)*5, 2 + Math.random()*2, '#ffaa00', 20, false);
                                            fx.addParticle(midX, midY, (Math.random()-0.5)*5, (Math.random()-0.5)*5, 1 + Math.random()*2, '#ffffff', 15, false);
                                        }
                                    }
                                }
                            }
                        });

                        // Post-collision boundary clamp: prevent push through walls
                        if (wasCollisionPushed && activeWaypoints.length > 0) {
                            let seg = this.currentSegment || 0;
                            let outerWallDist = config.trackWidth / 2 + 60;
                            let bestDistSq = Infinity;
                            let bestPt = null;
                            for (let offset = -1; offset <= 1; offset++) {
                                let idx = (seg + offset + activeWaypoints.length) % activeWaypoints.length;
                                let a = activeWaypoints[idx], b = activeWaypoints[(idx + 1) % activeWaypoints.length];
                                let l2 = dist2(a, b);
                                let t = Math.max(0, Math.min(1, ((this.x - a.x) * (b.x - a.x) + (this.y - a.y) * (b.y - a.y)) / (l2 || 1)));
                                let pt = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
                                let d2 = dist2(this, pt);
                                if (d2 < bestDistSq) { bestDistSq = d2; bestPt = pt; }
                            }
                            if (bestPt && bestDistSq > outerWallDist * outerWallDist) {
                                let d = Math.sqrt(bestDistSq);
                                let nx = (this.x - bestPt.x) / d;
                                let ny = (this.y - bestPt.y) / d;
                                this.x = bestPt.x + nx * (outerWallDist - 1);
                                this.y = bestPt.y + ny * (outerWallDist - 1);
                            }
                        }
                    }

                                    // --- Map Features & Hazards ---
                let map = mapsData[currentMapIndex];
                if (map.features) {
                    map.features.forEach(f => {
                        if (f.type === 'boost' || f.type === 'ramp' || f.type === 'oil') {
                            let dx = this.x - f.x;
                            let dy = this.y - f.y;
                            if (dx*dx + dy*dy < 10000) { // ~100px radius
                                if (f.type === 'boost') {
                                    this.speed = this.maxSpeed * 1.5;
                                    this.nitro = Math.min(100, this.nitro + 5);
                                    if (this.isPlayer) cameraShake = Math.max(cameraShake, 5);
                                } else if (f.type === 'ramp') {
                                    if (this.jumpTimer <= 0) {
                                        this.jumpTimer = 40;
                                        if (this.isPlayer) audio.playSynth('trumpet', 72 + Math.random()*12, Tone.now(), 0.2, 0.4);
                                    }
                                } else if (f.type === 'oil') {
                                    if (this.spinTimer <= 0 && this.jumpTimer <= 0) {
                                        this.spinTimer = 30;
                                        this.speed *= 0.5;
                                    }
                                }
                            }
                        }
                    });
                }
                
                if (this.jumpTimer > 0) {
                    this.jumpTimer--;
                    this.onTrack = true; // Ignore offroad while jumping
                }
                
                if (this.spinTimer > 0) {
                    this.spinTimer--;
                    this.angle += 0.3;
                    this.targetAngle = this.angle;
                }

                    this.applyFrictionAndMovement();

                    if (this.effect === 'Trails' && Math.abs(this.speed) > 2) {
                        if (Math.random() < 0.4) {
                            let trailX = this.x - Math.cos(this.angle) * this.height/2;
                            let trailY = this.y - Math.sin(this.angle) * this.height/2;
                            fx.addParticle(trailX, trailY, 0, 0, 3 + Math.random()*2, this.color, 30, false);
                        }
                    }

                    if (this.teleportCooldown > 0) this.teleportCooldown--;

                    // AI Aggressive Stuck/Teleport Logic Check
                    if (!this.isPlayer && gameState === 'PLAYING') {
                        let moveDistSq = dist2({x: this.x, y: this.y}, {x: this.lastX, y: this.lastY});
                        let wallLocked = (this.wallContactFrames || 0) > 16;
                        let wallSliding = (this.wallContactFrames || 0) > 26;
                        let lowMovement = moveDistSq < (wallLocked ? 20 : 4);
                        let lowEffectiveSpeed = Math.abs(this.speed) < (wallLocked ? this.maxSpeed * 0.32 : 1.0);
                        
                        if (this.reverseTimer > 0) {
                            this.reverseTimer--;
                        } else if ((lowEffectiveSpeed && lowMovement) || (wallLocked && moveDistSq < 42) || wallSliding) {
                            this.stuckFrames += wallSliding ? 3 : (wallLocked ? 2 : 1);
                            if ((wallLocked || wallSliding) && this.stuckFrames > 18 && !this.isOffRoad) {
                                this.reverseTimer = wallSliding ? 28 : 18;
                                this.stuckFrames = 18;
                            }
                            if (this.stuckFrames > (wallLocked ? 60 : 120) && this.teleportCooldown <= 0) { // Teleport faster when wall-locked
                                // Find nearest waypoint by direct distance
                                let closestIdx = 0;
                                let closestDistSq = Infinity;
                                for (let i = 0; i < activeWaypoints.length; i++) {
                                    let d2 = dist2(this, activeWaypoints[i]);
                                    if (d2 < closestDistSq) { closestDistSq = d2; closestIdx = i; }
                                }

                                let targetWP = activeWaypoints[closestIdx];
                                let nextIdx = (closestIdx + 1) % activeWaypoints.length;
                                let nextWP = activeWaypoints[nextIdx];

                                // Place slightly forward along track to avoid landing at sharp corners
                                let fwdDx = nextWP.x - targetWP.x;
                                let fwdDy = nextWP.y - targetWP.y;
                                let fwdLen = Math.sqrt(fwdDx * fwdDx + fwdDy * fwdDy) || 1;
                                let offsetDist = Math.min(60, fwdLen * 0.2);

                                this.teleportStartX = this.x;
                                this.teleportStartY = this.y;
                                this.teleportEndX = targetWP.x + (fwdDx / fwdLen) * offsetDist;
                                this.teleportEndY = targetWP.y + (fwdDy / fwdLen) * offsetDist;
                                this.teleportTimer = 18;
                                this.teleportCooldown = 180;

                                // Sync waypoint index and aim forward
                                this.aiTargetWaypoint = nextIdx;
                                this.angle = Math.atan2(fwdDy, fwdDx);
                                this.speed = this.maxSpeed * 0.4;
                                this.stuckFrames = 0;
                            }
                        } else {
                            this.stuckFrames = Math.max(0, this.stuckFrames - 2);
                        }
                        this.lastX = this.x;
                        this.lastY = this.y;
                    }
                }

                this.checkCheckpoints();
                
                // Track angular velocity
                let angVel = Math.abs(normalizeAngle(this.angle - this.lastAngle));
                this.lastAngle = this.angle;

                // FX Generation
                if (gameState === 'PLAYING' || gameState === 'FINISHED') {
                    let speedKmh = Math.abs(this.speed * 12);
                    let isTurningHard = angVel > 0.025;
                    let isAccelerating = this.isPlayer ? (keys['ArrowUp'] || keys['w'] || keys['btn-up']) : (this.speed > 0 && Math.abs(this.speed) < this.maxSpeed);

                    let rearX = this.x - Math.cos(this.angle) * (this.height * 0.4);
                    let rearY = this.y - Math.sin(this.angle) * (this.height * 0.4);
                    let perpX = Math.cos(this.angle + Math.PI/2);
                    let perpY = Math.sin(this.angle + Math.PI/2);
                    let rlX = rearX - perpX * (this.width * 0.4);
                    let rlY = rearY - perpY * (this.width * 0.4);
                    let rrX = rearX + perpX * (this.width * 0.4);
                    let rrY = rearY + perpY * (this.width * 0.4);

                    // Nitro Flames (Orange/Yellow)
                    if (this.nitroActive) {
                        fx.addParticle(rearX, rearY, -Math.cos(this.angle)*5 + (Math.random()-0.5), -Math.sin(this.angle)*5 + (Math.random()-0.5), 4 + Math.random()*2, '#ffaa00', 15, false);
                        fx.addParticle(rearX, rearY, -Math.cos(this.angle)*6 + (Math.random()-0.5), -Math.sin(this.angle)*6 + (Math.random()-0.5), 2 + Math.random()*3, '#ff3300', 10, false);
                    }

                    // Drafting wind trails
                    if (this.isDrafting && this.speed > this.maxSpeed * 0.8) {
                        let frontX = this.x + Math.cos(this.angle) * (this.height * 0.5);
                        let frontY = this.y + Math.sin(this.angle) * (this.height * 0.5);
                        let sideX = Math.cos(this.angle + Math.PI/2) * (this.width * 0.7);
                        let sideY = Math.sin(this.angle + Math.PI/2) * (this.width * 0.7);

                        if (Math.random() < 0.4) {
                            fx.addParticle(frontX + sideX, frontY + sideY, -Math.cos(this.angle)*this.speed*0.6, -Math.sin(this.angle)*this.speed*0.6, 1.5, 'rgba(255,255,255,0.6)', 15, false);
                            fx.addParticle(frontX - sideX, frontY - sideY, -Math.cos(this.angle)*this.speed*0.6, -Math.sin(this.angle)*this.speed*0.6, 1.5, 'rgba(255,255,255,0.6)', 15, false);
                        }
                    }

                    // Skids & Drift Smoke
                    if (this.onTrack && speedKmh > 60 && isTurningHard && config.weather === 'Clear') {
                        fx.addSkidMark(rlX, rlY, this.angle);
                        fx.addSkidMark(rrX, rrY, this.angle);

                        if (Math.random() < 0.4) {
                            fx.addParticle(rlX, rlY, (Math.random()-0.5)*1, (Math.random()-0.5)*1, 4 + Math.random()*3, '#e0e0e0', 60, true);
                            fx.addParticle(rrX, rrY, (Math.random()-0.5)*1, (Math.random()-0.5)*1, 4 + Math.random()*3, '#e0e0e0', 60, true);
                        }
                    }
                    
                    // Drifting Sparks
                    if (this.isDrifting) {
                        fx.addSkidMark(rlX, rlY, this.angle);
                        fx.addSkidMark(rrX, rrY, this.angle);
                        let sparkColor = '#00f3ff'; // Blue
                        if (this.driftTimer > 120) sparkColor = '#ff00ea'; // Pink
                        else if (this.driftTimer > 60) sparkColor = '#ffaa00'; // Orange
                        
                        if (Math.random() < 0.6) {
                            fx.addParticle(rlX, rlY, (Math.random()-0.5)*4, (Math.random()-0.5)*4, 2 + Math.random()*2, sparkColor, 20, false);
                            fx.addParticle(rrX, rrY, (Math.random()-0.5)*4, (Math.random()-0.5)*4, 2 + Math.random()*2, sparkColor, 20, false);
                        }
                    }
                    
                    // Mini Turbo Flames
                    if (this.miniTurboTimer > 0) {
                        fx.addParticle(rearX, rearY, -Math.cos(this.angle)*5 + (Math.random()-0.5)*2, -Math.sin(this.angle)*5 + (Math.random()-0.5)*2, 3 + Math.random()*3, '#00f3ff', 15, false);
                    }

                    // Exhaust / Dust
                    if (this.isOffRoad && Math.abs(this.speed) > 2) {
                        if (Math.random() < 0.5) {
                            let dustColor = currentMapIndex === 3 || currentMapIndex === 7 ? '#c4a882' : '#7a6a5a'; 
                            if (config.weather !== 'Clear') dustColor = '#3a4a3a'; // muddy if wet
                            fx.addParticle(rlX, rlY, -Math.cos(this.angle)*2 + (Math.random()-0.5), -Math.sin(this.angle)*2 + (Math.random()-0.5), 3 + Math.random()*3, dustColor, 30, true);
                            fx.addParticle(rrX, rrY, -Math.cos(this.angle)*2 + (Math.random()-0.5), -Math.sin(this.angle)*2 + (Math.random()-0.5), 3 + Math.random()*3, dustColor, 30, true);
                        }
                    } else if (isAccelerating && Math.random() < 0.3) {
                        fx.addParticle(rearX, rearY, -Math.cos(this.angle)*1 + (Math.random()-0.5), -Math.sin(this.angle)*1 + (Math.random()-0.5), 2 + Math.random()*2, '#aaaaaa', 30, false);
                    }
                }
            }

            handlePlayerInput(keys) {
                let controls = {
                    up: keys['ArrowUp'] || keys['w'],
                    down: keys['ArrowDown'] || keys['s'],
                    left: keys['ArrowLeft'] || keys['a'],
                    right: keys['ArrowRight'] || keys['d'],
                    nitro: keys['Shift'] || keys['Nitro'],
                    item: keys['e'] || keys['E'] || keys['Enter']
                };
                
                if (gameMode === 'LOCAL_MULTIPLAYER') {
                    if (this === player) {
                        controls = {
                            up: keys['w'] || keys['W'],
                            down: keys['s'] || keys['S'],
                            left: keys['a'] || keys['A'],
                            right: keys['d'] || keys['D'],
                            nitro: keys['Shift'],
                            item: keys['e'] || keys['E']
                        };
                    } else if (this === player2) {
                        controls = {
                            up: keys['ArrowUp'],
                            down: keys['ArrowDown'],
                            left: keys['ArrowLeft'],
                            right: keys['ArrowRight'],
                            nitro: keys['/'],
                            item: keys['Enter']
                        };
                    }
                }
                // Incorporate drafting & mini-turbo boosts into physics limits
                let boostMult = 1;
                if (this.nitroActive) boostMult = 2.0;
                else if (this.miniTurboTimer > 0) boostMult = 1.8;
                else if (this.isDrafting) boostMult = 1.3;
                
                let upgSpeed = this.isPlayer ? 1 + playerUpgrades.speed * 0.05 : 1;
                let upgAccel = this.isPlayer ? 1 + playerUpgrades.accel * 0.10 : 1;

                let currentAccel = this.baseAcceleration * boostMult * upgAccel;
                let currentMaxSpeed = this.maxSpeed * boostMult * upgSpeed;
                
                if (this.miniTurboTimer > 0) this.miniTurboTimer--;
                if (controls.item && this.item && this.itemRouletteTimer <= 0) this.useItem();

                if (controls.up) this.speed += currentAccel;
                else if (controls.down) this.speed -= this.braking;

                if (this.speed > currentMaxSpeed) this.speed = currentMaxSpeed;
                if (this.speed < -this.reverseSpeed) this.speed = -this.reverseSpeed;

                let isScreeching = false;

                if (Math.abs(this.speed) > 0.1) {
                    let dir = this.speed > 0 ? 1 : -1;
                    let turnRatio = Math.abs(this.speed) / currentMaxSpeed;
                    let isTurning = false;
                    let upgHand = this.isPlayer ? 1 + playerUpgrades.handling * 0.08 : 1;
                    
                    if (controls.left) { this.angle -= this.turnSpeed * dir * turnRatio * upgHand; isTurning = true; }
                    if (controls.right) { this.angle += this.turnSpeed * dir * turnRatio * upgHand; isTurning = true; }
                    
                    // Refined Drifting Logic
                    let wantsToDrift = (this === player && gameMode === 'LOCAL_MULTIPLAYER') ? keys['Shift'] : (keys[' '] || (this === player2 && keys['/']));
                    let canInitiateDrift = wantsToDrift && isTurning && this.speed > this.maxSpeed * 0.4 && this.onTrack;
                    
                    if ((this.isDrifting && wantsToDrift && this.onTrack && this.speed > this.maxSpeed * 0.3) || canInitiateDrift) {
                        if (!this.isDrifting) {
                            this.isDrifting = true;
                            this.driftTimer = 0;
                            this.driftDir = (keys['ArrowLeft'] || keys['a']) ? -1 : 1;
                            if (this.jumpTimer <= 0) this.jumpTimer = 15; // Small hop into drift
                        }
                        this.driftTimer++;
                        isScreeching = true;
                        
                        this.speed *= 0.995; // Slightly lose speed while drifting (more forgiving than before)
                        
                        // In a drift, the car naturally turns a bit in the drift direction
                        this.angle += this.turnSpeed * this.driftDir * 0.4 * turnRatio;
                        
                        // If steering into the drift, turn even sharper
                        if (this.driftDir === -1 && controls.left) this.angle -= this.turnSpeed * 0.6 * turnRatio;
                        if (this.driftDir === 1 && controls.right) this.angle += this.turnSpeed * 0.6 * turnRatio;
                        
                    } else {
                        if (this.isDrifting) {
                            // Release Drift = Mini Turbo!
                            if (this.driftTimer > 120) { this.miniTurboTimer = 90; cameraShake = Math.max(cameraShake, 6); audio.playSynth('synthBass', 60, 0, 0.5, 0.4); } // Pink
                            else if (this.driftTimer > 60) { this.miniTurboTimer = 50; cameraShake = Math.max(cameraShake, 4); audio.playSynth('synthBass', 55, 0, 0.3, 0.3); } // Orange
                            else if (this.driftTimer > 25) { this.miniTurboTimer = 25; cameraShake = Math.max(cameraShake, 2); audio.playSynth('synthBass', 50, 0, 0.2, 0.2); } // Blue
                        }
                        this.isDrifting = false;
                        this.driftTimer = 0;
                    }
                } else {
                    this.isDrifting = false;
                    this.driftTimer = 0;
                }

                audio.updateEngine(this.speed, true);
                audio.setScreech((isScreeching || this.isOffRoad) && Math.abs(this.speed) > 3);
            }

            
            useItem() {
                // Play SFX for player always, or for AI within ~800px of player
                let playSound = this.isPlayer;
                if (!playSound && player) {
                    let dx = this.x - player.x, dy = this.y - player.y;
                    playSound = (dx*dx + dy*dy) < 640000;
                }
                if (this.item === 'Missile') { projectiles.push(new Projectile(this.x, this.y, this.angle, 'Missile', this)); if(playSound) audio.playMissileLaunch(); }
                else if (this.item === 'Laser') { projectiles.push(new Projectile(this.x, this.y, this.angle, 'Laser', this)); if(playSound) audio.playLaserShot(); }
                else if (this.item === 'Mine') { traps.push(new Trap(this.x, this.y, 'Mine', this)); if(playSound) audio.playMineDrop(); }
                else if (this.item === 'Shield') { this.shieldTimer = 300; if(this.isPlayer) audio.playShieldUp(); }
                this.item = null;
            }
            handleAI() {
                if (!activeWaypoints || activeWaypoints.length < 2) return;

                let waypointCount = activeWaypoints.length;
                if (waypointCount > 8) {
                    let targetGap = (this.aiTargetWaypoint - (this.currentSegment || 0) + waypointCount) % waypointCount;
                    if (targetGap === 0 || targetGap > 6) {
                        this.aiTargetWaypoint = (this.currentSegment + 1) % waypointCount;
                    }
                }

                let targetWP = activeWaypoints[this.aiTargetWaypoint];
                let nextWP = activeWaypoints[(this.aiTargetWaypoint + 1) % waypointCount];
                let next2WP = activeWaypoints[(this.aiTargetWaypoint + 2) % waypointCount];
                let next3WP = activeWaypoints[(this.aiTargetWaypoint + 3) % waypointCount];
                if (!targetWP || !nextWP || !next2WP || !next3WP) return;

                let precision = this.aiPrecision || 0.86;
                let cornerGrip = this.aiCornerGrip || 1;
                let recoverySkill = this.aiRecoverySkill || 1;
                let lookaheadScale = this.aiLookaheadScale || 1;
                let paceComp = this.aiPaceComp || 1.06;
                let lineVariance = this.aiLineVariance || (config.trackWidth * 0.1);

                let rubberMult = 1.0;
                if (player && !this.isRemote) {
                    let dDist = this.distanceDriven - player.distanceDriven;
                    if (dDist < -3200) rubberMult = 1.28;
                    else if (dDist < -1800) rubberMult = 1.18;
                    else if (dDist < -800) rubberMult = 1.08;
                }

                if (this.item && this.itemRouletteTimer <= 0 && Math.random() < 0.016) this.useItem();
                if (this.jumpTimer > 0) {
                    this.jumpTimer--;
                    this.onTrack = true;
                }
                if (this.spinTimer > 0) {
                    this.spinTimer--;
                    this.angle += 0.3;
                    this.targetAngle = this.angle;
                }
                if (this.miniTurboTimer > 0) this.miniTurboTimer--;

                let currentSegAngle = Math.atan2(nextWP.y - targetWP.y, nextWP.x - targetWP.x);
                let nextSegAngle = Math.atan2(next2WP.y - nextWP.y, next2WP.x - nextWP.x);
                let farSegAngle = Math.atan2(next3WP.y - next2WP.y, next3WP.x - next2WP.x);
                let upcomingTurn = Math.max(
                    Math.abs(normalizeAngle(nextSegAngle - currentSegAngle)),
                    Math.abs(normalizeAngle(farSegAngle - nextSegAngle)) * 0.72
                );
                let turnSign = Math.sign(normalizeAngle(nextSegAngle - currentSegAngle));

                if (gameState === 'PLAYING') {
                    let angleDiffToTrack = normalizeAngle(currentSegAngle - this.angle);
                    this.aiUpcomingTurn = upcomingTurn;
                    this.aiAlignmentError = angleDiffToTrack;
                    if (Math.abs(angleDiffToTrack) > Math.PI * 0.65) {
                        this.wrongWayFrames = (this.wrongWayFrames || 0) + 1;
                        if (this.wrongWayFrames > 10) {
                            let correctionRate = Math.min(1, 0.22 + this.wrongWayFrames * 0.02 + recoverySkill * 0.08);
                            this.angle += normalizeAngle(currentSegAngle - this.angle) * correctionRate;
                            this.speed = Math.max(this.speed, this.maxSpeed * 0.28);
                        }
                    } else {
                        this.wrongWayFrames = 0;
                    }
                }

                if (this.reverseTimer > 0) {
                    let wallLocked = (this.wallContactFrames || 0) > 8 && (this.wallNormalX || this.wallNormalY);
                    let reverseAngle = Math.atan2(targetWP.y - this.y, targetWP.x - this.x);
                    if (wallLocked) {
                        let trackAngle = this.wallTrackAngle || currentSegAngle;
                        let outwardAngle = Math.atan2(this.wallNormalY, this.wallNormalX);
                        reverseAngle = Math.atan2(
                            Math.sin(trackAngle) * 0.58 + Math.sin(outwardAngle) * 0.42,
                            Math.cos(trackAngle) * 0.58 + Math.cos(outwardAngle) * 0.42
                        );
                    }
                    let reverseAccel = this.baseAcceleration * ((wallLocked ? 3.4 : 2.4) + recoverySkill * (wallLocked ? 0.9 : 0.6));
                    this.speed -= reverseAccel;
                    if (wallLocked && this.speed > -this.reverseSpeed * 0.72) {
                        this.speed = -this.reverseSpeed * 0.72;
                    }
                    if (this.speed < -this.reverseSpeed * (wallLocked ? 1.55 : 1.15)) {
                        this.speed = -this.reverseSpeed * (wallLocked ? 1.55 : 1.15);
                    }
                    let revDiff = normalizeAngle(reverseAngle - this.angle);
                    let reverseTurn = Math.min(Math.abs(revDiff), this.turnSpeed * (wallLocked ? (2.5 + recoverySkill * 0.7) : (1.4 + recoverySkill * 0.4)));
                    this.angle += revDiff > 0 ? reverseTurn : -reverseTurn;
                    return;
                }

                if (this.stuckFrames > 30 && this.stuckFrames < 120) {
                    if (this.isOffRoad) {
                        if (this.stuckFrames > 70) {
                            this.stuckFrames = 121;
                        } else {
                            this.reverseTimer = (this.wallContactFrames || 0) > 10 ? 34 : 26;
                            return;
                        }
                    } else {
                        this.reverseTimer = (this.wallContactFrames || 0) > 10 ? 52 : 38;
                        return;
                    }
                }

                let speedRatio = Math.max(0, Math.min(1.25, Math.abs(this.speed) / Math.max(this.maxSpeed, 1)));
                let futureBlend = Math.min(0.6, 0.26 + speedRatio * 0.24 * lookaheadScale);
                let deepBlend = Math.min(0.35, 0.12 + speedRatio * 0.18 * lookaheadScale);
                let farBlend = Math.min(0.2, 0.04 + speedRatio * 0.1 * lookaheadScale);
                let blendTotal = 1 + futureBlend + deepBlend + farBlend;
                let tx = (targetWP.x + nextWP.x * futureBlend + next2WP.x * deepBlend + next3WP.x * farBlend) / blendTotal;
                let ty = (targetWP.y + nextWP.y * futureBlend + next2WP.y * deepBlend + next3WP.y * farBlend) / blendTotal;

                let segDx = nextWP.x - targetWP.x;
                let segDy = nextWP.y - targetWP.y;
                let segLen = Math.sqrt(segDx * segDx + segDy * segDy) || 1;
                let segNx = -segDy / segLen;
                let segNy = segDx / segLen;
                let apexOffset = turnSign * Math.min(config.trackWidth * 0.22, (upcomingTurn / Math.PI) * config.trackWidth * 0.34) * precision;
                let currentError = this.isOffRoad ? 0 : this.aiError;
                tx += segNx * (apexOffset + currentError);
                ty += segNy * (apexOffset + currentError);

                let centerIdx = this.currentSegment || 0;
                let centerA = activeWaypoints[centerIdx];
                let centerB = activeWaypoints[(centerIdx + 1) % waypointCount];
                let trackCenterX = this.x;
                let trackCenterY = this.y;
                let centerTrackDx = segDx;
                let centerTrackDy = segDy;
                let centerTrackLen = segLen;
                let centerNormalX = segNx;
                let centerNormalY = segNy;
                let centerLateral = 0;
                let edgeRatio = 0;
                if (centerA && centerB) {
                    centerTrackDx = centerB.x - centerA.x;
                    centerTrackDy = centerB.y - centerA.y;
                    let centerLenSq = centerTrackDx * centerTrackDx + centerTrackDy * centerTrackDy;
                    let projT = Math.max(0, Math.min(1, ((this.x - centerA.x) * centerTrackDx + (this.y - centerA.y) * centerTrackDy) / (centerLenSq || 1)));
                    trackCenterX = centerA.x + centerTrackDx * projT;
                    trackCenterY = centerA.y + centerTrackDy * projT;
                    centerTrackLen = Math.sqrt(centerLenSq) || 1;
                    centerNormalX = -centerTrackDy / centerTrackLen;
                    centerNormalY = centerTrackDx / centerTrackLen;
                    centerLateral = (this.x - trackCenterX) * centerNormalX + (this.y - trackCenterY) * centerNormalY;
                    edgeRatio = Math.abs(centerLateral) / Math.max(config.trackWidth * 0.5, 1);
                    if (this.isOffRoad || edgeRatio > 0.62) {
                        let correctionStrength = this.isOffRoad ? (1.35 + (recoverySkill - 1) * 0.85) : (0.58 + edgeRatio * 0.82);
                        tx += centerNormalX * (-centerLateral * correctionStrength);
                        ty += centerNormalY * (-centerLateral * correctionStrength);
                    }
                }

                let chaseBoost = 1;
                let wallLocked = (this.wallContactFrames || 0) > 10 || edgeRatio > 0.88 || (this.isOffRoad && edgeRatio > 0.7);
                let nearestLeadCar = null;
                let nearestLeadDistance = Infinity;
                cars.forEach(other => {
                    if (other === this || other.finished) return;
                    let relX = other.x - this.x;
                    let relY = other.y - this.y;
                    let forwardDist = relX * Math.cos(currentSegAngle) + relY * Math.sin(currentSegAngle);
                    if (forwardDist <= 12 || forwardDist > config.trackWidth * 3.1) return;
                    let lateralDist = relX * segNx + relY * segNy;
                    if (Math.abs(lateralDist) > config.trackWidth * 0.56) return;
                    let distSq = relX * relX + relY * relY;
                    if (distSq < nearestLeadDistance) {
                        nearestLeadDistance = distSq;
                        nearestLeadCar = { car: other, forwardDist, lateralDist };
                    }
                });
                if (nearestLeadCar) {
                    let proximity = 1 - Math.min(1, nearestLeadCar.forwardDist / (config.trackWidth * 3.1));
                    let passSide = Math.abs(nearestLeadCar.lateralDist) > config.trackWidth * 0.16 ? (nearestLeadCar.lateralDist > 0 ? -1 : 1) : (this.aiPreferredSide || 1);
                    let passOffset = config.trackWidth * (0.16 + proximity * 0.22) * passSide * (this.aiAttackBias || 1);
                    tx += segNx * passOffset;
                    ty += segNy * passOffset;
                    if (Math.abs(nearestLeadCar.car.speed) < Math.abs(this.speed) * 1.03 || nearestLeadCar.forwardDist < config.trackWidth * 1.15) {
                        chaseBoost = 1 + proximity * 0.12 * (this.aiAttackBias || 1);
                    }
                }

                if (wallLocked && centerTrackLen > 0.5) {
                    let trackDirX = centerTrackDx / centerTrackLen;
                    let trackDirY = centerTrackDy / centerTrackLen;
                    let recoveryLookahead = Math.max(config.trackWidth * 0.9, Math.abs(this.speed) * 9 + 90);
                    tx = trackCenterX + trackDirX * recoveryLookahead - centerNormalX * centerLateral * 1.55;
                    ty = trackCenterY + trackDirY * recoveryLookahead - centerNormalY * centerLateral * 1.55;
                    chaseBoost = Math.max(chaseBoost, 1.06 + Math.min(0.12, edgeRatio * 0.1));
                    if (this.speed >= 0 && Math.abs(this.speed) < this.maxSpeed * 0.24) {
                        this.speed = this.maxSpeed * 0.24;
                    }
                }

                if (!this.isOffRoad && (this.wallContactFrames || 0) > 16 && edgeRatio > 0.82) {
                    this.reverseTimer = Math.max(this.reverseTimer, 26);
                }

                let targetAngle = Math.atan2(ty - this.y, tx - this.x);
                let angleDiff = normalizeAngle(targetAngle - this.angle);
                this.aiAlignmentError = angleDiff;

                let boostMult = this.nitroActive ? 1.82 : (this.isDrafting ? 1.26 : (this.miniTurboTimer > 0 ? 1.24 : 1));
                let currentAccel = this.baseAcceleration * boostMult * paceComp * rubberMult * (1.02 + chaseBoost * 0.06);
                let currentMaxSpeed = this.maxSpeed * boostMult * Math.max(paceComp * chaseBoost, rubberMult);
                let cornerSeverity = Math.max(Math.abs(angleDiff), upcomingTurn * 0.92);

                let desiredSpeedFrac = 1.12;
                if (cornerSeverity > Math.PI * 0.62) desiredSpeedFrac = 0.62 + cornerGrip * 0.1;
                else if (cornerSeverity > Math.PI * 0.42) desiredSpeedFrac = 0.78 + cornerGrip * 0.11;
                else if (cornerSeverity > Math.PI * 0.26) desiredSpeedFrac = 0.92 + cornerGrip * 0.1;
                else if (cornerSeverity > Math.PI * 0.14) desiredSpeedFrac = 1.02 + cornerGrip * 0.06;
                if (desiredSpeedFrac > 1.16) desiredSpeedFrac = 1.16;

                let desiredSpeed = currentMaxSpeed * desiredSpeedFrac;
                if (this.isOffRoad) {
                    desiredSpeed = Math.min(desiredSpeed, this.maxSpeed * (0.58 + (recoverySkill - 1) * 0.18));
                }
                desiredSpeed = Math.min(currentMaxSpeed * 1.16, desiredSpeed * chaseBoost);

                if (cornerSeverity > Math.PI * 0.2 && this.onTrack && this.speed > this.maxSpeed * 0.55) {
                    this.aiCornerCharge = Math.min((this.aiCornerCharge || 0) + 1, 55);
                } else if ((this.aiCornerCharge || 0) > 12 && this.onTrack && Math.abs(angleDiff) < 0.1) {
                    this.miniTurboTimer = Math.max(this.miniTurboTimer, 14 + Math.floor(this.aiCornerCharge * 0.4));
                    this.aiCornerCharge = 0;
                } else {
                    this.aiCornerCharge = Math.max(0, (this.aiCornerCharge || 0) - 1);
                }

                if (this.speed < desiredSpeed) {
                    let accelBoost = this.isOffRoad ? (1.24 + (recoverySkill - 1) * 0.65) : (1.02 + chaseBoost * 0.08);
                    this.speed += currentAccel * accelBoost;
                } else if (this.speed > desiredSpeed * 1.02) {
                    let brakeStrength = this.isOffRoad ? 0.3 : (0.24 + (cornerSeverity / Math.PI) * 0.96);
                    this.speed -= this.braking * brakeStrength;
                } else {
                    this.speed *= 0.999;
                }

                if (this.speed > currentMaxSpeed) this.speed = currentMaxSpeed;
                if (this.isOffRoad && this.speed < this.maxSpeed * 0.42) {
                    this.speed += this.baseAcceleration * 1.15 * recoverySkill;
                }

                if (Math.abs(this.speed) > 0.1) {
                    let turnMult = this.isOffRoad ? (3.2 + (recoverySkill - 1) * 0.9) : (1.38 + Math.min(2.1, cornerSeverity / (Math.PI * 0.28)) * cornerGrip);
                    let turnAmt = Math.min(Math.abs(angleDiff), this.turnSpeed * turnMult);
                    this.angle += angleDiff > 0 ? turnAmt : -turnAmt;
                }

                let wpDistSq = dist2(this, targetWP);
                let closeRadius = config.trackWidth * (1.15 + speedRatio * 0.45);
                let closeEnough = wpDistSq < closeRadius * closeRadius;
                let passedBy = false;
                if (!closeEnough) {
                    let trackDx = nextWP.x - targetWP.x;
                    let trackDy = nextWP.y - targetWP.y;
                    let toWpDx = targetWP.x - this.x;
                    let toWpDy = targetWP.y - this.y;
                    passedBy = (toWpDx * trackDx + toWpDy * trackDy) < 0;
                }
                if (closeEnough || passedBy) {
                    this.aiTargetWaypoint = (this.aiTargetWaypoint + 1) % waypointCount;
                    this.aiError = (Math.random() - 0.5) * lineVariance * (turnSign === 0 ? 1 : 0.7);
                }
            }

            applyFrictionAndMovement() {
                let minDistSquared = Infinity;
                let closestPt = null;
                let closestA = null;
                let closestB = null;
                let bestSegmentIndex = this.currentSegment || 0;

                for (let i = 0; i < activeWaypoints.length; i++) {
                    let N = activeWaypoints.length;
                    let diff = Math.abs(i - (this.currentSegment || 0));
                    if (diff > N / 2) diff = N - diff;
                    if (diff > 3 && N > 8) continue; // Skip far segments on complex tracks

                    let a = activeWaypoints[i];
                    let b = activeWaypoints[(i + 1) % N];
                    
                    let abx = b.x - a.x;
                    let aby = b.y - a.y;
                    let apx = this.x - a.x;
                    let apy = this.y - a.y;
                    
                    let l2 = abx * abx + aby * aby;
                    let t = 0;
                    if (l2 > 0) {
                        t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / l2));
                    }
                    
                    let closestX = a.x + t * abx;
                    let closestY = a.y + t * aby;
                    
                    let dx = this.x - closestX;
                    let dy = this.y - closestY;
                    let distSq = dx * dx + dy * dy;
                    
                    if (distSq < minDistSquared) {
                        minDistSquared = distSq;
                        closestPt = { x: closestX, y: closestY };
                        closestA = a;
                        closestB = b;
                        bestSegmentIndex = i;
                    }
                }
                this.currentSegment = bestSegmentIndex;
                this.wallContactFrames = Math.max(0, (this.wallContactFrames || 0) - 2);
                this.wallNormalX = 0;
                this.wallNormalY = 0;
                this.wallTrackAngle = 0;

                let distToCenter = Math.sqrt(minDistSquared);
                let roadHalfWidth = config.trackWidth / 2;

                this.isOffRoad = distToCenter > config.trackWidth * 0.6;
                this.onTrack = !this.isOffRoad;

                // Glide Collision for Track Barrier (Inner & Outer edges)
                let boundaryDist = config.trackWidth / 2 - this.width / 2;
                let outerWallDist = roadHalfWidth + 60;

                // Inner Edge Collision
                if (distToCenter > boundaryDist && distToCenter < outerWallDist && closestPt) {
                    let nx = (this.x - closestPt.x) / (distToCenter || 1);
                    let ny = (this.y - closestPt.y) / (distToCenter || 1);
                    let trackAngle = Math.atan2(closestB.y - closestA.y, closestB.x - closestA.x);

                    this.wallContactFrames = Math.min(90, (this.wallContactFrames || 0) + (this.isPlayer ? 1 : 2));
                    this.wallNormalX = nx;
                    this.wallNormalY = ny;
                    this.wallTrackAngle = trackAngle;

                    let inx = -nx; let iny = -ny;
                    let vx = Math.cos(this.angle) * this.speed;
                    let vy = Math.sin(this.angle) * this.speed;
                    let dot = vx * inx + vy * iny;

                    // Active inward push when drifting past boundary (regardless of velocity direction)
                    let pushStrength = (distToCenter - boundaryDist) / (outerWallDist - boundaryDist);
                    if (!this.isPlayer) pushStrength = Math.max(pushStrength, 0.25 + Math.min(0.55, Math.max(0, (this.wallContactFrames || 0) - 5) * 0.02));
                    let inwardPush = this.isPlayer ? 2.0 : 4.5;
                    this.x -= nx * pushStrength * inwardPush;
                    this.y -= ny * pushStrength * inwardPush;

                    if (dot < 0) {
                        let v_perp_x = dot * inx; let v_perp_y = dot * iny;
                        let v_par_x = vx - v_perp_x; let v_par_y = vy - v_perp_y;
                        let wasReversing = this.speed < 0;

                        let newSpeed = Math.sqrt(v_par_x*v_par_x + v_par_y*v_par_y) * 0.96;
                        let speedLoss = Math.abs(this.speed) - newSpeed;
                        if (this.isPlayer && speedLoss > 1.5) cameraShake = Math.min(15, speedLoss * 3);
                        this.speed = newSpeed;

                        let newTravelAngle = Math.atan2(v_par_y, v_par_x);
                        if (wasReversing) { this.speed = -this.speed; this.angle = newTravelAngle + Math.PI; }
                        else { this.angle = newTravelAngle; }

                        // NEVER GO BACKWARDS FIX
                        let angleDiff = Math.abs(normalizeAngle(this.angle - trackAngle));
                        if (angleDiff > Math.PI / 2) {
                            this.angle = trackAngle;
                            this.speed = Math.max(2.0, Math.abs(this.speed));
                        }
                    }

                    if (!this.isPlayer) {
                        let inwardAngle = Math.atan2(iny, inx);
                        let wcf = this.wallContactFrames || 0;
                        let inwardWeight = 0.38 + Math.min(0.4, Math.max(0, wcf - 4) * 0.014);
                        let trackWeight = 1 - inwardWeight;
                        let escapeAngle = Math.atan2(Math.sin(trackAngle) * trackWeight + Math.sin(inwardAngle) * inwardWeight, Math.cos(trackAngle) * trackWeight + Math.cos(inwardAngle) * inwardWeight);
                        let escapeBlend = Math.min(0.75, 0.24 + pushStrength * 0.22 + Math.max(0, wcf - 4) * 0.016);
                        this.angle += normalizeAngle(escapeAngle - this.angle) * escapeBlend;
                        if (this.speed >= 0 && this.speed < this.maxSpeed * 0.22) {
                            this.speed = this.maxSpeed * 0.22;
                        }
                        if (wcf > 12) {
                            this.reverseTimer = Math.max(this.reverseTimer, 24);
                        }
                    }
                }

                // Outer Hard Wall Collision
                if (distToCenter > outerWallDist && closestPt) {
                    let nx = (this.x - closestPt.x) / (distToCenter || 1);
                    let ny = (this.y - closestPt.y) / (distToCenter || 1);
                    let trackAngle = Math.atan2(closestB.y - closestA.y, closestB.x - closestA.x);

                    this.wallContactFrames = Math.min(90, (this.wallContactFrames || 0) + (this.isPlayer ? 2 : 3));
                    this.wallNormalX = nx;
                    this.wallNormalY = ny;
                    this.wallTrackAngle = trackAngle;

                    this.x = closestPt.x + nx * (outerWallDist - 1);
                    this.y = closestPt.y + ny * (outerWallDist - 1);

                    let inx = -nx; let iny = -ny;
                    let vx = Math.cos(this.angle) * this.speed;
                    let vy = Math.sin(this.angle) * this.speed;
                    let dot = vx * inx + vy * iny;
                    // Always apply glide at hard wall, not just when moving outward
                    let v_perp_x = dot * inx; let v_perp_y = dot * iny;
                    let v_par_x = vx - v_perp_x; let v_par_y = vy - v_perp_y;
                    let wasReversing = this.speed < 0;

                    let newSpeed = Math.sqrt(v_par_x*v_par_x + v_par_y*v_par_y) * 0.90;
                    let speedLoss = Math.abs(this.speed) - newSpeed;
                    if (this.isPlayer && speedLoss > 1.5) cameraShake = Math.min(25, speedLoss * 4);
                    this.speed = newSpeed;

                    let newTravelAngle = Math.atan2(v_par_y, v_par_x);
                    if (wasReversing) { this.speed = -this.speed; this.angle = newTravelAngle + Math.PI; }
                    else { this.angle = newTravelAngle; }

                    // NEVER GO BACKWARDS FIX
                    let angleDiff = Math.abs(normalizeAngle(this.angle - trackAngle));
                    if (angleDiff > Math.PI / 2) {
                        this.angle = trackAngle;
                        this.speed = Math.max(2.0, Math.abs(this.speed));
                    }

                    if (!this.isPlayer) {
                        let inwardAngle = Math.atan2(iny, inx);
                        let wcf = this.wallContactFrames || 0;
                        let inwardWeight = 0.52 + Math.min(0.32, Math.max(0, wcf - 3) * 0.016);
                        let trackWeight = 1 - inwardWeight;
                        let escapeAngle = Math.atan2(Math.sin(trackAngle) * trackWeight + Math.sin(inwardAngle) * inwardWeight, Math.cos(trackAngle) * trackWeight + Math.cos(inwardAngle) * inwardWeight);
                        let escapeBlend = Math.min(0.82, 0.38 + Math.max(0, wcf - 3) * 0.018);
                        this.angle += normalizeAngle(escapeAngle - this.angle) * escapeBlend;
                        if (this.speed >= 0 && this.speed < this.maxSpeed * 0.24) {
                            this.speed = this.maxSpeed * 0.24;
                        }
                        if (wcf > 8) {
                            this.reverseTimer = Math.max(this.reverseTimer, 28);
                        }
                    }
                }

                // AI wall-escape force: physically push car toward track center when stuck on wall
                if (!this.isPlayer && (this.wallContactFrames || 0) > 12 && closestPt) {
                    let toCenterX = closestPt.x - this.x;
                    let toCenterY = closestPt.y - this.y;
                    let toCenterLen = Math.sqrt(toCenterX * toCenterX + toCenterY * toCenterY);
                    if (toCenterLen > 1) {
                        let wcf = this.wallContactFrames;
                        let forceStrength = Math.min(10, ((wcf - 12) / 15) * 6);
                        this.x += (toCenterX / toCenterLen) * forceStrength;
                        this.y += (toCenterY / toCenterLen) * forceStrength;
                    }
                }

                // Weather Puddle Logic
                if (this.onTrack && config.weather !== 'Clear' && puddles.length > 0) {
                    let inPuddle = false;
                    for(let p of puddles) {
                        let dx = this.x - p.x;
                        let dy = this.y - p.y;
                        let rSq = Math.max(p.rx, p.ry) * Math.max(p.rx, p.ry);
                        if (dx*dx + dy*dy < rSq) {
                            inPuddle = true;
                            break;
                        }
                    }
                    if (inPuddle && this.slipTimer <= 0 && Math.abs(this.speed) > 5) {
                        this.slipTimer = 30; 
                        this.slipForce = (Math.random() > 0.5 ? 1 : -1) * (0.01 + Math.random() * 0.015);
                    }
                }
                
                if (this.slipTimer > 0) {
                    this.slipTimer--;
                    this.angle += this.slipForce;
                    if(Math.random() < 0.2) {
                        fx.addParticle(this.x, this.y, (Math.random()-0.5)*2, (Math.random()-0.5)*2, 3+Math.random()*2, 'rgba(150, 200, 255, 0.6)', 20, true);
                    }
                }

                const OFF_ROAD_MAX_SPEED_FRACTION = 0.4; 
                const OFF_ROAD_FRICTION = 0.97; 

                if (this.isOffRoad) {
                    const offRoadMaxSpeed = this.maxSpeed * OFF_ROAD_MAX_SPEED_FRACTION;
                    
                    if (this.speed > offRoadMaxSpeed) {
                        this.speed *= OFF_ROAD_FRICTION;
                        if (this.speed < offRoadMaxSpeed) this.speed = offRoadMaxSpeed;
                    } else if (this.speed < -offRoadMaxSpeed) {
                        this.speed *= OFF_ROAD_FRICTION;
                        if (this.speed > -offRoadMaxSpeed) this.speed = -offRoadMaxSpeed;
                    }

                    if (this.isPlayer) {
                        this.offTrackTimer += 1000 / config.fps;
                        if (this.offTrackTimer > 3000) {
                            let targetWP = activeWaypoints[this.aiTargetWaypoint];
                            let targetAngle = Math.atan2(targetWP.y - this.y, targetWP.x - this.x);
                            let angleDiff = normalizeAngle(targetAngle - this.angle);
                            let turnAmt = Math.min(Math.abs(angleDiff), this.turnSpeed * 0.6);
                            this.angle += angleDiff > 0 ? turnAmt : -turnAmt;
                            this.speed = Math.max(this.speed, 3);
                        }
                    }
                } else {
                    if (this.isPlayer) this.offTrackTimer = 0;
                    if (!this.isPlayer || (!keys['ArrowUp'] && !keys['ArrowDown'] && !keys['w'] && !keys['s'] && !keys['Shift'] && !keys['Nitro'])) {
                        this.speed *= config.trackFriction;
                    }
                }

                this.x += Math.cos(this.angle) * this.speed;
                this.y += Math.sin(this.angle) * this.speed;
                if (this.speed > 0) this.distanceDriven += this.speed;
            }

            checkCheckpoints() {
                if (this.isPlayer) {
                    let targetWP = activeWaypoints[this.aiTargetWaypoint];
                    if (Math.sqrt(dist2(this, targetWP)) < config.trackWidth * 1.5) {
                        this.aiTargetWaypoint = (this.aiTargetWaypoint + 1) % activeWaypoints.length;
                    }
                }

                let wp0 = activeWaypoints[0];
                let distToStart = Math.sqrt(dist2(this, wp0));
                let halfwayWp = activeWaypoints[Math.floor(activeWaypoints.length / 2)];
                
                if (Math.sqrt(dist2(this, halfwayWp)) < config.trackWidth * 1.5) {
                    this.halfwayMarkerHit = true;
                }

                if (distToStart < config.trackWidth && this.halfwayMarkerHit) {
                    this.lap++;
                    this.halfwayMarkerHit = false;
                    if(this.isPlayer && this.lap <= config.totalLaps) {
                        audio.lapJingle();
                        if (currentMapIndex === 7) triggerFlyover();
                        
                        // Lap Time Logic
                        let currentLapTime = Date.now() - playerLapStartTime;
                        playerLapStartTime = Date.now();
                        
                        if (currentLapTime < playerBestLap) {
                            playerBestLap = currentLapTime;
                            document.getElementById('best-lap-val').textContent = formatTime(playerBestLap);
                            document.getElementById('best-lap-banner-time').textContent = formatTime(playerBestLap);
                            
                            const banner = document.getElementById('best-lap-banner');
                            banner.classList.remove('hidden');
                            if (bestLapBannerTimeout) clearTimeout(bestLapBannerTimeout);
                            bestLapBannerTimeout = setTimeout(() => {
                                banner.classList.add('hidden');
                            }, 3000);
                        }
                    }
                    if (this.lap >= config.totalLaps && !this.finished) {
                        this.finished = true;
                        finishOrder.push(this);
                        if(this.isPlayer) {
                            if (currentMapIndex === 7) triggerFlyover();
                            if (!raceEndTime) {
                                raceEndTime = Date.now() + 60000; // 1 minute timer
                            }
                        }
                    }
                }
            }

            drawShadow(ctx) {
                if (this.tier && this.tier.name === 'RIVAL') {
                    ctx.save();
                    let scale = this.jumpTimer > 0 ? 1 + Math.sin((this.jumpTimer/40)*Math.PI)*0.5 : 1;
                    ctx.translate(this.x + 10 * scale, this.y + 10 * scale);
                    ctx.rotate(this.angle);
                    ctx.scale(scale, scale);
                    ctx.shadowColor = '#ff0033';
                    ctx.shadowBlur = 20;
                    ctx.fillStyle = 'rgba(255, 0, 51, 0.4)';
                    ctx.fillRect(-this.height/2 - 5, -this.width/2 - 5, this.height + 10, this.width + 10);
                    ctx.restore();
                }

                ctx.save();
                let theme = mapsData[currentMapIndex] ? mapsData[currentMapIndex].theme : null;
                let sunAngle = theme && theme.sunAngle !== undefined ? theme.sunAngle : -0.8;
                let shadowReach = 5 + Math.min(6, Math.abs(this.speed) * 0.08);
                let shadowX = Math.cos(sunAngle + Math.PI * 0.7) * shadowReach;
                let shadowY = Math.sin(sunAngle + Math.PI * 0.7) * shadowReach + 5;
                ctx.translate(this.x + shadowX, this.y + shadowY);
                ctx.rotate(this.angle);
                ctx.scale(0.96, 0.68);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.24)';
                ctx.shadowColor = 'rgba(0,0,0,0.5)';
                ctx.shadowBlur = 10;
                let carLen = this.height - 2;
                let carWid = this.width + 1;
                ctx.beginPath();
                ctx.roundRect(-carLen/2, -carWid/2, carLen, carWid, 6);
                ctx.fill();
                ctx.restore();
            }

            draw(ctx) {
                ctx.save();
                let scale = this.jumpTimer > 0 ? 1 + Math.sin((this.jumpTimer/40)*Math.PI)*0.5 : 1;
                ctx.translate(this.x, this.y);
                ctx.rotate(this.angle);
                ctx.scale(scale, scale);

                if (this.effect === 'Glow') {
                    ctx.shadowColor = this.color;
                    ctx.shadowBlur = 30;
                } else if (this.nitroActive) {
                    ctx.shadowColor = '#ffaa00';
                    ctx.shadowBlur = 25;
                } else {
                    ctx.shadowColor = 'transparent';
                    ctx.shadowBlur = 0;
                }

                if (this.shieldTimer > 0) {
                    ctx.beginPath(); ctx.arc(0, 0, 40, 0, Math.PI*2);
                    ctx.strokeStyle = `rgba(0, 243, 255, ${0.5 + Math.sin(Date.now()/100)*0.5})`;
                    ctx.lineWidth = 4; ctx.stroke();
                }
                let wheelLen = Math.max(12, this.height * 0.18);
                let wheelThick = Math.max(4, this.width * 0.18);
                let wheelRearX = -this.height / 2 + 8;
                let wheelFrontX = this.height / 2 - wheelLen - 8;
                let wheelTopY = -this.width / 2 - wheelThick + 2;
                let wheelBottomY = this.width / 2 - 2;
                let wheelPositions = [
                    [wheelRearX, wheelTopY],
                    [wheelFrontX, wheelTopY],
                    [wheelRearX, wheelBottomY],
                    [wheelFrontX, wheelBottomY]
                ];
                ctx.fillStyle = '#080808';
                wheelPositions.forEach(([wx, wy]) => {
                    ctx.beginPath();
                    ctx.roundRect(wx, wy, wheelLen, wheelThick, 3);
                    ctx.fill();
                });
                ctx.fillStyle = 'rgba(255,255,255,0.12)';
                wheelPositions.forEach(([wx, wy]) => {
                    ctx.fillRect(wx + 2, wy + 1, wheelLen - 4, Math.max(1, wheelThick - 2));
                });
                let bodyLight = adjustHexColor(this.color, 42);
                let bodyDark = adjustHexColor(this.color, -40);
                let bodyDeep = adjustHexColor(this.color, -68);
                let wetOverlay = config.weather === 'Clear' ? 'rgba(255,255,255,0.06)' : 'rgba(190,220,255,0.16)';
                let grad = ctx.createLinearGradient(this.height/2, -this.width/2, -this.height/2, this.width/2);
                grad.addColorStop(0, bodyLight);
                grad.addColorStop(0.42, this.color);
                grad.addColorStop(1, bodyDark);
                let surfaceSheen = ctx.createLinearGradient(-this.height/2, -this.width/2, this.height/2, this.width/2);
                surfaceSheen.addColorStop(0, 'rgba(255,255,255,0.44)');
                surfaceSheen.addColorStop(0.3, 'rgba(255,255,255,0.08)');
                surfaceSheen.addColorStop(0.72, 'rgba(255,255,255,0)');
                surfaceSheen.addColorStop(1, 'rgba(0,0,0,0.34)');

                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.roundRect(-this.height/2, -this.width/2, this.height, this.width, 7);
                ctx.fill();
                
                ctx.fillStyle = surfaceSheen;
                ctx.fill();

                ctx.fillStyle = wetOverlay;
                ctx.beginPath();
                ctx.roundRect(-this.height/2 + 4, -this.width/2 + 3, this.height - 8, this.width - 6, 5);
                ctx.fill();
                
                ctx.shadowBlur = 0;

                ctx.fillStyle = bodyDeep;
                ctx.beginPath();
                ctx.roundRect(-this.height/2 + 2, -this.width/2 + 2, this.height - 4, this.width - 4, 5);
                ctx.fill();

                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.roundRect(-this.height/2 + 4, -this.width/2 + 4, this.height - 8, this.width - 8, 5);
                ctx.fill();

                ctx.strokeStyle = hexToRgba(bodyDeep, 0.7);
                ctx.lineWidth = 1.4;
                ctx.beginPath();
                ctx.roundRect(-this.height/2 + 4, -this.width/2 + 4, this.height - 8, this.width - 8, 5);
                ctx.stroke();

                ctx.fillStyle = hexToRgba(bodyLight, 0.16);
                ctx.beginPath();
                ctx.roundRect(-this.height * 0.04, -this.width/2 + 7, this.height * 0.3, this.width - 14, 4);
                ctx.fill();

                ctx.strokeStyle = 'rgba(255,255,255,0.16)';
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.moveTo(-this.height * 0.12, -this.width * 0.18);
                ctx.lineTo(this.height * 0.22, -this.width * 0.18);
                ctx.moveTo(-this.height * 0.12, this.width * 0.18);
                ctx.lineTo(this.height * 0.22, this.width * 0.18);
                ctx.stroke();

                ctx.fillStyle = 'rgba(255,255,255,0.25)';
                ctx.beginPath();
                ctx.roundRect(-this.height/2 + 8, -this.width/2 + 6, this.height * 0.34, this.width - 12, 5);
                ctx.fill();

                ctx.fillStyle = 'rgba(0,0,0,0.18)';
                ctx.fillRect(-this.height/2 + 8, this.width/2 - 7, this.height - 16, 3);

                ctx.fillStyle = 'rgba(255,255,255,0.34)';
                ctx.fillRect(this.height/4, -this.width/4, 6, this.width/2);

                ctx.fillStyle = '#111';
                ctx.beginPath();
                ctx.roundRect(-this.height * 0.18, -this.width/2 + 5, this.height * 0.4, this.width - 10, 5);
                ctx.fill();

                let glassGrad = ctx.createLinearGradient(-this.height * 0.12, -this.width/2 + 4, this.height * 0.2, this.width/2 - 4);
                glassGrad.addColorStop(0, 'rgba(180,220,255,0.38)');
                glassGrad.addColorStop(1, 'rgba(20,25,35,0.88)');
                ctx.fillStyle = glassGrad;
                ctx.beginPath();
                ctx.roundRect(-this.height * 0.14, -this.width/2 + 6, this.height * 0.32, this.width - 12, 4);
                ctx.fill();
                
                ctx.fillStyle = 'rgba(255,255,255,0.24)';
                ctx.beginPath();
                ctx.moveTo(-this.height * 0.14, -this.width/2 + 6);
                ctx.lineTo(this.height * 0.02, -this.width/2 + 6);
                ctx.lineTo(-this.height * 0.08, -2);
                ctx.fill();

                if (this.nitroActive) {
                    ctx.fillStyle = 'rgba(255,176,54,0.2)';
                    ctx.beginPath();
                    ctx.moveTo(-this.height/2 + 6, -this.width/2 + 6);
                    ctx.lineTo(-this.height * 0.04, -this.width * 0.22);
                    ctx.lineTo(-this.height * 0.04, this.width * 0.22);
                    ctx.lineTo(-this.height/2 + 6, this.width/2 - 6);
                    ctx.closePath();
                    ctx.fill();
                }

                ctx.fillStyle = '#0a0a0a';
                ctx.fillRect(-this.height/2 + 8, -this.width/2 - 2, 12, 4);
                ctx.fillRect(-this.height/2 + 8, this.width/2 - 2, 12, 4);
                ctx.fillRect(this.height/2 - 20, -this.width/2 - 2, 12, 4);
                ctx.fillRect(this.height/2 - 20, this.width/2 - 2, 12, 4);

                ctx.fillStyle = '#fff';
                ctx.shadowColor = 'rgba(255,255,255,0.45)';
                ctx.shadowBlur = this.nitroActive ? 14 : 8;
                ctx.fillRect(this.height/2 - 5, -this.width/2 + 2, 5, 6);
                ctx.fillRect(this.height/2 - 5, this.width/2 - 8, 5, 6);
                ctx.shadowBlur = 0;

                if (this.effect === 'Flames' && Math.abs(this.speed) > 2) {
                    if (Math.random() < 0.5) {
                        ctx.fillStyle = Math.random() > 0.5 ? '#ffaa00' : '#ff0000';
                        ctx.beginPath();
                        ctx.arc(-this.height/2 - 5 - Math.random()*10, -this.width/4 + Math.random()*4, 2 + Math.random()*3, 0, Math.PI*2);
                        ctx.fill();
                        ctx.beginPath();
                        ctx.arc(-this.height/2 - 5 - Math.random()*10, this.width/4 + Math.random()*4, 2 + Math.random()*3, 0, Math.PI*2);
                        ctx.fill();
                    }
                }

                if (this.speed < -0.1 || (this.isPlayer && (keys['ArrowDown'] || keys['s']))) {
                    ctx.fillStyle = '#f00';
                    ctx.shadowColor = '#f00';
                    ctx.shadowBlur = 10;
                    ctx.fillRect(-this.height/2 - 1, -this.width/2 + 2, 4, 8);
                    ctx.fillRect(-this.height/2 - 1, this.width/2 - 10, 4, 8);
                } else {
                    ctx.fillStyle = '#600';
                    ctx.fillRect(-this.height/2 - 1, -this.width/2 + 2, 4, 8);
                    ctx.fillRect(-this.height/2 - 1, this.width/2 - 10, 4, 8);
                }

                ctx.restore();
            }
        }
        // --- UI & Controls ---
        const uiLayer = document.getElementById('ui-layer');
        const screens = document.getElementById('screens');
        const countdownEl = document.getElementById('countdown');
        const speedVal = document.getElementById('speed-val');
        const lapVal = document.getElementById('lap-val');
        const timeVal = document.getElementById('time-val');
        const posVal = document.getElementById('pos-val');
        const speedVal2 = document.getElementById('speed-val2');
        const timeVal2 = document.getElementById('time-val2');
        const posVal2 = document.getElementById('pos-val2');

        
        async function handleStartLoading() {
            if (handleStartLoading.isPending) return;
            handleStartLoading.isPending = true;
            const btn = document.getElementById('start-loading-btn');
            if (btn) {
                btn.disabled = true;
                btn.style.display = 'none';
            }
            const statusText = document.getElementById('loading-status-text');
            if (statusText) {
                statusText.style.display = 'block';
                statusText.innerText = 'Initializing Audio Engine...';
            }
            const bottomBar = document.getElementById('asset-bottom-bar');
            if (bottomBar) bottomBar.style.display = 'flex';

            const fill = document.getElementById('asset-bar-fill');
            const text = document.getElementById('asset-bottom-text');

            const finishStartup = () => {
                const loadingScreen = document.getElementById('asset-loading-screen');
                if (loadingScreen) {
                    loadingScreen.classList.add('hidden');
                    loadingScreen.style.display = 'none';
                }
                openMainMenu();
            };

            try {
                try {
                    await Tone.start();
                } catch (error) {
                    console.warn('Tone startup failed:', error);
                }

                try {
                    audio.init();
                } catch (error) {
                    console.warn('Audio init failed:', error);
                }

                await new Promise((resolve, reject) => {
                    audio.loadAssets((progressText, percent) => {
                        if (statusText) statusText.innerText = progressText;
                        if (text) text.innerText = progressText;
                        if (fill) fill.style.width = percent + '%';
                    }, resolve).catch(reject);
                });

                finishStartup();
            } catch (error) {
                console.error('Start loading failed:', error);
                if (statusText) statusText.innerText = 'Starting game...';
                if (text) text.innerText = 'Audio unavailable. Continuing...';
                if (fill) fill.style.width = '100%';
                setTimeout(finishStartup, 150);
            } finally {
                handleStartLoading.isPending = false;
            }
        }
        window.handleStartLoading = handleStartLoading;

        function bindStartLoadingButton() {
            const startBtn = document.getElementById('start-loading-btn');
            if (!startBtn || startBtn.dataset.boundStartLoading === 'true') return;
            startBtn.dataset.boundStartLoading = 'true';
            startBtn.style.pointerEvents = 'auto';
            startBtn.addEventListener('click', handleStartLoading);
            startBtn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleStartLoading();
                }
            });
        }

        function bindGlobalStartupCapture() {
            if (bindGlobalStartupCapture.isBound) return;
            bindGlobalStartupCapture.isBound = true;

            document.addEventListener('pointerdown', (e) => {
                const loadingScreen = document.getElementById('asset-loading-screen');
                if (!loadingScreen || handleStartLoading.isPending) return;

                const isVisible = !loadingScreen.classList.contains('hidden') && window.getComputedStyle(loadingScreen).display !== 'none';
                if (!isVisible) return;

                loadingScreen.style.pointerEvents = 'auto';
                const targetEl = e.target instanceof Element ? e.target : e.target && e.target.parentElement instanceof Element ? e.target.parentElement : null;
                if (!targetEl) return;

                if (targetEl.closest('#asset-loading-screen') || targetEl.closest('#screens')) {
                    handleStartLoading();
                }
            }, true);
        }
        bindStartLoadingButton();
        bindGlobalStartupCapture();
    
        function showScreen(screenId) {
            document.querySelectorAll('.screen-panel').forEach(p => p.classList.add('hidden'));
            document.getElementById(screenId).classList.remove('hidden');
            screens.classList.remove('hidden');
            screens.classList.remove('drone-overlay-mode');
            screens.classList.remove('editor-overlay-mode');
            uiLayer.classList.add('hidden');
        }

        function setLaps(n, btn) {
            config.totalLaps = n;
            document.querySelectorAll('#lap-options .btn-neon').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        }

        function setDifficulty(diff, btn) {
            config.difficulty = diff;
            document.querySelectorAll('#diff-options .btn-neon').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        }
        
        function setWeather(w, btn) {
            config.weather = w;
            document.querySelectorAll('#weather-options .btn-neon').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        }

        function changeOpponents(delta) {
            config.opponentCount += delta;
            if (config.opponentCount < 1) config.opponentCount = 1;
            if (config.opponentCount > 16) config.opponentCount = 16;
            document.getElementById('opponent-count-val').innerText = config.opponentCount;
            generateOpponents();
        }

        function openLocalMultiplayer() {
            gameMode = 'LOCAL_MULTIPLAYER';
            playerBestLap = Infinity;
            window.playerBestLap2 = Infinity;
            showScreen('car-select-menu');
            // We'll need a way to select two cars. For now, let's just make it auto-select for P2 or add a P2 selection step.
            // Simplest: P1 selects, then P2 selects.
            window.isP2Selecting = false;
        }
        function openQuickRace() {
            gameMode = 'QUICK_RACE';
            playerBestLap = Infinity;
            audio.init();
            audio.startMusic('menu');
            gameState = 'CAR_SELECT';
            showScreen('car-select-menu');
        }
        
        function openKnockoutCup() {
            gameMode = 'KNOCKOUT_CUP';
            playerBestLap = Infinity;
            audio.init();
            audio.startMusic('menu');
            gameState = 'CAR_SELECT';
            showScreen('car-select-menu');
        }
        
        function handleCarSelectNext() {
            if (gameMode === 'LOCAL_MULTIPLAYER' && !window.isP2Selecting) {
                window.isP2Selecting = true;
                document.querySelector('#car-select-menu h2').innerText = "PLAYER 2: SELECT YOUR CAR";
                document.querySelector('#car-select-menu h2').style.color = "var(--neon-pink)";
                selectCar(selectedCarIndex2);
                return;
            }
            if (gameMode === 'QUICK_RACE' || gameMode === 'LOCAL_MULTIPLAYER') {
                audio.startMusic('menu');
                gameState = 'RACE_SETUP';
                generateOpponents();
                showScreen('race-setup-menu');
            } else {
                initKnockoutCup();
            }
        }
        
        function openCarSelect() {
            window.isP2Selecting = false;
            document.querySelector('#car-select-menu h2').innerText = 'SELECT YOUR CAR';
            document.querySelector('#car-select-menu h2').style.color = 'var(--neon-blue)';
            audio.startMusic('menu');
            gameState = 'CAR_SELECT';
            showScreen('car-select-menu');
        }
        
        function openMapSelect() {
            audio.startMusic('menu');
            gameState = 'MAP_SELECT';
            showScreen('map-select-menu');
        }

        function openMapsMenu() {
            audio.init();
            audio.startMusic('menu');
            gameState = 'MENU';
            generateMapsBrowser();
            showScreen('maps-browser-menu');
        }

        function startTimeTrial(mapIndex) {
            gameMode = 'TIME_TRIAL';
            opponents = [];
            playerBestLap = Infinity;
            startLoadingScreen(mapIndex);
        }

        function startDroneView(mapIndex) {
            audio.init();
            audio.startMusic('menu');
            prepareDroneViewMap(mapIndex);
            fitDroneView();
            updateDroneOverlay();
            keys = {};
            resetDpadVisuals();
            gameState = 'DRONE_VIEW';
            screens.classList.remove('hidden');
            screens.classList.add('drone-overlay-mode');
            document.querySelectorAll('.screen-panel').forEach(p => p.classList.add('hidden'));
            document.getElementById('drone-view-overlay').classList.remove('hidden');
            uiLayer.classList.add('hidden');
        }

        function exitDroneView() {
            keys = {};
            isOpenWorldDroneView = false;
            openMapsMenu();
        }

        // Flag: are we in open-world drone view mode (renders differently)
        let isOpenWorldDroneView = false;

        function openOpenWorldDroneView() {
            audio.init();
            audio.startMusic('menu');
            isOpenWorldDroneView = true;

            // Build activeWaypoints from ALL region track circuits offset to world positions,
            // plus highway waypoints, so bounds calculation covers the whole world
            activeWaypoints = [];
            openWorldData.regions.forEach(region => {
                if (region.mapIndex >= 0 && mapsData[region.mapIndex]) {
                    mapsData[region.mapIndex].waypoints.forEach(wp => {
                        activeWaypoints.push({ x: wp.x + region.position.x, y: wp.y + region.position.y });
                    });
                }
            });
            openWorldData.highways.forEach(h => h.waypoints.forEach(wp => activeWaypoints.push({x: wp.x, y: wp.y})));

            rebuildTrackRenderCache();
            resetUiRenderCaches();

            // World bounds with generous padding
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            activeWaypoints.forEach(wp => {
                minX = Math.min(minX, wp.x); maxX = Math.max(maxX, wp.x);
                minY = Math.min(minY, wp.y); maxY = Math.max(maxY, wp.y);
            });
            const wPad = 20000;
            const worldCX = (minX + maxX) / 2;
            const worldCY = (minY + maxY) / 2;
            const worldW  = (maxX - minX) + wPad * 2;
            const worldH  = (maxY - minY) + wPad * 2;

            droneView.mapIndex = -1;
            droneView.centerX = worldCX;
            droneView.centerY = worldCY;
            let fitZoom = Math.min(canvas.width / worldW, canvas.height / worldH);
            droneView.fitZoom = clamp(fitZoom, droneView.minZoom, droneView.maxZoom);
            droneView.zoom = droneView.fitZoom;

            // Clear game entities
            cars = []; player = null; player2 = null;
            itemBoxes = []; projectiles = []; traps = []; coins = []; puddles = [];
            fx.particles = []; fx.skidMarks = []; fx.ripples = [];
            audio.updateEngine(0, false); audio.setScreech(false); audio.stopRain();

            // Drone overlay text
            const title = document.getElementById('drone-view-title');
            const subtitle = document.getElementById('drone-view-subtitle');
            const zoomEl = document.getElementById('drone-view-zoom');
            if (title) { title.textContent = 'WORLD OVERVIEW'; droneOverlayCache.title = 'WORLD OVERVIEW'; }
            if (subtitle) { subtitle.textContent = 'All ' + openWorldData.regions.length + ' regions — zoom & pan to explore'; droneOverlayCache.subtitle = subtitle.textContent; }
            if (zoomEl) { zoomEl.textContent = Math.round(droneView.zoom * 100) + '%'; droneOverlayCache.zoom = zoomEl.textContent; }

            keys = {};
            resetDpadVisuals();
            gameState = 'DRONE_VIEW';
            screens.classList.remove('hidden');
            screens.classList.add('drone-overlay-mode');
            document.querySelectorAll('.screen-panel').forEach(p => p.classList.add('hidden'));
            document.getElementById('drone-view-overlay').classList.remove('hidden');
            uiLayer.classList.add('hidden');
        }

        // ========== TRACK EDITOR ==========
        const editorThemePresets = [
            { label: 'Grass', theme: { bgOuter: '#4a7c59', bgInner: '#5a9a6e', track: '#2a2a2a', border: '#b0b0b0', barrierColor: '#ffffff', barrierDash: [], line: 'white' } },
            { label: 'Desert', theme: { bgOuter: '#d4b896', bgInner: '#c4a882', track: '#b8a882', border: '#c1440e', barrierColor: '#e67e22', barrierDash: [], line: 'white', surfaceType: 'sand', shoulder: '#c69d66', shoulderDust: '#e1bf87', roadEdge: '#8f6e45', asphaltHighlight: '#d8c19a', laneColor: '#efe6d6', sunAngle: -0.3, fogColor: 'rgba(255, 220, 170, 0.08)' } },
            { label: 'City', theme: { bgOuter: '#808080', track: '#111111', border: '#ffffff', barrierColor: '#cc0000', barrierDash: [40, 40], line: 'white', surfaceType: 'concrete', shoulder: '#666b72', shoulderDust: '#8b9198', roadEdge: '#272a2f', asphaltHighlight: '#515761', laneColor: '#d7dbe0', sunAngle: -0.55, fogColor: 'rgba(220,220,230,0.05)' } },
            { label: 'Mountain', theme: { bgOuter: '#7a6a5a', track: '#555555', border: '#8b6914', barrierColor: '#aaaaaa', barrierDash: [40, 20], line: 'white_dash' } },
            { label: 'Seaside', theme: { bgOuter: '#e8d5a3', track: '#9a9a8a', border: '#d4c4a0', barrierColor: '#ffffff', barrierDash: [], line: 'white' } },
            { label: 'Neon', theme: { bgOuter: '#050510', track: '#0a0a0f', border: '#6a0dad', borderStyle: 'neon', barrierColor: '#00f3ff', barrierDash: [50, 50], line: 'neon' } },
            { label: 'Airport', theme: { bgOuter: '#646b75', bgInner: '#7b8591', track: '#2a2b2e', border: '#FFD700', barrierColor: '#ffffff', barrierDash: [40, 40], line: 'white_dash', surfaceType: 'concrete', shoulder: '#707780', shoulderDust: '#8e97a3', roadEdge: '#1e2328', asphaltHighlight: '#5d6570', laneColor: '#f4e3a2', sunAngle: -0.42, fogColor: 'rgba(220,230,245,0.07)' } }
        ];

        let editorState = {
            active: false,
            tool: 'place',        // 'place', 'move', 'delete', 'feature'
            featureType: 'boost',  // 'boost', 'ramp', 'oil'
            themeIndex: 0,
            waypoints: [],
            features: [],
            selectedWP: -1,
            dragging: false,
            hoverWP: -1,
            hoverFeature: -1,
            mouseWorldX: 0,
            mouseWorldY: 0,
            mouseDown: false,
            savedBeforeTest: null  // stash editor state during test drive
        };

        function loadCustomTracks() {
            try {
                let stored = localStorage.getItem('webRacers_customTracks');
                if (stored) return JSON.parse(stored);
            } catch(e) {}
            return [];
        }

        function saveCustomTracksToStorage(tracks) {
            localStorage.setItem('webRacers_customTracks', JSON.stringify(tracks));
        }

        function injectCustomTracksIntoMapsData() {
            // Remove previously injected custom tracks
            mapsData.length = 10; // keep original 10
            trackDescriptions.length = 10;
            let customs = loadCustomTracks();
            customs.forEach(ct => {
                mapsData.push({
                    name: ct.name || 'Custom Track',
                    waypoints: ct.waypoints,
                    theme: ct.theme,
                    features: ct.features || [],
                    isCustom: true
                });
                trackDescriptions.push('Custom track created in the Track Editor.');
            });
        }

        function openTrackEditor() {
            audio.init();
            audio.startMusic('menu');
            editorState.active = true;
            editorState.tool = 'place';
            editorState.selectedWP = -1;
            editorState.dragging = false;
            editorState.hoverWP = -1;
            editorState.hoverFeature = -1;
            if (!editorState.savedBeforeTest) {
                editorState.waypoints = [];
                editorState.features = [];
                editorState.themeIndex = 0;
                document.getElementById('editor-name-input').value = '';
            } else {
                // returning from test drive
                editorState.savedBeforeTest = null;
            }

            // Set up canvas view like drone view
            droneView.centerX = 0;
            droneView.centerY = 0;
            droneView.zoom = 0.3;
            droneView.minZoom = 0.06;
            droneView.maxZoom = 1.8;

            // Put empty waypoints into active for rendering
            editorSyncTrackPreview();

            cars = [];
            player = null;
            player2 = null;
            itemBoxes = [];
            projectiles = [];
            traps = [];
            coins = [];
            puddles = [];
            fx.particles = [];
            fx.skidMarks = [];
            fx.ripples = [];
            audio.updateEngine(0, false);
            audio.setScreech(false);
            audio.stopRain();

            keys = {};
            resetDpadVisuals();
            gameState = 'TRACK_EDITOR';
            screens.classList.remove('hidden');
            screens.classList.add('editor-overlay-mode');
            document.querySelectorAll('.screen-panel').forEach(p => p.classList.add('hidden'));
            document.getElementById('track-editor-overlay').classList.remove('hidden');
            document.getElementById('editor-load-panel').style.display = 'none';
            uiLayer.classList.add('hidden');
            editorUpdateStatus();
            editorUpdateToolHighlight();
            editorUpdateThemeHighlight();
        }

        function editorSyncTrackPreview() {
            // Editor uses its own draw overlay, so we only need to keep waypoints in editorState.
            // No need to modify global activeWaypoints or currentMapIndex during editing.
        }

        function editorUpdateStatus() {
            let el = document.getElementById('editor-status');
            if (!el) return;
            let wp = editorState.waypoints.length;
            let ft = editorState.features.length;
            let valid = wp >= 4;
            el.innerHTML = `Waypoints: ${wp} &nbsp;|&nbsp; Features: ${ft}` +
                (wp > 0 && wp < 4 ? ` &nbsp;|&nbsp; <span style="color:#ff3333;">Need ${4-wp} more</span>` : '') +
                (valid ? ` &nbsp;|&nbsp; <span style="color:#39ff14;">Ready</span>` : '');
        }

        function editorUpdateToolHighlight() {
            ['tool-place', 'tool-move', 'tool-delete', 'tool-feature'].forEach(id => {
                document.getElementById(id).classList.remove('tool-active');
            });
            let map = { place: 'tool-place', move: 'tool-move', delete: 'tool-delete', feature: 'tool-feature' };
            if (map[editorState.tool]) document.getElementById(map[editorState.tool]).classList.add('tool-active');

            // Show/hide feature options
            document.getElementById('editor-feature-options').style.display = editorState.tool === 'feature' ? 'flex' : 'none';
        }

        function editorUpdateThemeHighlight() {
            let btns = document.querySelectorAll('.editor-themes .btn-neon');
            btns.forEach((b, i) => {
                if (i === editorState.themeIndex) b.classList.add('tool-active');
                else b.classList.remove('tool-active');
            });
        }

        function editorSetTool(tool) {
            editorState.tool = tool;
            editorState.selectedWP = -1;
            editorState.dragging = false;
            editorUpdateToolHighlight();
        }

        function editorSetFeatureType(type) {
            editorState.featureType = type;
            ['feat-boost', 'feat-ramp', 'feat-oil'].forEach(id => document.getElementById(id).classList.remove('tool-active'));
            let map = { boost: 'feat-boost', ramp: 'feat-ramp', oil: 'feat-oil' };
            if (map[type]) document.getElementById(map[type]).classList.add('tool-active');
        }

        function editorSetTheme(index) {
            editorState.themeIndex = index;
            editorUpdateThemeHighlight();
            editorSyncTrackPreview();
        }

        function editorGetCurrentTheme() {
            return editorThemePresets[editorState.themeIndex].theme;
        }

        function editorFindNearestWP(wx, wy, maxDist) {
            let best = -1, bestD = maxDist * maxDist;
            editorState.waypoints.forEach((wp, i) => {
                let dx = wp.x - wx, dy = wp.y - wy;
                let d = dx*dx + dy*dy;
                if (d < bestD) { bestD = d; best = i; }
            });
            return best;
        }

        function editorFindNearestFeature(wx, wy, maxDist) {
            let best = -1, bestD = maxDist * maxDist;
            editorState.features.forEach((f, i) => {
                let dx = f.x - wx, dy = f.y - wy;
                let d = dx*dx + dy*dy;
                if (d < bestD) { bestD = d; best = i; }
            });
            return best;
        }

        function editorGetFeatureAngle(fx, fy) {
            // Auto-align feature angle to nearest track segment direction
            if (editorState.waypoints.length < 2) return 0;
            let bestD = Infinity, bestAngle = 0;
            for (let i = 0; i < editorState.waypoints.length; i++) {
                let a = editorState.waypoints[i];
                let b = editorState.waypoints[(i + 1) % editorState.waypoints.length];
                let l2 = (b.x-a.x)*(b.x-a.x) + (b.y-a.y)*(b.y-a.y);
                if (l2 === 0) continue;
                let t = Math.max(0, Math.min(1, ((fx-a.x)*(b.x-a.x)+(fy-a.y)*(b.y-a.y)) / l2));
                let px = a.x + t*(b.x-a.x), py = a.y + t*(b.y-a.y);
                let d = (fx-px)*(fx-px) + (fy-py)*(fy-py);
                if (d < bestD) {
                    bestD = d;
                    bestAngle = Math.atan2(b.y-a.y, b.x-a.x);
                }
            }
            return bestAngle;
        }

        function editorCanvasToWorld(canvasX, canvasY) {
            let wx = droneView.centerX + (canvasX - canvas.width / 2) / droneView.zoom;
            let wy = droneView.centerY + (canvasY - canvas.height / 2) / droneView.zoom;
            return { x: wx, y: wy };
        }

        function editorHandleMouseDown(e) {
            if (gameState !== 'TRACK_EDITOR') return;
            // Ignore clicks on the overlay panel
            if (e.target.closest('#track-editor-overlay')) return;

            let rect = canvas.getBoundingClientRect();
            let cx = e.clientX - rect.left, cy = e.clientY - rect.top;
            let world = editorCanvasToWorld(cx, cy);
            let wx = world.x, wy = world.y;
            editorState.mouseDown = true;

            let hitRadius = Math.max(20, 30 / droneView.zoom);

            if (editorState.tool === 'place') {
                // Check minimum distance from last waypoint
                if (editorState.waypoints.length > 0) {
                    let last = editorState.waypoints[editorState.waypoints.length - 1];
                    let dx = wx - last.x, dy = wy - last.y;
                    if (dx*dx + dy*dy < 100*100) {
                        // Too close, skip
                        return;
                    }
                }
                editorState.waypoints.push({ x: wx, y: wy });
                editorSyncTrackPreview();
                editorUpdateStatus();
            } else if (editorState.tool === 'move') {
                let idx = editorFindNearestWP(wx, wy, hitRadius);
                if (idx >= 0) {
                    editorState.selectedWP = idx;
                    editorState.dragging = true;
                }
            } else if (editorState.tool === 'delete') {
                let wpIdx = editorFindNearestWP(wx, wy, hitRadius);
                if (wpIdx >= 0) {
                    editorState.waypoints.splice(wpIdx, 1);
                    editorSyncTrackPreview();
                    editorUpdateStatus();
                } else {
                    // Try deleting a feature
                    let fIdx = editorFindNearestFeature(wx, wy, hitRadius);
                    if (fIdx >= 0) {
                        editorState.features.splice(fIdx, 1);
                        editorUpdateStatus();
                    }
                }
            } else if (editorState.tool === 'feature') {
                // Check if clicking existing feature to remove it
                let fIdx = editorFindNearestFeature(wx, wy, hitRadius);
                if (fIdx >= 0) {
                    editorState.features.splice(fIdx, 1);
                } else if (editorState.features.length < 10) {
                    let angle = editorGetFeatureAngle(wx, wy);
                    editorState.features.push({ type: editorState.featureType, x: wx, y: wy, angle: angle });
                }
                editorUpdateStatus();
            }
        }

        function editorHandleMouseMove(e) {
            if (gameState !== 'TRACK_EDITOR') return;
            let rect = canvas.getBoundingClientRect();
            let cx = e.clientX - rect.left, cy = e.clientY - rect.top;
            let world = editorCanvasToWorld(cx, cy);
            editorState.mouseWorldX = world.x;
            editorState.mouseWorldY = world.y;

            if (editorState.dragging && editorState.selectedWP >= 0) {
                let wp = editorState.waypoints[editorState.selectedWP];
                if (wp) {
                    wp.x = world.x;
                    wp.y = world.y;
                    editorSyncTrackPreview();
                }
            }

            // Update hover
            let hitRadius = Math.max(20, 30 / droneView.zoom);
            editorState.hoverWP = editorFindNearestWP(world.x, world.y, hitRadius);
            editorState.hoverFeature = editorFindNearestFeature(world.x, world.y, hitRadius);
        }

        function editorHandleMouseUp(e) {
            if (gameState !== 'TRACK_EDITOR') return;
            editorState.mouseDown = false;
            editorState.dragging = false;
        }

        canvas.addEventListener('mousedown', editorHandleMouseDown);
        canvas.addEventListener('mousemove', editorHandleMouseMove);
        canvas.addEventListener('mouseup', editorHandleMouseUp);

        function editorValidateTrack() {
            if (editorState.waypoints.length < 4) return 'Need at least 4 waypoints.';
            let name = (document.getElementById('editor-name-input').value || '').trim();
            if (!name) return 'Enter a track name.';
            // Check total perimeter
            let perim = 0;
            for (let i = 0; i < editorState.waypoints.length; i++) {
                let a = editorState.waypoints[i];
                let b = editorState.waypoints[(i+1) % editorState.waypoints.length];
                perim += Math.sqrt((b.x-a.x)*(b.x-a.x) + (b.y-a.y)*(b.y-a.y));
            }
            if (perim < 1000) return 'Track is too small. Make it bigger!';
            return null; // valid
        }

        function editorSaveTrack() {
            let err = editorValidateTrack();
            if (err) { alert(err); return; }
            let name = document.getElementById('editor-name-input').value.trim();
            let trackData = {
                name: name,
                waypoints: editorState.waypoints.map(w => ({x: w.x, y: w.y})),
                theme: editorGetCurrentTheme(),
                features: editorState.features.map(f => ({type:f.type, x:f.x, y:f.y, angle:f.angle})),
                createdAt: Date.now()
            };
            let customs = loadCustomTracks();
            // Replace if same name exists
            let existIdx = customs.findIndex(c => c.name === name);
            if (existIdx >= 0) customs[existIdx] = trackData;
            else customs.push(trackData);
            saveCustomTracksToStorage(customs);
            injectCustomTracksIntoMapsData();
            alert('Track "' + name + '" saved!');
        }

        function editorShowLoad() {
            let panel = document.getElementById('editor-load-panel');
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            if (panel.style.display === 'block') editorPopulateSavedList();
        }

        function editorPopulateSavedList() {
            let list = document.getElementById('editor-saved-list');
            let customs = loadCustomTracks();
            if (customs.length === 0) {
                list.innerHTML = '<p style="color:#aaa; font-size:12px; text-align:center;">No saved tracks yet.</p>';
                return;
            }
            list.innerHTML = customs.map((ct, i) => `
                <div class="editor-saved-item">
                    <div>
                        <div class="editor-saved-item-name">${ct.name}</div>
                        <div class="editor-saved-item-info">${ct.waypoints.length} waypoints, ${(ct.features||[]).length} features</div>
                    </div>
                    <div style="display:flex; gap:4px;">
                        <button class="editor-saved-item-del" style="border-color:#00f3ff; color:#00f3ff;" data-onclick="editorLoadTrack(${i})">Load</button>
                        <button class="editor-saved-item-del" data-onclick="editorDeleteTrack(${i})">Del</button>
                    </div>
                </div>
            `).join('');
        }

        function editorLoadTrack(index) {
            let customs = loadCustomTracks();
            let ct = customs[index];
            if (!ct) return;
            editorState.waypoints = ct.waypoints.map(w => ({x: w.x, y: w.y}));
            editorState.features = (ct.features || []).map(f => ({type:f.type, x:f.x, y:f.y, angle:f.angle}));
            document.getElementById('editor-name-input').value = ct.name || '';
            // Try to match theme
            let themeStr = JSON.stringify(ct.theme);
            let matchIdx = editorThemePresets.findIndex(p => JSON.stringify(p.theme) === themeStr);
            editorState.themeIndex = matchIdx >= 0 ? matchIdx : 0;
            editorUpdateThemeHighlight();
            editorSyncTrackPreview();
            editorUpdateStatus();
            // Center view on track
            if (editorState.waypoints.length > 0) {
                let bounds = getWaypointBounds(editorState.waypoints);
                droneView.centerX = bounds.centerX;
                droneView.centerY = bounds.centerY;
                let fitZ = Math.min(canvas.width / (bounds.width + 800), canvas.height / (bounds.height + 800));
                droneView.zoom = clamp(fitZ, droneView.minZoom, droneView.maxZoom);
            }
            document.getElementById('editor-load-panel').style.display = 'none';
        }

        function editorDeleteTrack(index) {
            let customs = loadCustomTracks();
            if (!customs[index]) return;
            if (!confirm('Delete "' + customs[index].name + '"?')) return;
            customs.splice(index, 1);
            saveCustomTracksToStorage(customs);
            injectCustomTracksIntoMapsData();
            editorPopulateSavedList();
        }

        function editorExportTrack() {
            let err = editorValidateTrack();
            if (err) { alert(err); return; }
            let name = document.getElementById('editor-name-input').value.trim();
            let data = {
                name: name,
                waypoints: editorState.waypoints.map(w => ({x:w.x, y:w.y})),
                theme: editorGetCurrentTheme(),
                features: editorState.features.map(f => ({type:f.type, x:f.x, y:f.y, angle:f.angle}))
            };
            let json = JSON.stringify(data);
            if (navigator.clipboard) {
                navigator.clipboard.writeText(json).then(() => alert('Track JSON copied to clipboard!'));
            } else {
                prompt('Copy this track JSON:', json);
            }
        }

        function editorImportTrack() {
            let json = prompt('Paste track JSON:');
            if (!json) return;
            try {
                let data = JSON.parse(json);
                if (!data.waypoints || !Array.isArray(data.waypoints) || data.waypoints.length < 4) {
                    alert('Invalid track data.'); return;
                }
                editorState.waypoints = data.waypoints.map(w => ({x:w.x, y:w.y}));
                editorState.features = (data.features || []).map(f => ({type:f.type, x:f.x, y:f.y, angle:f.angle||0}));
                document.getElementById('editor-name-input').value = data.name || 'Imported Track';
                let themeStr = JSON.stringify(data.theme);
                let matchIdx = editorThemePresets.findIndex(p => JSON.stringify(p.theme) === themeStr);
                editorState.themeIndex = matchIdx >= 0 ? matchIdx : 0;
                editorUpdateThemeHighlight();
                editorSyncTrackPreview();
                editorUpdateStatus();
                if (editorState.waypoints.length > 0) {
                    let bounds = getWaypointBounds(editorState.waypoints);
                    droneView.centerX = bounds.centerX;
                    droneView.centerY = bounds.centerY;
                    let fitZ = Math.min(canvas.width / (bounds.width + 800), canvas.height / (bounds.height + 800));
                    droneView.zoom = clamp(fitZ, droneView.minZoom, droneView.maxZoom);
                }
            } catch(e) {
                alert('Invalid JSON: ' + e.message);
            }
        }

        function editorClear() {
            if (editorState.waypoints.length > 0 && !confirm('Clear all waypoints and features?')) return;
            editorState.waypoints = [];
            editorState.features = [];
            editorState.selectedWP = -1;
            editorSyncTrackPreview();
            editorUpdateStatus();
        }

        function editorTestDrive() {
            let err = editorValidateTrack();
            if (err) { alert(err); return; }
            // Save editor state for return
            editorState.savedBeforeTest = {
                waypoints: editorState.waypoints.map(w => ({x:w.x, y:w.y})),
                features: editorState.features.map(f => ({type:f.type, x:f.x, y:f.y, angle:f.angle})),
                themeIndex: editorState.themeIndex,
                name: document.getElementById('editor-name-input').value
            };
            // Create temp track entry
            let name = document.getElementById('editor-name-input').value.trim() || 'Test Track';
            let tempTrack = {
                name: name,
                waypoints: editorState.waypoints.map(w => ({x:w.x, y:w.y})),
                theme: editorGetCurrentTheme(),
                features: editorState.features.map(f => ({type:f.type, x:f.x, y:f.y, angle:f.angle})),
                isCustom: true
            };
            // Append temporarily
            let tempIdx = mapsData.length;
            mapsData.push(tempTrack);
            trackDescriptions.push('Test drive of your custom track!');

            gameMode = 'TIME_TRIAL';
            opponents = [];
            playerBestLap = Infinity;
            editorState.active = false;
            screens.classList.remove('editor-overlay-mode');
            startLoadingScreen(tempIdx);
        }

        function editorExit() {
            editorState.active = false;
            editorState.savedBeforeTest = null;
            keys = {};
            // Reset mapsData (remove any temp entries beyond customs)
            injectCustomTracksIntoMapsData();
            openMainMenu();
        }

        function editorEditCustomTrack(customIndex) {
            let customs = loadCustomTracks();
            let ct = customs[customIndex];
            if (!ct) return;
            // Open editor first (clears state), then restore the track data
            openTrackEditor();
            editorState.waypoints = ct.waypoints.map(w => ({x: w.x, y: w.y}));
            editorState.features = (ct.features || []).map(f => ({type:f.type, x:f.x, y:f.y, angle:f.angle}));
            document.getElementById('editor-name-input').value = ct.name || '';
            let themeStr = JSON.stringify(ct.theme);
            let matchIdx = editorThemePresets.findIndex(p => JSON.stringify(p.theme) === themeStr);
            editorState.themeIndex = matchIdx >= 0 ? matchIdx : 0;
            editorUpdateThemeHighlight();
            editorUpdateStatus();
            if (editorState.waypoints.length > 0) {
                let bounds = getWaypointBounds(editorState.waypoints);
                droneView.centerX = bounds.centerX;
                droneView.centerY = bounds.centerY;
                let fitZ = Math.min(canvas.width / (bounds.width + 800), canvas.height / (bounds.height + 800));
                droneView.zoom = clamp(fitZ, droneView.minZoom, droneView.maxZoom);
            }
        }

        function editorDrawOverlay() {
            if (gameState !== 'TRACK_EDITOR') return;
            let theme = editorGetCurrentTheme();
            let zoom = droneView.zoom;

            ctx.save();
            // Fill background
            ctx.fillStyle = theme.bgOuter || '#333';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Apply drone-style camera transform
            ctx.translate(canvas.width / 2, canvas.height / 2);
            ctx.scale(zoom, zoom);
            ctx.translate(-droneView.centerX, -droneView.centerY);

            // Draw grid
            ctx.strokeStyle = 'rgba(255,255,255,0.06)';
            ctx.lineWidth = 1 / zoom;
            let gridSize = 200;
            let viewHalfW = canvas.width / (2 * zoom);
            let viewHalfH = canvas.height / (2 * zoom);
            let startGX = Math.floor((droneView.centerX - viewHalfW) / gridSize) * gridSize;
            let startGY = Math.floor((droneView.centerY - viewHalfH) / gridSize) * gridSize;
            let endGX = droneView.centerX + viewHalfW;
            let endGY = droneView.centerY + viewHalfH;
            for (let gx = startGX; gx <= endGX; gx += gridSize) {
                ctx.beginPath(); ctx.moveTo(gx, startGY); ctx.lineTo(gx, endGY); ctx.stroke();
            }
            for (let gy = startGY; gy <= endGY; gy += gridSize) {
                ctx.beginPath(); ctx.moveTo(startGX, gy); ctx.lineTo(endGX, gy); ctx.stroke();
            }

            // Draw origin marker
            ctx.strokeStyle = 'rgba(255,255,255,0.2)';
            ctx.lineWidth = 2 / zoom;
            ctx.beginPath(); ctx.moveTo(-50, 0); ctx.lineTo(50, 0); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, -50); ctx.lineTo(0, 50); ctx.stroke();

            let wps = editorState.waypoints;

            // Draw track preview if we have enough waypoints
            if (wps.length >= 3) {
                // Draw filled track area
                ctx.beginPath();
                ctx.moveTo(wps[0].x, wps[0].y);
                for (let i = 1; i < wps.length; i++) ctx.lineTo(wps[i].x, wps[i].y);
                ctx.closePath();
                ctx.lineWidth = config.trackWidth;
                ctx.lineJoin = 'round';
                ctx.lineCap = 'round';
                ctx.strokeStyle = theme.track || '#2a2a2a';
                ctx.stroke();

                // Barrier
                ctx.lineWidth = config.trackWidth + 20;
                ctx.strokeStyle = theme.border || '#b0b0b0';
                ctx.globalCompositeOperation = 'destination-over';
                ctx.stroke();
                ctx.globalCompositeOperation = 'source-over';

                // Center line (dashed)
                ctx.beginPath();
                ctx.moveTo(wps[0].x, wps[0].y);
                for (let i = 1; i < wps.length; i++) ctx.lineTo(wps[i].x, wps[i].y);
                ctx.closePath();
                ctx.setLineDash([20, 20]);
                ctx.lineWidth = 2 / zoom;
                ctx.strokeStyle = 'rgba(255,255,255,0.15)';
                ctx.stroke();
                ctx.setLineDash([]);

                // Start/finish line
                let s = wps[0];
                let sNext = wps[1];
                let sAngle = Math.atan2(sNext.y - s.y, sNext.x - s.x);
                ctx.save();
                ctx.translate(s.x, s.y);
                ctx.rotate(sAngle);
                ctx.fillStyle = '#ffffff';
                let sqSize = 18;
                let hw = Math.floor(config.trackWidth / sqSize / 2);
                for (let w = -hw; w < hw; w++) {
                    for (let h = -1; h <= 1; h++) {
                        if ((w + h) % 2 === 0) {
                            ctx.fillRect(h * sqSize, w * sqSize, sqSize, sqSize);
                        }
                    }
                }
                ctx.restore();
            }

            // Draw connection lines between waypoints
            if (wps.length >= 2) {
                ctx.beginPath();
                ctx.moveTo(wps[0].x, wps[0].y);
                for (let i = 1; i < wps.length; i++) ctx.lineTo(wps[i].x, wps[i].y);
                if (wps.length >= 3) ctx.closePath(); // close loop
                ctx.lineWidth = 2 / zoom;
                ctx.strokeStyle = '#fbc531';
                ctx.setLineDash([8 / zoom, 8 / zoom]);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Ghost segment from last WP to cursor when in place mode
            if (editorState.tool === 'place' && wps.length > 0) {
                let last = wps[wps.length - 1];
                ctx.beginPath();
                ctx.moveTo(last.x, last.y);
                ctx.lineTo(editorState.mouseWorldX, editorState.mouseWorldY);
                ctx.lineWidth = 2 / zoom;
                ctx.strokeStyle = 'rgba(251, 197, 49, 0.4)';
                ctx.setLineDash([6 / zoom, 6 / zoom]);
                ctx.stroke();
                ctx.setLineDash([]);

                // Ghost circle at cursor
                ctx.beginPath();
                ctx.arc(editorState.mouseWorldX, editorState.mouseWorldY, 10 / zoom, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(251, 197, 49, 0.3)';
                ctx.fill();
            }

            // Draw features
            editorState.features.forEach((f, i) => {
                ctx.save();
                ctx.translate(f.x, f.y);
                ctx.rotate(f.angle || 0);
                if (f.type === 'boost') {
                    ctx.fillStyle = '#ff00ea';
                    ctx.beginPath(); ctx.moveTo(-40, -40); ctx.lineTo(40, 0); ctx.lineTo(-40, 40); ctx.fill();
                    ctx.fillStyle = '#00f3ff';
                    ctx.beginPath(); ctx.moveTo(-60, -40); ctx.lineTo(20, 0); ctx.lineTo(-60, 40); ctx.fill();
                } else if (f.type === 'ramp') {
                    ctx.fillStyle = '#ff9900';
                    ctx.fillRect(-50, -60, 100, 120);
                    ctx.fillStyle = '#ffff00';
                    ctx.fillRect(-30, -60, 60, 120);
                } else if (f.type === 'oil') {
                    ctx.fillStyle = '#111';
                    ctx.beginPath(); ctx.arc(0, 0, 60, 0, Math.PI*2); ctx.fill();
                    ctx.beginPath(); ctx.arc(30, 20, 40, 0, Math.PI*2); ctx.fill();
                }
                ctx.restore();

                // Highlight hover
                if (i === editorState.hoverFeature && (editorState.tool === 'delete' || editorState.tool === 'feature')) {
                    ctx.beginPath();
                    ctx.arc(f.x, f.y, 70, 0, Math.PI * 2);
                    ctx.strokeStyle = editorState.tool === 'delete' ? '#ff3333' : '#fbc531';
                    ctx.lineWidth = 3 / zoom;
                    ctx.stroke();
                }
            });

            // Draw waypoint markers
            wps.forEach((wp, i) => {
                let isHover = i === editorState.hoverWP;
                let isSelected = i === editorState.selectedWP && editorState.dragging;
                let radius = (isHover || isSelected ? 14 : 10) / zoom;

                ctx.beginPath();
                ctx.arc(wp.x, wp.y, radius, 0, Math.PI * 2);
                ctx.fillStyle = i === 0 ? '#39ff14' : (isSelected ? '#ff00ea' : (isHover ? '#fbc531' : '#00f3ff'));
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2 / zoom;
                ctx.stroke();

                // Number label
                ctx.fillStyle = '#000';
                ctx.font = `bold ${Math.max(10, 12 / zoom)}px Orbitron`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(i + 1, wp.x, wp.y);

                // Delete highlight
                if (isHover && editorState.tool === 'delete') {
                    ctx.beginPath();
                    ctx.arc(wp.x, wp.y, radius + 6 / zoom, 0, Math.PI * 2);
                    ctx.strokeStyle = '#ff3333';
                    ctx.lineWidth = 3 / zoom;
                    ctx.setLineDash([4 / zoom, 4 / zoom]);
                    ctx.stroke();
                    ctx.setLineDash([]);
                }
            });

            ctx.restore();
        }

        function updateEditorControls() {
            if (gameState !== 'TRACK_EDITOR') return;
            let panSpeed = Math.max(18, 34 / Math.max(droneView.zoom, 0.12));
            let moved = false;
            if (keys['ArrowLeft'] || keys['a']) { droneView.centerX -= panSpeed; moved = true; }
            if (keys['ArrowRight'] || keys['d']) { droneView.centerX += panSpeed; moved = true; }
            if (keys['ArrowUp'] || keys['w']) { droneView.centerY -= panSpeed; moved = true; }
            if (keys['ArrowDown'] || keys['s']) { droneView.centerY += panSpeed; moved = true; }
        }
        // ========== END TRACK EDITOR ==========
        
        function openUpgradeShop() {
            showScreen('upgrade-shop-screen');
            updateUpgradeShopUI();
        }

        function buyUpgrade(type) {
            let costs = [50, 100, 200, 400, 800];
            let level = playerUpgrades[type];
            if (level >= 5) return;
            let cost = costs[level];
            if (playerCoins >= cost) {
                playerCoins -= cost;
                playerUpgrades[type]++;
                localStorage.setItem('webRacers_coins', playerCoins);
                localStorage.setItem('webRacers_upgrades', JSON.stringify(playerUpgrades));
                updateUpgradeShopUI();
                audio.playSynth('synthBass', 84, 0, 0.2, 0.4);
            } else {
                audio.playSynth('synthBass', 40, 0, 0.2, 0.5); // Error buzz
            }
        }

        function updateUpgradeShopUI() {
            let shopEl = document.getElementById('upgrade-shop-screen');
            if(!shopEl) return;
            let coinsEl = document.getElementById('shop-coins');
            if(coinsEl) coinsEl.innerText = playerCoins;
            
            ['speed', 'accel', 'handling', 'nitro'].forEach(type => {
                let level = playerUpgrades[type];
                let costs = [50, 100, 200, 400, 800];
                let costStr = level >= 5 ? 'MAX' : costs[level] + ' Coins';
                let btn = document.getElementById('buy-' + type);
                if(btn) {
                    btn.innerText = 'Upgrade (' + costStr + ')';
                    if(level >= 5 || playerCoins < costs[level]) btn.style.opacity = '0.5';
                    else btn.style.opacity = '1';
                }
                
                let bars = document.getElementById('bars-' + type);
                if(bars) {
                    bars.innerHTML = '';
                    for(let i=0; i<5; i++) {
                        bars.innerHTML += `<div style="width:20px;height:10px;margin-right:2px;display:inline-block;background:${i < level ? '#00f3ff' : '#333'};box-shadow:${i < level ? '0 0 5px #00f3ff' : 'none'}"></div>`;
                    }
                }
            });
        }

        function openMainMenu() {
            audio.startMusic('menu');
            gameState = 'MENU';
            showScreen('main-menu');
            generateSpeedLines();
            startAttractModeTimer();
        }

        // Watch for gameState changes to MENU and start attract mode timer
        Object.defineProperty(window, 'gameState', {
            get: function() { return this._gameState; },
            set: function(value) {
                this._gameState = value;
                if (value === 'MENU' && !attractMode.isActive) {
                    console.log('gameState changed to MENU, starting attract mode timer');
                    startAttractModeTimer();
                } else if (value !== 'MENU') {
                    console.log('gameState changed from MENU, stopping attract mode timer');
                    stopAttractModeTimer();
                }
                if (value === 'OPEN_WORLD') {
                    console.log('gameState changed to OPEN_WORLD');
                }
            }
        });

        // --- Attract Mode (Demo Race) Functions ---
        function startAttractModeTimer() {
            stopAttractModeTimer();
            attractMode.lastActivityTime = Date.now();
            console.log('Attract mode timer started, will trigger in 20 seconds of inactivity, gameState =', gameState);
            attractMode.inactivityTimer = setInterval(() => {
                // Only trigger if we're in MENU state
                if (gameState !== 'MENU') {
                    console.log('Attract mode check: gameState is', gameState, ', skipping');
                    return;
                }
                let timeSinceActivity = Date.now() - attractMode.lastActivityTime;
                console.log('Attract mode check: timeSinceActivity =', timeSinceActivity, 'ms, isActive =', attractMode.isActive);
                if (timeSinceActivity >= attractMode.inactivityDuration && !attractMode.isActive) {
                    console.log('Attract mode triggered after', timeSinceActivity, 'ms of inactivity');
                    startAttractMode();
                }
            }, 1000);
        }

        function stopAttractModeTimer() {
            if (attractMode.inactivityTimer) {
                clearInterval(attractMode.inactivityTimer);
                attractMode.inactivityTimer = null;
            }
        }

        function recordUserActivity() {
            // Only reset timer when in menu state, not during gameplay
            if (gameState === 'MENU' && !attractMode.isActive) {
                attractMode.lastActivityTime = Date.now();
            }
            if (attractMode.isActive) {
                exitAttractMode();
            }
        }

        function startAttractMode() {
            attractMode.isActive = true;
            console.log('Starting attract mode fade-to-white');
            const fadeOverlay = document.getElementById('fade-overlay');
            if (fadeOverlay) {
                console.log('Fade overlay found, starting transition');
                fadeOverlay.classList.remove('hidden');
                setTimeout(() => {
                    fadeOverlay.style.opacity = '1';
                }, 10);
            } else {
                console.error('Fade overlay not found!');
            }
            
            setTimeout(() => {
                console.log('Starting demo race');
                startDemoRace();
            }, 3000);
        }

        function exitAttractMode() {
            attractMode.isActive = false;
            const fadeOverlay = document.getElementById('fade-overlay');
            if (fadeOverlay) {
                fadeOverlay.style.opacity = '0';
                setTimeout(() => {
                    fadeOverlay.classList.add('hidden');
                }, 3000);
            }
            
            setTimeout(() => {
                quitToMenu();
            }, 3000);
        }

        function startDemoRace() {
            console.log('startDemoRace called');
            gameMode = 'DEMO_MODE';
            currentMapIndex = Math.floor(Math.random() * 10);
            config.totalLaps = 3;
            console.log('Starting demo race on map', currentMapIndex);
            startLoadingScreen(currentMapIndex);
        }

        // --- Open World Mode Functions ---
        function openOpenWorld() {
            console.log('Starting open world mode');
            openWorldMode.isActive = true;
            openWorldMode.currentRegion = 'city';
            openWorldMode.loadedRegions = ['city'];
            openWorldMode.trafficCars = [];
            openWorldMode.worldCoins = [];
            
            gameState = 'OPEN_WORLD';
            gameMode = 'OPEN_WORLD';
            
            // Hide all screens
            screens.classList.add('hidden');
            document.querySelectorAll('.screen-panel').forEach(p => p.classList.add('hidden'));
            
            // Show UI layer
            uiLayer.classList.remove('hidden');
            
            // Hide fade overlay (in case it's visible from attract mode)
            const fadeOverlay = document.getElementById('fade-overlay');
            if (fadeOverlay) {
                fadeOverlay.classList.add('hidden');
                fadeOverlay.style.opacity = '0';
            }
            
            // Show open world HUD, hide race stats
            const openWorldHud = document.getElementById('open-world-hud');
            const raceStats = document.getElementById('race-stats');
            if (openWorldHud) openWorldHud.classList.remove('hidden');
            if (raceStats) raceStats.classList.add('hidden');
            
            // Load city region as starting point
            loadRegion('city');
            
            // Spawn player at city center
            const cityRegion = openWorldData.regions.find(r => r.id === 'city');
            if (cityRegion) {
                const carType = carTypes[selectedCarIndex];
                player = new Car(
                    cityRegion.position.x,
                    cityRegion.position.y,
                    carType.color,
                    true,
                    'Player',
                    { speedMult: 1.0, accelMult: 1.0, turnMult: 1.0 }
                );
                player.angle = 0;
                // Apply car type stats
                player.maxSpeed = carType.maxSpeed;
                player.baseAcceleration = carType.baseAcceleration;
                player.turnSpeed = carType.turnSpeed;
                // Apply player upgrades
                player.maxSpeed += playerUpgrades.speed * 2;
                player.baseAcceleration += playerUpgrades.accel * 0.05;
                player.turnSpeed += playerUpgrades.handling * 0.01;
                player.nitroMax = 100 + playerUpgrades.nitro * 20;
                cars = [player];
                player2 = null;
            }
            
            // Set camera to player
            camera.x = player.x - canvas.width / 2;
            camera.y = player.y - canvas.height / 2;
            
            // Generate coins for the world
            generateWorldCoins();
            
            // Start traffic
            spawnTraffic();
            
            audio.startMusic('menu');
        }

        function loadRegion(regionId) {
            console.log('Loading region:', regionId);
            const region = openWorldData.regions.find(r => r.id === regionId);
            if (!region) return;
            
            // If it's a valid map index, load that map
            if (region.mapIndex >= 0) {
                currentMapIndex = region.mapIndex;
                activeWaypoints = [...mapsData[region.mapIndex].waypoints];
                
                // Offset waypoints by region position
                activeWaypoints = activeWaypoints.map(wp => ({
                    x: wp.x + region.position.x,
                    y: wp.y + region.position.y
                }));
                
                rebuildTrackRenderCache();
                generateScenery(region.mapIndex);
            }
            
            // Load connecting highways
            region.connections.forEach(connId => {
                const highway = openWorldData.highways.find(h => 
                    (h.from === regionId && h.to === connId) ||
                    (h.to === regionId && h.from === connId)
                );
                if (highway) {
                    loadHighway(highway, region.position);
                }
            });
        }

        function loadHighway(highway, regionPosition) {
            // Add highway waypoints to activeWaypoints for rendering and collision
            highway.waypoints.forEach(wp => {
                activeWaypoints.push({ x: wp.x, y: wp.y });
            });
            rebuildTrackRenderCache();
        }

        function unloadRegion(regionId) {
            console.log('Unloading region:', regionId);
            openWorldMode.loadedRegions = openWorldMode.loadedRegions.filter(r => r !== regionId);
        }

        function detectRegionBoundary() {
            if (!player || !openWorldMode.isActive) return null;
            // Don't trigger another transition while one is already in progress
            if (openWorldMode.transitionDir !== 0) return null;
            for (const region of openWorldData.regions) {
                const dist = Math.sqrt(
                    Math.pow(player.x - region.position.x, 2) +
                    Math.pow(player.y - region.position.y, 2)
                );
                if (dist < 6000 && openWorldMode.currentRegion !== region.id) {
                    return region.id;
                }
            }
            return null;
        }

        function handleRegionTransition(newRegionId) {
            // Start the fade-to-black transition
            openWorldMode.transitionDir = 1;
            openWorldMode.transitionPendingRegion = newRegionId;
        }

        function _commitRegionTransition(newRegionId) {
            console.log('Committing region transition to:', newRegionId);
            openWorldMode.currentRegion = newRegionId;
            if (!openWorldMode.loadedRegions.includes(newRegionId)) {
                loadRegion(newRegionId);
                openWorldMode.loadedRegions.push(newRegionId);
            }
            // Show region banner
            const region = openWorldData.regions.find(r => r.id === newRegionId);
            if (region) {
                openWorldMode.regionBannerText = region.name.toUpperCase();
                openWorldMode.regionBannerAlpha = 1.0;
                openWorldMode.regionBannerTimer = 180; // 3 seconds at 60fps
            }
            // Unload very distant regions to save memory
            openWorldMode.loadedRegions = openWorldMode.loadedRegions.filter(rid => {
                const r = openWorldData.regions.find(x => x.id === rid);
                if (!r) return false;
                const dist = Math.sqrt(
                    Math.pow(player.x - r.position.x, 2) +
                    Math.pow(player.y - r.position.y, 2)
                );
                return dist < 80000;
            });
        }

        function updateOpenWorldTransition() {
            if (!openWorldMode.isActive) return;
            const speed = 0.04;
            if (openWorldMode.transitionDir === 1) {
                openWorldMode.transitionAlpha = Math.min(1, openWorldMode.transitionAlpha + speed);
                if (openWorldMode.transitionAlpha >= 1) {
                    // At peak black — commit the region switch
                    if (openWorldMode.transitionPendingRegion) {
                        _commitRegionTransition(openWorldMode.transitionPendingRegion);
                        openWorldMode.transitionPendingRegion = null;
                    }
                    openWorldMode.transitionDir = -1;
                }
            } else if (openWorldMode.transitionDir === -1) {
                openWorldMode.transitionAlpha = Math.max(0, openWorldMode.transitionAlpha - speed);
                if (openWorldMode.transitionAlpha <= 0) {
                    openWorldMode.transitionDir = 0;
                }
            }
            // Fade out banner
            if (openWorldMode.regionBannerTimer > 0) {
                openWorldMode.regionBannerTimer--;
                if (openWorldMode.regionBannerTimer < 60) {
                    openWorldMode.regionBannerAlpha = openWorldMode.regionBannerTimer / 60;
                }
            }
        }

        // Draw the open world background: biome fills, then highway roads
        function drawOpenWorldBackground(cx, cy) {
            const REGION_RADIUS = 18000;
            // 1. Biome fills per region
            openWorldData.regions.forEach(r => {
                let rx = r.position.x - cx;
                let ry = r.position.y - cy;
                let grad = ctx.createRadialGradient(rx, ry, REGION_RADIUS * 0.1, rx, ry, REGION_RADIUS * 1.4);
                grad.addColorStop(0, r.biomeColor);
                grad.addColorStop(1, adjustHexColor(r.biomeColor, -30));
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(rx, ry, REGION_RADIUS * 1.4, 0, Math.PI * 2);
                ctx.fill();
            });

            // 2. Draw highways as proper multi-lane roads
            openWorldData.highways.forEach(h => {
                if (h.waypoints.length < 2) return;
                const w = h.width || 280;
                // Shoulder (wider)
                ctx.lineWidth = w + 80;
                ctx.lineCap = 'round'; ctx.lineJoin = 'round';
                ctx.strokeStyle = h.shoulderColor || '#555';
                ctx.beginPath();
                h.waypoints.forEach((wp, i) => {
                    let x = wp.x - cx, y = wp.y - cy;
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                });
                ctx.stroke();

                // Road edge (dark border)
                ctx.lineWidth = w + 12;
                ctx.strokeStyle = adjustHexColor(h.roadColor || '#2a2a2a', -20);
                ctx.beginPath();
                h.waypoints.forEach((wp, i) => {
                    let x = wp.x - cx, y = wp.y - cy;
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                });
                ctx.stroke();

                // Road surface
                ctx.lineWidth = w;
                ctx.strokeStyle = h.roadColor || '#2a2a2a';
                ctx.beginPath();
                h.waypoints.forEach((wp, i) => {
                    let x = wp.x - cx, y = wp.y - cy;
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                });
                ctx.stroke();

                // Centre dashed lane line
                ctx.lineWidth = 8;
                ctx.strokeStyle = hexToRgba(h.lineColor || '#ffffff', 0.75);
                ctx.setLineDash([80, 80]);
                ctx.beginPath();
                h.waypoints.forEach((wp, i) => {
                    let x = wp.x - cx, y = wp.y - cy;
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                });
                ctx.stroke();
                ctx.setLineDash([]);

                // Edge lane markings (both sides)
                [-1, 1].forEach(side => {
                    ctx.lineWidth = 6;
                    ctx.strokeStyle = hexToRgba(h.lineColor || '#ffffff', 0.3);
                    ctx.setLineDash([40, 120]);
                    // offset approximated inline per segment
                    ctx.beginPath();
                    for (let i = 1; i < h.waypoints.length; i++) {
                        const p0 = h.waypoints[i - 1], p1 = h.waypoints[i];
                        const dx = p1.x - p0.x, dy = p1.y - p0.y;
                        const len = Math.sqrt(dx*dx+dy*dy) || 1;
                        const nx = -dy/len * (w/2 - 20) * side;
                        const ny =  dx/len * (w/2 - 20) * side;
                        const x0 = p0.x - cx + nx, y0 = p0.y - cy + ny;
                        const x1 = p1.x - cx + nx, y1 = p1.y - cy + ny;
                        if (i === 1) ctx.moveTo(x0, y0); else ctx.lineTo(x0, y0);
                        ctx.lineTo(x1, y1);
                    }
                    ctx.stroke();
                    ctx.setLineDash([]);
                });
            });

            // 3. Region border circles (subtle outline)
            openWorldData.regions.forEach(r => {
                let rx = r.position.x - cx;
                let ry = r.position.y - cy;
                ctx.strokeStyle = hexToRgba(r.mmColor || '#ffffff', 0.15);
                ctx.lineWidth = 3;
                ctx.setLineDash([60, 60]);
                ctx.beginPath();
                ctx.arc(rx, ry, REGION_RADIUS, 0, Math.PI * 2);
                ctx.stroke();
                ctx.setLineDash([]);
            });
        }

        // Draw biome-aware world background colour (fills the viewport before camera offset)
        function getOpenWorldBgColor() {
            if (!player) return '#3a3f4a';
            let closestRegion = null, closestDist = Infinity;
            openWorldData.regions.forEach(r => {
                const d = Math.sqrt(Math.pow(player.x - r.position.x, 2) + Math.pow(player.y - r.position.y, 2));
                if (d < closestDist) { closestDist = d; closestRegion = r; }
            });
            return closestRegion ? closestRegion.biomeColor : '#3a3f4a';
        }

        function drawOpenWorldTransitionOverlay() {
            if (openWorldMode.transitionAlpha <= 0 && openWorldMode.regionBannerAlpha <= 0) return;
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);

            // Transition fade
            if (openWorldMode.transitionAlpha > 0) {
                ctx.fillStyle = `rgba(0,0,0,${openWorldMode.transitionAlpha})`;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }

            // Region name banner
            if (openWorldMode.regionBannerAlpha > 0 && openWorldMode.regionBannerText) {
                const alpha = openWorldMode.regionBannerAlpha;
                const cx2 = canvas.width / 2;
                const cy2 = canvas.height * 0.38;
                // Background pill
                ctx.fillStyle = `rgba(0,0,0,${0.55 * alpha})`;
                ctx.beginPath();
                ctx.roundRect(cx2 - 260, cy2 - 40, 520, 80, 12);
                ctx.fill();
                // Label text
                ctx.globalAlpha = alpha;
                ctx.font = 'bold 14px Orbitron, monospace';
                ctx.fillStyle = '#aaaacc';
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText('ENTERING AREA', cx2, cy2 - 16);
                ctx.font = 'bold 34px Orbitron, monospace';
                ctx.fillStyle = '#ffffff';
                ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 18;
                ctx.fillText(openWorldMode.regionBannerText, cx2, cy2 + 16);
                ctx.shadowBlur = 0;
                ctx.globalAlpha = 1;
            }
            ctx.restore();
        }

        function generateWorldCoins() {
            openWorldMode.worldCoins = [];
            // Coins along every highway waypoint pair mid-points
            openWorldData.highways.forEach(highway => {
                for (let i = 0; i < highway.waypoints.length - 1; i++) {
                    const a = highway.waypoints[i], b = highway.waypoints[i + 1];
                    const steps = Math.max(3, Math.floor(Math.sqrt(Math.pow(b.x-a.x,2)+Math.pow(b.y-a.y,2)) / 4000));
                    for (let s = 1; s < steps; s++) {
                        const t = s / steps;
                        const jitter = (highway.width || 280) * 0.3;
                        openWorldMode.worldCoins.push({
                            x: a.x + (b.x - a.x) * t + (Math.random() - 0.5) * jitter,
                            y: a.y + (b.y - a.y) * t + (Math.random() - 0.5) * jitter,
                            value: 1,
                            active: true
                        });
                    }
                }
            });
            // Coins scattered around region centres
            openWorldData.regions.forEach(r => {
                for (let i = 0; i < 12; i++) {
                    const angle = (i / 12) * Math.PI * 2;
                    const radius = 3000 + Math.random() * 5000;
                    openWorldMode.worldCoins.push({
                        x: r.position.x + Math.cos(angle) * radius,
                        y: r.position.y + Math.sin(angle) * radius,
                        value: 2,
                        active: true
                    });
                }
            });
        }

        function spawnTraffic() {
            // Spawn traffic cars on highways
            openWorldData.highways.forEach(highway => {
                // Spawn 2-3 traffic cars per highway
                const numCars = 2 + Math.floor(Math.random() * 2);
                for (let i = 0; i < numCars; i++) {
                    const wpIndex = Math.floor(Math.random() * highway.waypoints.length);
                    const wp = highway.waypoints[wpIndex];
                    
                    const trafficCar = new Car(
                        wp.x,
                        wp.y,
                        AI_COLORS[Math.floor(Math.random() * AI_COLORS.length)],
                        false,
                        'Traffic',
                        { speedMult: 0.5, accelMult: 0.5, turnMult: 0.8 }
                    );
                    trafficCar.speed = 8 + Math.random() * 4; // Slower than player
                    trafficCar.angle = 0;
                    trafficCar.isTraffic = true;
                    trafficCar.highwayId = highway.id;
                    trafficCar.currentWaypoint = wpIndex;
                    
                    openWorldMode.trafficCars.push(trafficCar);
                }
            });
        }

        function updateTraffic() {
            if (!openWorldMode.isActive) return;
            
            openWorldMode.trafficCars.forEach(car => {
                const highway = openWorldData.highways.find(h => h.id === car.highwayId);
                if (!highway) return;
                
                // Move along highway waypoints
                const targetWp = highway.waypoints[car.currentWaypoint];
                const dx = targetWp.x - car.x;
                const dy = targetWp.y - car.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                
                if (dist < 100) {
                    // Reached waypoint, move to next
                    car.currentWaypoint = (car.currentWaypoint + 1) % highway.waypoints.length;
                } else {
                    // Move toward waypoint
                    const angle = Math.atan2(dy, dx);
                    car.angle = angle;
                    car.x += Math.cos(angle) * car.speed;
                    car.y += Math.sin(angle) * car.speed;
                }
            });
        }

        function updateWorldCoins() {
            if (!openWorldMode.isActive || !player) return;
            
            openWorldMode.worldCoins.forEach(coin => {
                if (!coin.active) return;
                
                const dist = Math.sqrt(
                    Math.pow(player.x - coin.x, 2) +
                    Math.pow(player.y - coin.y, 2)
                );
                
                if (dist < 100) {
                    coin.active = false;
                    playerCoins += coin.value;
                    localStorage.setItem('webRacers_coins', playerCoins);
                    audio.playSynth('piano', 84, Tone.now(), 0.1, 0.4);
                    
                    // Respawn coin after 30 seconds
                    setTimeout(() => {
                        coin.active = true;
                    }, 30000);
                }
            });
        }

        function updateOpenWorldHUD() {
            if (!openWorldMode.isActive || !player) return;
            
            // Update region name
            const region = openWorldData.regions.find(r => r.id === openWorldMode.currentRegion);
            if (region) {
                const regionVal = document.getElementById('region-val');
                if (regionVal) regionVal.innerText = region.name;
            }
            
            // Update coin count
            const owCoinVal = document.getElementById('ow-coin-val');
            if (owCoinVal) owCoinVal.innerText = playerCoins;
            
            // Check for garage proximity
            const garagePrompt = document.getElementById('garage-prompt');
            if (garagePrompt) {
                const currentRegion = openWorldData.regions.find(r => r.id === openWorldMode.currentRegion);
                if (currentRegion && currentRegion.hasGarage) {
                    const dist = Math.sqrt(
                        Math.pow(player.x - currentRegion.position.x, 2) +
                        Math.pow(player.y - currentRegion.position.y, 2)
                    );
                    if (dist < 500) {
                        garagePrompt.classList.remove('hidden');
                    } else {
                        garagePrompt.classList.add('hidden');
                    }
                } else {
                    garagePrompt.classList.add('hidden');
                }
            }
            
            // Check for race start proximity
            const racePrompt = document.getElementById('race-start-prompt');
            if (racePrompt) {
                const currentRegion = openWorldData.regions.find(r => r.id === openWorldMode.currentRegion);
                if (currentRegion && currentRegion.hasRaceStart) {
                    const dist = Math.sqrt(
                        Math.pow(player.x - currentRegion.raceStartLocation.x, 2) +
                        Math.pow(player.y - currentRegion.raceStartLocation.y, 2)
                    );
                    if (dist < 500) {
                        racePrompt.classList.remove('hidden');
                    } else {
                        racePrompt.classList.add('hidden');
                    }
                } else {
                    racePrompt.classList.add('hidden');
                }
            }
        }

        function generateSpeedLines() {
            let container = document.getElementById('menu-speed-lines');
            if (!container) return;
            container.innerHTML = '';
            for (let i = 0; i < 12; i++) {
                let line = document.createElement('div');
                line.className = 'speed-line';
                line.style.top = (5 + Math.random() * 90) + '%';
                line.style.width = (80 + Math.random() * 200) + 'px';
                line.style.animationDelay = (Math.random() * 4) + 's';
                line.style.animationDuration = (1.5 + Math.random() * 2.5) + 's';
                line.style.opacity = (0.15 + Math.random() * 0.35);
                container.appendChild(line);
            }
        }
        
        function openSettings() {
            audio.init();
            audio.startMusic('menu');
            gameState = 'MENU';
            showScreen('settings-menu');
        }

        function openMusicPlayer() {
            audio.init();
            gameState = 'MENU';
            showScreen('music-player-menu');
        }

        function togglePause() {
            if(gameState === 'PLAYING' || gameState === 'OPEN_WORLD') {
                gameState = 'PAUSED';
                audio.updateEngine(0, false);
                audio.setScreech(false);
                showScreen('pause-menu');
            } else if (gameState === 'PAUSED') {
                // Resume to previous state
                if (openWorldMode.isActive) {
                    gameState = 'OPEN_WORLD';
                } else {
                    gameState = 'PLAYING';
                }
                screens.classList.add('hidden');
                uiLayer.classList.remove('hidden');
                keys = {}; 
                resetDpadVisuals();
            }
        }

        function claimTrophy() { gameState = 'CUP_VICTORY'; showScreen('cup-victory-screen'); audio.victory(); }
        function quitToMenu() {
            // If in open world mode, exit open world
            if (openWorldMode.isActive) {
                openWorldMode.isActive = false;
                openWorldMode.trafficCars = [];
                openWorldMode.worldCoins = [];
                
                // Hide open world HUD
                const openWorldHud = document.getElementById('open-world-hud');
                if (openWorldHud) openWorldHud.classList.add('hidden');
            }
            
            // If returning from editor test drive, go back to editor
            if (editorState.savedBeforeTest) {
                let saved = editorState.savedBeforeTest;
                editorState.waypoints = saved.waypoints;
                editorState.features = saved.features;
                editorState.themeIndex = saved.themeIndex;
                // Remove temp track from mapsData
                injectCustomTracksIntoMapsData();
                audio.updateEngine(0, false);
                audio.setScreech(false);
                audio.stopRain();
                audio.stopVictory();
                audio.stopFanfare();
                openTrackEditor();
                document.getElementById('editor-name-input').value = saved.name || '';
                editorUpdateThemeHighlight();
                editorSyncTrackPreview();
                editorUpdateStatus();
                if (editorState.waypoints.length > 0) {
                    let bounds = getWaypointBounds(editorState.waypoints);
                    droneView.centerX = bounds.centerX;
                    droneView.centerY = bounds.centerY;
                    let fitZ = Math.min(canvas.width / (bounds.width + 800), canvas.height / (bounds.height + 800));
                    droneView.zoom = clamp(fitZ, droneView.minZoom, droneView.maxZoom);
                }
                return;
            }
            const { doc, deleteDoc } = window.firebaseModular;
            lastMultiplayerSyncTime = 0;
            if (playersUnsubscribe) playersUnsubscribe();
            if (lobbyUnsubscribe) lobbyUnsubscribe();
            if (multiplayerSessionId && auth.currentUser) {
                const _quitPath = `sessions/${multiplayerSessionId}/players/${auth.currentUser.uid}`;
                // BUG FIX: Added missing .catch to prevent unhandled promise rejection
                deleteDoc(doc(db, 'sessions', multiplayerSessionId, 'players', auth.currentUser.uid))
                    .catch(err => console.error('deleteDoc on quit failed:', err));
            }
            multiplayerSessionId = null;
            multiplayerSessionCode = null;
            gameMode = 'QUICK_RACE';

            gameState = 'MENU';
            audio.updateEngine(0, false);
            audio.setScreech(false);
            audio.stopRain();
            audio.stopVictory();
            audio.stopFanfare();
            audio.startMusic('menu');
            showScreen('main-menu');
        }

        window.addEventListener('mousedown', () => { recordUserActivity(); if(gameState === 'PLAYING') window.focus(); });
        window.addEventListener('touchstart', () => { recordUserActivity(); if(gameState === 'PLAYING') window.focus(); });

        // BUG FIX: Clear all keys when window loses focus to prevent stuck inputs
        window.addEventListener('blur', () => { keys = {}; });

        window.addEventListener('keydown', (e) => {
            recordUserActivity();
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', ' ', 'Shift'].includes(e.key)) e.preventDefault();
            
            if (gameState === 'CAR_SELECT') {
                if (e.key === 'ArrowRight' || e.key === 'd') {
                    selectCar((selectedCarIndex + 1) % carTypes.length);
                } else if (e.key === 'ArrowLeft' || e.key === 'a') {
                    selectCar((selectedCarIndex - 1 + carTypes.length) % carTypes.length);
                }
            }

            if (gameState === 'PLAYING' && raceEndTime) {
                if (e.key.toLowerCase() === 'e') {
                    spectateTarget = (spectateTarget + 1) % cars.length;
                } else if (e.key.toLowerCase() === 'q') {
                    spectateTarget = (spectateTarget - 1 + cars.length) % cars.length;
                }
            }

            if (gameState === 'DRONE_VIEW') {
                let key = e.key.toLowerCase();
                if (key === 'q') {
                    e.preventDefault();
                    adjustDroneZoom(0.9);
                    return;
                }
                if (key === 'e') {
                    e.preventDefault();
                    adjustDroneZoom(1.1111111111);
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    exitDroneView();
                    return;
                }
                if (key === 'f') {
                    e.preventDefault();
                    fitDroneView();
                    return;
                }
            }

            if (gameState === 'TRACK_EDITOR') {
                let key = e.key.toLowerCase();
                // Don't intercept keys when typing in the name input
                if (document.activeElement && document.activeElement.id === 'editor-name-input') {
                    if (e.key === 'Escape') { document.activeElement.blur(); e.preventDefault(); }
                    return;
                }
                if (key === 'q') {
                    e.preventDefault();
                    droneView.zoom = clamp(droneView.zoom * 0.9, droneView.minZoom, droneView.maxZoom);
                    return;
                }
                if (key === 'e') {
                    e.preventDefault();
                    droneView.zoom = clamp(droneView.zoom * 1.1111111111, droneView.minZoom, droneView.maxZoom);
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    editorExit();
                    return;
                }
                if (key === 'z' && editorState.waypoints.length > 0) {
                    e.preventDefault();
                    editorState.waypoints.pop();
                    editorSyncTrackPreview();
                    editorUpdateStatus();
                    return;
                }
                if (key === '1') { editorSetTool('place'); return; }
                if (key === '2') { editorSetTool('move'); return; }
                if (key === '3') { editorSetTool('delete'); return; }
                if (key === '4') { editorSetTool('feature'); return; }
            }

            if (gameState === 'OPEN_WORLD') {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    quitToMenu();
                    return;
                }
                if (e.key.toLowerCase() === 'g') {
                    e.preventDefault();
                    // Check if near garage
                    const currentRegion = openWorldData.regions.find(r => r.id === openWorldMode.currentRegion);
                    if (currentRegion && currentRegion.hasGarage) {
                        const dist = Math.sqrt(
                            Math.pow(player.x - currentRegion.position.x, 2) +
                            Math.pow(player.y - currentRegion.position.y, 2)
                        );
                        if (dist < 500) {
                            openUpgradeShop();
                        }
                    }
                    return;
                }
                if (e.key.toLowerCase() === 'e') {
                    e.preventDefault();
                    // Check if near race start
                    const currentRegion = openWorldData.regions.find(r => r.id === openWorldMode.currentRegion);
                    if (currentRegion && currentRegion.hasRaceStart) {
                        const dist = Math.sqrt(
                            Math.pow(player.x - currentRegion.raceStartLocation.x, 2) +
                            Math.pow(player.y - currentRegion.raceStartLocation.y, 2)
                        );
                        if (dist < 500) {
                            // Start race on this region's map
                            if (currentRegion.mapIndex >= 0) {
                                openWorldMode.isActive = false;
                                openWorldMode.trafficCars = [];
                                openWorldMode.worldCoins = [];
                                const openWorldHud = document.getElementById('open-world-hud');
                                if (openWorldHud) openWorldHud.classList.add('hidden');
                                startLoadingScreen(currentRegion.mapIndex);
                            }
                        }
                    }
                    return;
                }
            }

            if (e.key.toLowerCase() === 'p') { togglePause(); return; }
            keys[e.key] = true;
            if (e.key.length === 1) keys[e.key.toLowerCase()] = true;
        });
        window.addEventListener('keyup', (e) => {
            keys[e.key] = false;
            // BUG FIX: Also clear both cases so Shift+key combos don't get stuck
            if (e.key.length === 1) {
                keys[e.key.toLowerCase()] = false;
                keys[e.key.toUpperCase()] = false;
            }
        });

        function getBtnIdForKey(key) {
            if(key === 'ArrowUp') return 'btn-up'; if(key === 'ArrowDown') return 'btn-down';
            if(key === 'ArrowLeft') return 'btn-left'; if(key === 'ArrowRight') return 'btn-right';
            if(key === 'Shift' || key === 'Nitro') return 'btn-nitro';
            return '';
        }
        function bindTouch(btnId, keyName, oppositeKeyName) {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            const press = (e) => {
                if (e.cancelable) e.preventDefault();
                keys[keyName] = true;
                btn.classList.add('active');
                if (oppositeKeyName) {
                    keys[oppositeKeyName] = false;
                    const oppBtn = document.getElementById(getBtnIdForKey(oppositeKeyName));
                    if (oppBtn) oppBtn.classList.remove('active');
                }
            };
            const release = (e) => {
                if (e.cancelable) e.preventDefault();
                keys[keyName] = false;
                btn.classList.remove('active');
            };
            btn.addEventListener('mousedown', press);
            btn.addEventListener('touchstart', press, {passive: false});
            btn.addEventListener('mouseup', release);
            btn.addEventListener('mouseleave', release);
            btn.addEventListener('touchend', release, {passive: false});
        }
        bindTouch('btn-up', 'ArrowUp', 'ArrowDown');
        bindTouch('btn-down', 'ArrowDown', 'ArrowUp');
        bindTouch('btn-left', 'ArrowLeft', 'ArrowRight');
        bindTouch('btn-right', 'ArrowRight', 'ArrowLeft');
        bindTouch('btn-nitro', 'Nitro', null);

        function resetDpadVisuals() {
            ['btn-up', 'btn-down', 'btn-left', 'btn-right', 'btn-nitro'].forEach(id => {
                const btn = document.getElementById(id);
                if (btn) btn.classList.remove('active');
            });
        }

        canvas.addEventListener('wheel', (e) => {
            if (gameState === 'TRACK_EDITOR') {
                e.preventDefault();
                droneView.zoom = clamp(droneView.zoom * (e.deltaY < 0 ? 1.08 : 0.92), droneView.minZoom, droneView.maxZoom);
                return;
            }
            if (gameState !== 'DRONE_VIEW') return;
            e.preventDefault();
            adjustDroneZoom(e.deltaY < 0 ? 1.08 : 0.92);
        }, { passive: false });

        function updateDroneControls() {
            if (gameState !== 'DRONE_VIEW') return;
            let panSpeed = Math.max(18, 34 / Math.max(droneView.zoom, 0.12));
            let moved = false;
            if (keys['ArrowLeft'] || keys['a']) { droneView.centerX -= panSpeed; moved = true; }
            if (keys['ArrowRight'] || keys['d']) { droneView.centerX += panSpeed; moved = true; }
            if (keys['ArrowUp'] || keys['w']) { droneView.centerY -= panSpeed; moved = true; }
            if (keys['ArrowDown'] || keys['s']) { droneView.centerY += panSpeed; moved = true; }
            if (moved) clampDroneView();
        }
        
        document.getElementById('pause-btn-ui').addEventListener('click', togglePause);
        document.getElementById('mute-btn-ui').addEventListener('click', () => { audio.toggleMute(); });
        document.getElementById('minimap-btn-ui').addEventListener('click', () => { showMinimap = !showMinimap; });

        // --- Render & Game Logic ---
        function generateCarSelection() {
            const container = document.getElementById('car-grid-container');
            container.innerHTML = '';
            carTypes.forEach((car, index) => {
                const card = document.createElement('div');
                card.className = `car-card ${index === selectedCarIndex ? 'active' : ''}`;
                card.id = `car-card-${index}`;
                card.setAttribute('data-onclick', 'selectCar(' + index + ')');

                const preview = document.createElement('div');
                preview.className = 'car-preview';
                
                const cCanv = document.createElement('canvas');
                cCanv.width = 100; cCanv.height = 80;
                let cCtx = cCanv.getContext('2d');
                
                cCtx.translate(50, 40);
                cCtx.rotate(-Math.PI/2); 
                
                // Shadow
                cCtx.fillStyle = 'rgba(0,0,0,0.5)';
                cCtx.shadowColor = 'rgba(0,0,0,0.5)';
                cCtx.shadowBlur = 10;
                cCtx.fillRect(-18, -6, 44, 24);
                cCtx.shadowBlur = 0;

                // Body
                let grad = cCtx.createLinearGradient(-22, -12, 22, 12);
                grad.addColorStop(0, 'rgba(255,255,255,0.4)');
                grad.addColorStop(0.5, 'rgba(255,255,255,0)');
                grad.addColorStop(1, 'rgba(0,0,0,0.5)'); 
                
                cCtx.fillStyle = car.color;
                cCtx.beginPath(); cCtx.roundRect(-22, -12, 44, 24, 4); cCtx.fill();
                cCtx.fillStyle = grad; cCtx.fill();

                cCtx.fillStyle = 'rgba(255,255,255,0.3)'; cCtx.fillRect(11, -6, 6, 12);
                cCtx.fillStyle = '#111'; cCtx.fillRect(-11, -8, 22, 16);
                cCtx.fillStyle = 'rgba(255,255,255,0.2)';
                cCtx.beginPath(); cCtx.moveTo(-11, -8); cCtx.lineTo(0, -8); cCtx.lineTo(-11, 0); cCtx.fill();
                cCtx.fillStyle = '#fff'; cCtx.fillRect(18, -10, 4, 6); cCtx.fillRect(18, 4, 4, 6);

                preview.appendChild(cCanv);

                const name = document.createElement('div');
                name.className = 'car-name-label';
                name.innerText = car.name;
                name.style.color = car.color;
                name.style.textShadow = `0 0 5px ${car.color}`;

                let statsHtml = ['speed', 'accel', 'handling'].map(stat => {
                    let label = stat.toUpperCase();
                    if(label==='ACCEL') label = 'ACCEL';
                    if(label==='HANDLING') label = 'HANDL';
                    let val = car.stats[stat];
                    let segments = '';
                    for(let i=0; i<5; i++) {
                        let filled = i < val;
                        segments += `<div class="stat-segment" style="background:${filled ? car.color : 'transparent'}; box-shadow:${filled ? '0 0 4px '+car.color : 'none'}"></div>`;
                    }
                    return `<div class="stat-container"><div class="stat-label">${label}</div><div class="stat-bar-bg">${segments}</div></div>`;
                }).join('');

                card.appendChild(preview);
                card.appendChild(name);
                card.insertAdjacentHTML('beforeend', statsHtml);
                
                container.appendChild(card);
            });
        }

        function selectCar(index) {
            if (window.isP2Selecting) {
                selectedCarIndex2 = index;
            } else {
                selectedCarIndex = index;
            }
            document.querySelectorAll('.car-card').forEach((c, i) => {
                if(i === index) c.classList.add('active');
                else c.classList.remove('active');
            });
            audio.beep();
        }
        
        function generateOpponents(forceCup = false) {
            opponents = [];
            let n = forceCup ? 16 : config.opponentCount;
            let numRiv = 0, numPro = 0, numRac = 0, numRook = 0;
            if(n <= 3) { numRac = Math.ceil(n/2); numRook = n - numRac; }
            else if(n <= 7) { numPro = 1; numRac = Math.ceil((n-1)/2); numRook = n - 1 - numRac; }
            else if(n <= 12) { numRiv = 1 + (Math.random()>0.5?1:0); numPro = 3; numRac = Math.floor((n-numRiv-numPro)/2); numRook = n - numRiv - numPro - numRac; }
            else { numRiv = 2 + Math.floor(Math.random()*3); numPro = 4; numRac = Math.floor((n-numRiv-numPro)/2); numRook = n - numRiv - numPro - numRac; }
            
            let tierPool = [];
            for(let i=0; i<numRiv; i++) tierPool.push(3);
            for(let i=0; i<numPro; i++) tierPool.push(2);
            for(let i=0; i<numRac; i++) tierPool.push(1);
            for(let i=0; i<numRook; i++) tierPool.push(0);

            tierPool.sort(() => Math.random() - 0.5);

            let usedNames = new Set();
            for(let i=0; i<n; i++) {
                let tIdx = tierPool[i] || 0;
                let tier = AI_TIERS[tIdx];
                let availableNames = tier.names.filter(n => !usedNames.has(n));
                if(availableNames.length === 0) availableNames = tier.names; 
                let name = availableNames[Math.floor(Math.random() * availableNames.length)];
                usedNames.add(name);

                opponents.push({
                    name: name,
                    tierIdx: tIdx,
                    color: AI_COLORS[i % AI_COLORS.length]
                });
            }
            if(!forceCup) renderRaceSetup();
        }

        function cycleDifficulty(index) {
            let opp = opponents[index];
            opp.tierIdx = (opp.tierIdx + 1) % AI_TIERS.length;
            let tier = AI_TIERS[opp.tierIdx];
            opp.name = tier.names[Math.floor(Math.random() * tier.names.length)];
            renderRaceSetup();
        }

        function renderRaceSetup() {
            const container = document.getElementById('opponent-grid');
            container.innerHTML = '';
            
            opponents.forEach((opp, i) => {
                let tier = AI_TIERS[opp.tierIdx];
                let badgeClass = '';
                let badgeIcon = '';
                if(tier.name==='ROOKIE') { badgeClass = 'badge-rookie'; badgeIcon = '✓'; }
                if(tier.name==='RACER') { badgeClass = 'badge-racer'; badgeIcon = '★'; }
                if(tier.name==='PRO') { badgeClass = 'badge-pro'; badgeIcon = '⚡'; }
                if(tier.name==='RIVAL') { badgeClass = 'badge-rival'; badgeIcon = '☠'; }
                
                let card = document.createElement('div');
                card.className = 'opponent-card'; 
                card.setAttribute('data-onclick', 'cycleDifficulty(' + i + ')');
                card.innerHTML = `
                    <div style="font-size: 24px; color: ${opp.color}; margin-bottom: 5px;">🚗</div>
                    <div style="font-weight: 900; font-size: 14px; margin-bottom: 5px; color: var(--text-dark);">${opp.name}</div>
                    <div class="opponent-badge ${badgeClass}">
                        ${badgeIcon} ${tier.name}
                    </div>
                `;
                container.appendChild(card);
            });
        }

        function generateMapThumbnails() {
            const container = document.getElementById('map-grid-container');
            container.innerHTML = '';
            
            mapsData.forEach((map, index) => {
                const card = document.createElement('div');
                card.className = 'map-card';
                card.setAttribute('data-onclick', 'startLoadingScreen(' + index + ')');
                card.appendChild(buildMapPreviewCanvas(map, 140, 100));
                
                const nameLabel = document.createElement('div');
                nameLabel.className = 'map-name';
                nameLabel.innerText = map.name;
                card.appendChild(nameLabel);
                
                container.appendChild(card);
            });
        }

        function generateMapsBrowser() {
            const container = document.getElementById('maps-browser-grid');
            if (!container) return;
            container.innerHTML = '';

            mapsData.forEach((map, index) => {
                const card = document.createElement('div');
                card.className = 'map-browser-card';
                if (map.isCustom) card.style.borderColor = 'var(--accent-yellow)';
                card.appendChild(buildMapPreviewCanvas(map, 220, 120));

                const nameLabel = document.createElement('div');
                nameLabel.className = 'map-name';
                nameLabel.style.fontSize = '16px';
                nameLabel.style.color = map.isCustom ? 'var(--accent-yellow)' : 'var(--text-dark)';
                nameLabel.style.marginBottom = '4px';
                nameLabel.innerText = map.name + (map.isCustom ? ' ✎' : '');
                card.appendChild(nameLabel);

                const desc = document.createElement('div');
                desc.className = 'map-browser-desc';
                desc.textContent = getMapPreviewDescription(index);
                card.appendChild(desc);

                // --- Stats row ---
                const stats = getMapStats(map);
                if (stats) {
                    const statsRow = document.createElement('div');
                    statsRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 4px;';
                    const chip = (label, val, color) => {
                        const el = document.createElement('span');
                        el.style.cssText = `display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:20px;font-size:10px;font-family:Orbitron,monospace;font-weight:700;background:rgba(0,0,0,0.15);border:1px solid ${color};color:${color};`;
                        el.textContent = label + '  ' + val;
                        return el;
                    };
                    statsRow.appendChild(chip('DIFF', stats.difficulty, stats.diffColor));
                    statsRow.appendChild(chip('LENGTH', stats.lengthM + 'm', '#7ec8e3'));
                    statsRow.appendChild(chip('CORNERS', stats.corners, '#a29bfe'));
                    statsRow.appendChild(chip('BIOME', stats.biome, '#b2bec3'));
                    card.appendChild(statsRow);
                }

                const actions = document.createElement('div');
                actions.className = 'map-browser-actions';
                let btns = `<button class="btn-neon" data-onclick="startTimeTrial(${index})">Time Trial</button>`;
                btns += `<button class="btn-neon pink" data-onclick="startDroneView(${index})">Drone View</button>`;
                if (map.isCustom) {
                    let customIdx = index - 10;
                    btns += `<button class="btn-neon" style="background:var(--accent-yellow); color:var(--text-dark); box-shadow:0 4px 0 #f57f17;" data-onclick="editorEditCustomTrack(${customIdx})">Edit</button>`;
                }
                actions.innerHTML = btns;
                card.appendChild(actions);
                container.appendChild(card);
            });

            // Add "Create New Track" card
            const newCard = document.createElement('div');
            newCard.className = 'map-browser-card';
            newCard.style.borderColor = 'var(--accent-yellow)';
            newCard.style.borderStyle = 'dashed';
            newCard.style.cursor = 'pointer';
            newCard.style.display = 'flex';
            newCard.style.flexDirection = 'column';
            newCard.style.justifyContent = 'center';
            newCard.style.alignItems = 'center';
            newCard.style.minHeight = '180px';
            newCard.setAttribute('data-onclick', 'openTrackEditor()');
            newCard.innerHTML = `
                <div style="font-size: 48px; color: var(--accent-yellow); margin-bottom: 10px;">+</div>
                <div style="font-size: 14px; color: var(--accent-yellow); font-family: 'Fredoka One', cursive; font-weight: 900;">CREATE TRACK</div>
            `;
            container.appendChild(newCard);
        }
        
        function drawLoadingMinimap(mapIndex) {
            const canvas = document.getElementById('loading-minimap');
            const ctx = canvas.getContext('2d');
            const w = canvas.width; const h = canvas.height;
            ctx.clearRect(0, 0, w, h);
            
            let map = mapsData[mapIndex];
            
            ctx.fillStyle = map.theme.bgOuter;
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 6;
            ctx.beginPath(); ctx.roundRect(0, 0, w, h, 18);
            ctx.fill(); ctx.stroke();

            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            map.waypoints.forEach(wp => {
                minX = Math.min(minX, wp.x); maxX = Math.max(maxX, wp.x);
                minY = Math.min(minY, wp.y); maxY = Math.max(maxY, wp.y);
            });
            const scale = Math.min(w / (maxX - minX || 1), h / (maxY - minY || 1)) * 0.7;
            const cx = w / 2, cy = h / 2;
            const tcx = (minX + maxX) / 2, tcy = (minY + maxY) / 2;

            const mapPt = p => ({ x: cx + (p.x - tcx) * scale, y: cy + (p.y - tcy) * scale });

            ctx.beginPath();
            let start = mapPt(map.waypoints[0]); ctx.moveTo(start.x, start.y);
            for(let i=1; i<=map.waypoints.length; i++) { 
                let p = mapPt(map.waypoints[i%map.waypoints.length]); 
                ctx.lineTo(p.x, p.y); 
            }
            ctx.strokeStyle = map.theme.track; ctx.lineWidth = 15; ctx.lineJoin = 'round'; ctx.stroke();
            ctx.strokeStyle = map.theme.border; ctx.lineWidth = 6; ctx.stroke();
        }
        
        function initKnockoutCup() {
            generateOpponents(true);
            
            let pool = [0,1,2,3,4,5,6,7,8,9];
            cupState.tracks = [];
            for(let i=0; i<4; i++) {
                let idx = Math.floor(Math.random() * pool.length);
                cupState.tracks.push(pool.splice(idx, 1)[0]);
            }
            cupState.round = 1;
            config.totalLaps = 3;
            
            startLoadingScreen(cupState.tracks[0]);
        }
        
                function startLoadingScreen(mapIndex) {
            console.log("Starting loading for map:", mapIndex);
            audio.stopMusic();
            setTimeout(() => {
                if (gameState === 'LOADING') {
                    audio.startMusic('loading');
                }
            }, 1000);
            
            gameState = 'LOADING';
            showScreen('loading-screen');
            
            // Ensure UI elements are correctly shown/hidden
            if(screens) screens.classList.remove('hidden');
            if(uiLayer) uiLayer.classList.add('hidden');
            const countdownNode = document.getElementById('countdown');
            if(countdownNode) countdownNode.style.display = 'none';
            
            initGame(mapIndex);
            
            // Populate loading screen data
            const nameEl = document.getElementById('loading-track-name');
            if(nameEl && mapsData[mapIndex]) nameEl.innerText = mapsData[mapIndex].name;
            
            const objEl = document.getElementById('loading-objective');
            if(objEl) {
                let objText = "QUICK RACE";
                if (gameMode === 'GRAND_PRIX') objText = "GRAND PRIX";
                else if (gameMode === 'TIME_TRIAL') objText = "SOLO TIME TRIAL";
                else if (gameMode === 'LOCAL_MULTIPLAYER') objText = "LOCAL BATTLE";
                else if (gameMode === 'KNOCKOUT_CUP') {
                    if(cupState.round === 1) objText = "RND 1: TOP 10";
                    else if(cupState.round === 2) objText = "RND 2: TOP 7";
                    else if(cupState.round === 3) objText = "SEMI: TOP 3";
                    else if(cupState.round === 4) objText = "FINAL ROUND";
                }
                objEl.innerText = objText;
            }

            const descList = document.getElementById('loading-track-desc-list');
            if(descList && trackDescriptions[mapIndex]) {
                let desc = trackDescriptions[mapIndex];
                let tips = desc.split('. ').filter(t => t.trim().length > 0).map(t => t.endsWith('.') ? t : t + '.');
                descList.innerHTML = tips.map(t => `<li>${t}</li>`).join('');
            }
            
            drawLoadingMinimap(mapIndex);

            let duration = 3000 + Math.random() * 2000;
            let startTimeLoad = Date.now();
            
            if(window.loadingInterval) clearInterval(window.loadingInterval);
            window.loadingInterval = setInterval(() => {
                let p = (Date.now() - startTimeLoad) / duration;
                if (p >= 1) {
                    clearInterval(window.loadingInterval);
                    startRaceIntro();
                }
            }, 50);
        }

        // Triggered after loading screen finishes
        function startRaceIntro() {
            if (gameMode === 'DEMO_MODE') {
                // Skip intro in demo mode, go straight to race
                screens.classList.add('hidden');
                document.querySelectorAll('.screen-panel').forEach(p => p.classList.add('hidden'));
                window.focus();
                keys = {};
                resetDpadVisuals();
                document.getElementById('offroad-warning').classList.add('hidden');
                startCountdown();
                return;
            }
            
            introPanDuration = 10000;
            audio.playFanfare(introPanDuration / 1000);
            
            screens.classList.add('hidden');
            document.querySelectorAll('.screen-panel').forEach(p => p.classList.add('hidden'));
            window.focus();

            keys = {};
            resetDpadVisuals();
            document.getElementById('offroad-warning').classList.add('hidden');

            introPanStartTime = Date.now();

            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            activeWaypoints.forEach(wp => {
                minX = Math.min(minX, wp.x); maxX = Math.max(maxX, wp.x);
                minY = Math.min(minY, wp.y); maxY = Math.max(maxY, wp.y);
            });

            if (!player) { console.error("Player missing in startRaceIntro"); quitToMenu(); return; }
            panEndX = player.x - canvas.width / 2;
            panEndY = player.y - canvas.height / 2;

            panStartX = maxX - canvas.width / 2 + 1000; 
            panStartY = (minY + maxY) / 2 - canvas.height / 2;

            if (Math.abs(panStartX - panEndX) < 1000) {
                panStartX = panEndX + 2000;
            }

            gameState = 'INTRO_PAN';
            
            audio.fadeOutMusic(1); // Cross-fade menu music
            
            // Set engine sound to match selected car type, then idle
            audio.setEngineProfile(carTypes[selectedCarIndex].name);
            audio.updateEngine(0, true); 
        }

        function startCountdown() {
            if (gameMode === 'DEMO_MODE') {
                // Skip countdown in demo mode, start immediately
                uiLayer.classList.remove('hidden');
                startTime = Date.now();
                playerLapStartTime = Date.now();
                gameState = 'PLAYING';
                // Keep menu music playing, don't start race music
                return;
            }
            
            gameState = 'COUNTDOWN';
            countdownEl.style.display = 'flex';
            countdownEl.className = 'count-3';
            countdownEl.innerHTML = '<span>3</span>';
            audio.beep();
            
            let count = 3;
            let countInterval = setInterval(() => {
                count--;
                if (count > 0) {
                    countdownEl.className = `count-${count}`;
                    countdownEl.innerHTML = `<span>${count}</span>`;
                    audio.beep();
                } else if (count === 0) {
                    countdownEl.className = 'count-go';
                    countdownEl.innerHTML = '<span>GO!</span>';
                    audio.goBeep();
                    audio.startMusic('race_' + currentMapIndex); 
                } else {
                    clearInterval(countInterval);
                    countdownEl.style.display = 'none';
                    uiLayer.classList.remove('hidden');
                    startTime = Date.now();
                    playerLapStartTime = Date.now(); 
                    gameState = 'PLAYING';
                }
            }, 900);
        }

        function initGame(mapIndex) {
            currentMapIndex = mapIndex;
            finishOrder = [];
            raceEndTime = null;
            spectateTarget = -1;
            activeWaypoints = [...mapsData[mapIndex].waypoints];
            // Apply Map Variants (Random chance in GP mode)
            window.mapVariant = 'NORMAL';
            if (gameMode === 'GRAND_PRIX' && Math.random() < 0.4) {
                let variants = ['REVERSE', 'NIGHT'];
                window.mapVariant = variants[Math.floor(Math.random() * variants.length)];
                if (window.mapVariant === 'REVERSE') {
                    activeWaypoints = [...activeWaypoints].reverse();
                }
            }

            rebuildTrackRenderCache();
            resetUiRenderCaches();

            generateScenery(mapIndex);
            
            puddles = [];
            if (config.weather !== 'Clear') {
                let numPuddles = 8 + Math.floor(Math.random() * 5); 
                for(let i=0; i<numPuddles; i++) {
                    let wpIdx = Math.floor(Math.random() * activeWaypoints.length);
                    let p1 = activeWaypoints[wpIdx];
                    let p2 = activeWaypoints[(wpIdx+1)%activeWaypoints.length];
                    let t = Math.random();
                    let px = p1.x + (p2.x - p1.x) * t;
                    let py = p1.y + (p2.y - p1.y) * t;
                    
                    let angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
                    let perp = angle + Math.PI/2;
                    let offset = (Math.random() - 0.5) * (config.trackWidth * 0.6);
                    px += Math.cos(perp) * offset;
                    py += Math.sin(perp) * offset;

                    puddles.push({
                        x: px, y: py,
                        rx: 30 + Math.random()*20,
                        ry: 20 + Math.random()*15,
                        angle: Math.random() * Math.PI
                    });
                }
                
                if (config.weather === 'Storm') {
                    lightningTimer = Math.random() * 600 + 600;
                    lightningFlash = 0;
                }
                audio.startRain(config.weather === 'Storm' ? 0.7 : 0.4);
            } else {
                audio.stopRain();
            }

            let pColor = playerCustomColor || carTypes[selectedCarIndex].color;

            cars = [];
            const speedometer2El = document.getElementById('speedometer2');
            const raceStats2El = document.getElementById('race-stats2');

            if (gameMode === 'LOCAL_MULTIPLAYER') {
                if (speedometer2El) speedometer2El.classList.remove('hidden');
                if (raceStats2El) raceStats2El.classList.remove('hidden');
            } else {
                if (speedometer2El) speedometer2El.classList.add('hidden');
                if (raceStats2El) raceStats2El.classList.add('hidden');
            }

            let placeCar = (index, color, isPlayer, name, tier) => {
                let row = Math.floor(index / 2);
                let col = index % 2;
                let offsetBack = 20 + row * 70;
                let offsetSide = col === 0 ? 25 : -25;
                if (row === 0 && index === 1) offsetSide = -25;
                if (row === 0 && index === 0) offsetSide = 25;

                let distRemaining = offsetBack;
                let wpIdx = 0;
                let p1 = activeWaypoints[wpIdx];
                let p2 = activeWaypoints[(wpIdx - 1 + activeWaypoints.length) % activeWaypoints.length];

                while (distRemaining > 0) {
                    let segLen = Math.sqrt(dist2(p1, p2));
                    if (distRemaining <= segLen) {
                        let t = distRemaining / segLen;
                        let cx = p1.x + (p2.x - p1.x) * t;
                        let cy = p1.y + (p2.y - p1.y) * t;

                        let dirX = (p1.x - p2.x) / segLen;
                        let dirY = (p1.y - p2.y) / segLen;
                        let normX = -dirY;
                        let normY = dirX;

                        let car = new Car(
                            cx + normX * offsetSide,
                            cy + normY * offsetSide,
                            color, isPlayer, name, tier
                        );
                        car.angle = Math.atan2(dirY, dirX);
                        cars.push(car);
                        break;
                    } else {
                        distRemaining -= segLen;
                        wpIdx = (wpIdx - 1 + activeWaypoints.length) % activeWaypoints.length;
                        p1 = activeWaypoints[wpIdx];
                        p2 = activeWaypoints[(wpIdx - 1 + activeWaypoints.length) % activeWaypoints.length];
                    }
                }
            };

            if (gameMode === 'DEMO_MODE') {
                // Demo mode: AI-only race, no player car
                generateOpponents(true);
                for(let i = 0; i < opponents.length; i++) {
                    let opp = opponents[i];
                    placeCar(i, opp.color, false, opp.name, AI_TIERS[opp.tierIdx]);
                }
                player = cars[0]; // Follow first AI car for camera
                player2 = null;
                // Keep menu music playing, don't start race music
            } else if (gameMode === 'MULTIPLAYER') {
                if (!db) {
                    alert("Multiplayer unavailable.");
                    quitToMenu();
                    return;
                }
                placeCar(0, pColor, true, playerDisplayName || 'Player 1', carTypes[selectedCarIndex].tier);
                player = cars[0]; if(gameMode === 'LOCAL_MULTIPLAYER') { player2 = cars[1]; } else { player2 = null; }
                
                if (playersUnsubscribe) playersUnsubscribe();
                const { collection, onSnapshot } = window.firebaseModular;
                playersUnsubscribe = onSnapshot(collection(db, 'sessions', multiplayerSessionId, 'players'), snapshot => {
                    if (!auth.currentUser) return;
                    snapshot.forEach(docSnap => {
                        const pData = docSnap.data();
                        if (pData.uid !== auth.currentUser.uid) {
                            let remoteCar = cars.find(c => c.uid === pData.uid);
                            if (!remoteCar) {
                                remoteCar = new Car(pData.x, pData.y, pData.color || '#ffffff', false, pData.name, {speedMult: 1, accelMult: 1, turnMult: 1}, true);
                                remoteCar.uid = pData.uid;
                                cars.push(remoteCar);
                            }
                            remoteCar.targetX = pData.x;
                            remoteCar.targetY = pData.y;
                            remoteCar.targetAngle = pData.angle;
                            remoteCar.speed = pData.speed;
                            remoteCar.lap = pData.lap;
                            remoteCar.distanceDriven = pData.distanceDriven;
                            remoteCar.finished = pData.isFinished;
                        }
                    });
                });
            } else {
                placeCar(0, pColor, true, playerDisplayName || 'Player 1', carTypes[selectedCarIndex].tier);

                if (gameMode !== 'TIME_TRIAL') {
                    for(let i = 0; i < opponents.length; i++) {
                        let opp = opponents[i];
                        placeCar(i + 1, opp.color, false, opp.name, AI_TIERS[opp.tierIdx]);
                    }
                }
                player = cars[0]; if(gameMode === 'LOCAL_MULTIPLAYER') { player2 = cars[1]; } else { player2 = null; }
            }

            camera.x = player.x - canvas.width / 2;
            camera.y = player.y - canvas.height / 2;

            startTime = Date.now();
            elapsedTime = 0;
            flyoverObj = null;
            fx.particles = [];
            fx.skidMarks = [];
            fx.ripples = [];
            puddleRippleTimer = 0;
            cameraShake = 0;
            cameraShakeX = 0;
            cameraShakeY = 0;
            
            document.getElementById('best-lap-val').textContent = playerBestLap === Infinity ? '--:--.--' : formatTime(playerBestLap);
            document.getElementById('best-lap-banner').classList.add('hidden');
            if (bestLapBannerTimeout) clearTimeout(bestLapBannerTimeout);
            
            const weatherIcon = document.getElementById('weather-icon');
            if (config.weather !== 'Clear') {
                weatherIcon.classList.remove('hidden');
            } else {
                weatherIcon.classList.add('hidden');
            }

            updateHUD();
        }

        function triggerFlyover() {
            if (flyoverObj && flyoverObj.active) return;
            flyoverObj = {
                active: true,
                startX: player.x - 4000,
                startY: player.y + 2000,
                endX: player.x + 4000,
                endY: player.y - 2000,
                progress: 0,
                angle: Math.atan2(-4000, 8000)
            };
            audio.playJetFlyover();
        }

        function renderTrackDetailOverlays(ctx, visuals) {
            function traceTrack() {
                ctx.beginPath();
                ctx.moveTo(activeWaypoints[0].x, activeWaypoints[0].y);
                for (let i = 1; i < activeWaypoints.length; i++) {
                    ctx.lineTo(activeWaypoints[i].x, activeWaypoints[i].y);
                }
                ctx.closePath();
            }

            ctx.save();
            traceTrack();
            ctx.lineWidth = Math.max(20, config.trackWidth * 0.34);
            ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            ctx.strokeStyle = visuals.racingLine;
            ctx.globalAlpha = visuals.surfaceType === 'sand' ? 0.42 : 0.58;
            ctx.setLineDash(visuals.surfaceType === 'sand' ? [140, 180] : [220, 130]);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;

            traceTrack();
            ctx.lineWidth = Math.max(8, config.trackWidth * 0.08);
            ctx.strokeStyle = hexToRgba(visuals.asphaltHighlight, 0.15);
            ctx.stroke();

            if (currentMapIndex === 2) {
                let roadPatches = [
                    { x: 520, y: 0, w: 170, h: 54, angle: 0 },
                    { x: 3000, y: 980, w: 170, h: 64, angle: Math.PI / 2 },
                    { x: 3000, y: 3560, w: 220, h: 62, angle: Math.PI / 2 },
                    { x: -420, y: 3000, w: 180, h: 54, angle: 0 },
                    { x: 4550, y: 2000, w: 200, h: 70, angle: 0 }
                ];
                roadPatches.forEach(p => {
                    ctx.save();
                    ctx.translate(p.x, p.y);
                    ctx.rotate(p.angle);
                    let patchGrad = ctx.createLinearGradient(-p.w / 2, -p.h / 2, p.w / 2, p.h / 2);
                    patchGrad.addColorStop(0, 'rgba(255,255,255,0.04)');
                    patchGrad.addColorStop(1, 'rgba(0,0,0,0.22)');
                    ctx.fillStyle = '#30353b';
                    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                    ctx.fillStyle = patchGrad;
                    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
                    ctx.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h);
                    ctx.restore();
                });

                let drains = [
                    { x: 1040, y: -88, w: 44, h: 16, angle: 0 },
                    { x: 2988, y: 520, w: 40, h: 16, angle: Math.PI / 2 },
                    { x: 5750, y: 1990, w: 44, h: 16, angle: 0 },
                    { x: 120, y: 4870, w: 44, h: 16, angle: 0 }
                ];
                drains.forEach(d => {
                    ctx.save();
                    ctx.translate(d.x, d.y);
                    ctx.rotate(d.angle);
                    ctx.fillStyle = '#474d54';
                    ctx.fillRect(-d.w / 2, -d.h / 2, d.w, d.h);
                    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
                    for (let i = -d.w / 2 + 5; i < d.w / 2 - 2; i += 6) {
                        ctx.beginPath();
                        ctx.moveTo(i, -d.h / 2 + 2);
                        ctx.lineTo(i, d.h / 2 - 2);
                        ctx.stroke();
                    }
                    ctx.restore();
                });

                let arrows = [
                    { x: 1460, y: 0, angle: 0 },
                    { x: 3000, y: 930, angle: Math.PI / 2 },
                    { x: 6000, y: 3400, angle: Math.PI / 2 },
                    { x: -1500, y: 3000, angle: Math.PI }
                ];
                arrows.forEach(a => {
                    ctx.save();
                    ctx.translate(a.x, a.y);
                    ctx.rotate(a.angle);
                    ctx.fillStyle = 'rgba(245,245,245,0.22)';
                    ctx.beginPath();
                    ctx.moveTo(-34, -18);
                    ctx.lineTo(12, -18);
                    ctx.lineTo(12, -32);
                    ctx.lineTo(44, 0);
                    ctx.lineTo(12, 32);
                    ctx.lineTo(12, 18);
                    ctx.lineTo(-34, 18);
                    ctx.closePath();
                    ctx.fill();
                    ctx.restore();
                });
            } else if (currentMapIndex === 3) {
                let sandDrifts = [
                    { x: 2200, y: 130, rx: 130, ry: 30, angle: 0.05 },
                    { x: 6200, y: 120, rx: 110, ry: 26, angle: -0.06 },
                    { x: 11500, y: 3860, rx: 150, ry: 34, angle: 0.08 },
                    { x: 120, y: 3860, rx: 120, ry: 28, angle: -0.04 },
                    { x: 12820, y: 2020, rx: 150, ry: 42, angle: Math.PI / 2 }
                ];
                sandDrifts.forEach(d => {
                    ctx.save();
                    ctx.translate(d.x, d.y);
                    ctx.rotate(d.angle);
                    let driftGrad = ctx.createLinearGradient(-d.rx, -d.ry, d.rx, d.ry);
                    driftGrad.addColorStop(0, 'rgba(248, 224, 180, 0.34)');
                    driftGrad.addColorStop(1, 'rgba(176, 124, 62, 0.08)');
                    ctx.fillStyle = driftGrad;
                    ctx.beginPath();
                    ctx.ellipse(0, 0, d.rx, d.ry, 0, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                });

                let heatStains = [
                    { x: 3000, y: 2000, rx: 160, ry: 46, angle: 0 },
                    { x: 9000, y: 2000, rx: 180, ry: 52, angle: 0 },
                    { x: 6000, y: 180, rx: 160, ry: 32, angle: 0 }
                ];
                heatStains.forEach(h => {
                    ctx.save();
                    ctx.translate(h.x, h.y);
                    ctx.rotate(h.angle);
                    let stainGrad = ctx.createRadialGradient(0, 0, 8, 0, 0, h.rx);
                    stainGrad.addColorStop(0, 'rgba(120, 82, 41, 0.2)');
                    stainGrad.addColorStop(1, 'rgba(120, 82, 41, 0)');
                    ctx.fillStyle = stainGrad;
                    ctx.beginPath();
                    ctx.ellipse(0, 0, h.rx, h.ry, 0, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                });
            } else if (currentMapIndex === 7) {
                let apronPanels = [
                    { x: 2300, y: 520, w: 1600, h: 240, angle: 0 },
                    { x: 8350, y: -220, w: 4400, h: 320, angle: 0 },
                    { x: 13750, y: 420, w: 1900, h: 260, angle: 0 },
                    { x: 9000, y: 4320, w: 5600, h: 380, angle: 0 }
                ];
                apronPanels.forEach(p => {
                    ctx.save();
                    ctx.translate(p.x, p.y);
                    ctx.rotate(p.angle);
                    let panelGrad = ctx.createLinearGradient(-p.w / 2, -p.h / 2, p.w / 2, p.h / 2);
                    panelGrad.addColorStop(0, 'rgba(255,255,255,0.08)');
                    panelGrad.addColorStop(1, 'rgba(0,0,0,0.18)');
                    ctx.fillStyle = '#88919b';
                    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                    ctx.fillStyle = panelGrad;
                    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
                    for (let i = -p.w / 2 + 80; i < p.w / 2; i += 220) {
                        ctx.beginPath();
                        ctx.moveTo(i, -p.h / 2);
                        ctx.lineTo(i, p.h / 2);
                        ctx.stroke();
                    }
                    ctx.restore();
                });

                let taxiGuides = [
                    { x1: 550, y1: 0, x2: 5750, y2: 0 },
                    { x1: 7220, y1: -2000, x2: 10780, y2: -2000 },
                    { x1: 12400, y1: 0, x2: 15850, y2: 0 },
                    { x1: 350, y1: 4000, x2: 15700, y2: 4000 }
                ];
                ctx.strokeStyle = 'rgba(244, 227, 162, 0.32)';
                ctx.lineWidth = 4;
                ctx.setLineDash([44, 26]);
                taxiGuides.forEach(g => {
                    ctx.beginPath();
                    ctx.moveTo(g.x1, g.y1);
                    ctx.lineTo(g.x2, g.y2);
                    ctx.stroke();
                });
                ctx.setLineDash([]);

                let gateMarks = [
                    { x: 6970, y: -700, w: 220, h: 38 },
                    { x: 7510, y: -700, w: 220, h: 38 },
                    { x: 8050, y: -700, w: 220, h: 38 },
                    { x: 8590, y: -700, w: 220, h: 38 },
                    { x: 9130, y: -700, w: 220, h: 38 },
                    { x: 9670, y: -700, w: 220, h: 38 },
                    { x: 10210, y: -700, w: 220, h: 38 }
                ];
                gateMarks.forEach(g => {
                    ctx.save();
                    ctx.translate(g.x, g.y);
                    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
                    ctx.lineWidth = 3;
                    ctx.strokeRect(-g.w / 2, -g.h / 2, g.w, g.h);
                    ctx.restore();
                });

                let rubberZones = [
                    { x: 3000, y: 0, rx: 760, ry: 70 },
                    { x: 14000, y: 0, rx: 840, ry: 78 },
                    { x: 3000, y: 2400, rx: 760, ry: 70 },
                    { x: 14000, y: 2400, rx: 840, ry: 78 }
                ];
                rubberZones.forEach(r => {
                    ctx.save();
                    ctx.translate(r.x, r.y);
                    let rubberGrad = ctx.createRadialGradient(0, 0, 10, 0, 0, r.rx);
                    rubberGrad.addColorStop(0, 'rgba(40,40,40,0.2)');
                    rubberGrad.addColorStop(1, 'rgba(40,40,40,0)');
                    ctx.fillStyle = rubberGrad;
                    ctx.beginPath();
                    ctx.ellipse(0, 0, r.rx, r.ry, 0, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                });
            }
            ctx.restore();
        }

        function drawTrack() {
            if (!activeWaypoints || activeWaypoints.length === 0) return;
            ensureTrackRenderCache();
            let map = mapsData[currentMapIndex];
            let t = map.theme;
            let visuals = getTrackVisuals(t);
            let wetTrack = config.weather !== 'Clear';
            let shoulderDustTone = t.shoulderDust || adjustHexColor(visuals.shoulderColor || '#666666', 18);
            let trackPath = trackPathCache.path;

            if (!trackPath) return;

            // Background Outer
            ctx.fillStyle = (typeof window.mapVariant !== 'undefined' && window.mapVariant === 'NIGHT') ? '#050510' : t.bgOuter;
            // Background is now handled by viewport renderer or global clear

            ctx.save();
            ctx.translate(-(camera.x + cameraShakeX), -(camera.y + cameraShakeY));

            // Draw Background Inner
            if (t.bgInner) {
                ctx.fillStyle = t.bgInner;
                ctx.fill(trackPath);
            }

            // Draw Environment Scenery
            renderScenery(ctx);

            ctx.lineWidth = config.trackWidth + 72;
            ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            ctx.strokeStyle = visuals.shoulderPattern;
            ctx.stroke(trackPath);

            ctx.lineWidth = config.trackWidth + 58;
            ctx.strokeStyle = hexToRgba(visuals.shoulderColor, 0.55);
            ctx.stroke(trackPath);

            ctx.lineWidth = config.trackWidth + 86;
            ctx.globalAlpha = visuals.surfaceType === 'sand' ? 0.4 : 0.24;
            ctx.strokeStyle = hexToRgba(shoulderDustTone, visuals.surfaceType === 'sand' ? 0.3 : 0.18);
            ctx.setLineDash(visuals.surfaceType === 'sand' ? [32, 38] : [12, 30]);
            ctx.stroke(trackPath);
            ctx.setLineDash([]);
            ctx.globalAlpha = 1;

            // 1. Base Track Border
            ctx.lineWidth = config.trackWidth + 22;
            ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            if (t.borderStyle === 'neon') {
                ctx.strokeStyle = t.border;
                ctx.shadowColor = t.border; ctx.shadowBlur = 20;
                ctx.stroke(trackPath);
                ctx.shadowBlur = 0;
            } else {
                ctx.strokeStyle = t.border; ctx.stroke(trackPath);
            }

            // 2. Inner Barrier Lines
            if (t.barrierColor) {
                ctx.lineWidth = config.trackWidth + 6;
                ctx.lineJoin = 'round'; ctx.lineCap = 'round'; 
                ctx.strokeStyle = hexToRgba(t.barrierColor, t.borderStyle === 'neon' ? 0.75 : 0.82);
                if (t.barrierDash) ctx.setLineDash(t.barrierDash);
                ctx.stroke(trackPath);
                ctx.setLineDash([]);
            }

            // 3. Track Surface
            let roadGradient = ctx.createLinearGradient(-Math.cos(visuals.sunAngle) * 9000, -Math.sin(visuals.sunAngle) * 9000, Math.cos(visuals.sunAngle) * 9000, Math.sin(visuals.sunAngle) * 9000);
            roadGradient.addColorStop(0, adjustHexColor(t.track, 24));
            roadGradient.addColorStop(0.48, t.track);
            roadGradient.addColorStop(1, adjustHexColor(t.track, -28));

            ctx.lineWidth = config.trackWidth - 8;
            ctx.lineJoin = 'round'; ctx.lineCap = 'round'; 
            ctx.strokeStyle = visuals.roadEdgeColor;
            ctx.stroke(trackPath);

            ctx.lineWidth = config.trackWidth - 18;
            ctx.strokeStyle = roadGradient;
            ctx.stroke(trackPath);

            ctx.lineWidth = config.trackWidth - 24;
            ctx.globalAlpha = 0.45;
            ctx.strokeStyle = visuals.surfacePattern;
            ctx.stroke(trackPath);
            ctx.globalAlpha = 1;

            ctx.lineWidth = Math.max(18, config.trackWidth - 46);
            ctx.globalCompositeOperation = 'screen';
            ctx.strokeStyle = hexToRgba(visuals.asphaltHighlight, wetTrack ? 0.18 : 0.08);
            ctx.stroke(trackPath);
            ctx.globalCompositeOperation = 'source-over';

            ctx.lineWidth = Math.max(16, config.trackWidth * 0.2);
            ctx.strokeStyle = hexToRgba(adjustHexColor(t.track, -42), wetTrack ? 0.16 : 0.1);
            ctx.setLineDash([24, 58]);
            ctx.stroke(trackPath);
            ctx.setLineDash([]);

            if (wetTrack) {
                ctx.lineWidth = Math.max(18, config.trackWidth * 0.3);
                ctx.globalCompositeOperation = 'screen';
                ctx.strokeStyle = 'rgba(210,230,255,0.12)';
                ctx.stroke(trackPath);
                ctx.globalCompositeOperation = 'source-over';
            }

            ctx.lineWidth = Math.max(22, config.trackWidth - 64);
            ctx.strokeStyle = hexToRgba(visuals.asphaltHighlight, 0.12);
            ctx.stroke(trackPath);

            renderTrackDetailOverlays(ctx, visuals);

            let atmosphereGradient = ctx.createLinearGradient(camera.x - canvas.width * 0.25, camera.y, camera.x + canvas.width, camera.y + canvas.height * 0.9);
            atmosphereGradient.addColorStop(0, hexToRgba(adjustHexColor(t.bgOuter || '#777777', 24), 0.07));
            atmosphereGradient.addColorStop(0.55, 'rgba(255,255,255,0)');
            atmosphereGradient.addColorStop(1, visuals.fogColor);
            ctx.fillStyle = atmosphereGradient;
            ctx.fillRect(camera.x - 250, camera.y - 250, canvas.width + 500, canvas.height + 500);

            // Track Center Line
            ctx.lineWidth = 2.5;
            if (t.line === 'yellow_dash') { ctx.strokeStyle = hexToRgba(visuals.laneColor, 0.82); ctx.setLineDash([30, 30]); }
            else if (t.line === 'white_dash') { ctx.strokeStyle = hexToRgba(visuals.laneColor, 0.82); ctx.setLineDash([30, 30]); }
            else if (t.line === 'neon') { ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.setLineDash([20, 20]); }
            else { ctx.strokeStyle = hexToRgba(visuals.laneColor, 0.28); ctx.setLineDash([]); }
            ctx.stroke(trackPath);
            ctx.setLineDash([]);

            // Draw Start/Finish Line
            ctx.save();
            let startLineAngle = Math.atan2(activeWaypoints[1].y - activeWaypoints[0].y, activeWaypoints[1].x - activeWaypoints[0].x);
            
            // Draw Map Features (Boosts, Ramps, Oil)
            if (map.features) {
                map.features.forEach(f => {
                    ctx.save();
                    ctx.translate(f.x, f.y);
                    ctx.rotate(f.angle !== undefined ? f.angle : 0);
                    if (f.type === 'boost') {
                        ctx.fillStyle = '#ff00ea';
                        ctx.beginPath(); ctx.moveTo(-40, -40); ctx.lineTo(40, 0); ctx.lineTo(-40, 40); ctx.fill();
                        ctx.fillStyle = '#00f3ff';
                        ctx.beginPath(); ctx.moveTo(-60, -40); ctx.lineTo(20, 0); ctx.lineTo(-60, 40); ctx.fill();
                    } else if (f.type === 'ramp') {
                        ctx.fillStyle = '#ff9900';
                        ctx.fillRect(-50, -60, 100, 120);
                        ctx.fillStyle = '#ffff00';
                        ctx.fillRect(-30, -60, 60, 120);
                        ctx.fillStyle = '#111';
                        ctx.beginPath(); ctx.moveTo(-20, 40); ctx.lineTo(20, 40); ctx.lineTo(0, -40); ctx.fill(); // arrow
                    } else if (f.type === 'oil') {
                        ctx.fillStyle = '#111';
                        ctx.beginPath(); ctx.arc(0, 0, 60, 0, Math.PI*2); ctx.fill();
                        ctx.beginPath(); ctx.arc(30, 20, 40, 0, Math.PI*2); ctx.fill();
                        ctx.beginPath(); ctx.arc(-20, -30, 50, 0, Math.PI*2); ctx.fill();
                    } else if (f.type === 'airport_doors') {
                        ctx.fillStyle = '#54606d';
                        ctx.fillRect(-140, -90, 280, 180);
                        ctx.fillStyle = '#89c7ff';
                        ctx.fillRect(-124, -74, 248, 148);
                        ctx.fillStyle = 'rgba(255,255,255,0.16)';
                        ctx.fillRect(-124, -74, 248, 24);
                        ctx.strokeStyle = '#d9e5f3';
                        ctx.lineWidth = 4;
                        ctx.beginPath(); ctx.moveTo(0, -74); ctx.lineTo(0, 74); ctx.stroke();
                    }
                    ctx.restore();
                });
            }
            ctx.translate(activeWaypoints[0].x, activeWaypoints[0].y);
            ctx.rotate(startLineAngle);
            
            if (t.specialStart === 'hold_short') {
                ctx.fillStyle = '#FFD700';
                for(let w = -100; w < 100; w+=15) ctx.fillRect(-10, w, 20, 10);
            } else {
                let squareSize = 20;
                let widthSteps = Math.floor(config.trackWidth / squareSize);
                for (let w = -widthSteps/2; w < widthSteps/2; w++) {
                    for(let h = -1; h <= 1; h++) {
                        if ((w + h) % 2 === 0) {
                            ctx.fillStyle = '#ffffff';
                            ctx.fillRect(h * squareSize, w * squareSize, squareSize, squareSize);
                        }
                    }
                }
            }
            ctx.restore();

            // Puddles
            if (config.weather !== 'Clear' && puddles) {
                puddles.forEach(p => {
                    ctx.save();
                    ctx.translate(p.x, p.y);
                    ctx.rotate(p.angle);
                    let puddleGrad = ctx.createRadialGradient(-p.rx * 0.28, -p.ry * 0.34, 4, 0, 0, Math.max(p.rx, p.ry));
                    puddleGrad.addColorStop(0, 'rgba(200, 230, 255, 0.38)');
                    puddleGrad.addColorStop(0.45, 'rgba(70, 120, 170, 0.34)');
                    puddleGrad.addColorStop(1, 'rgba(18, 40, 70, 0.54)');
                    ctx.fillStyle = puddleGrad;
                    ctx.beginPath();
                    ctx.ellipse(0, 0, p.rx, p.ry, 0, 0, Math.PI*2);
                    ctx.fill();
                    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.ellipse(-p.rx * 0.06, -p.ry * 0.08, p.rx * 0.82, p.ry * 0.74, 0, 0, Math.PI*2);
                    ctx.stroke();
                    ctx.restore();
                });
                
                if (gameState === 'PLAYING') {
                    puddleRippleTimer--;
                    if(puddleRippleTimer <= 0) {
                        puddleRippleTimer = config.fps * 0.5;
                        puddles.forEach(p => {
                            fx.addRipple(p.x, p.y);
                        });
                    }
                }
                fx.drawRipples(ctx);
            }

            // Draw Skid Marks
            fx.drawSkidMarks(ctx);

            // Draw Particles (Smoke / Dust)
            fx.drawParticles(ctx);

            // Draw Car Shadows FIRST
            let sortedCars = [...cars].sort((a,b)=>a.y - b.y);
            coins.forEach(c => c.draw(ctx)); lightningStrikes.forEach(l => l.draw(ctx)); movingHazards.forEach(h => h.draw(ctx)); zoneHazards.forEach(z => z.draw(ctx));
            itemBoxes.forEach(b => b.draw(ctx)); projectiles.forEach(p => p.draw(ctx)); traps.forEach(t => t.draw(ctx));
            sortedCars.forEach(car => car.drawShadow(ctx));
            
            // Draw Car Bodies
            sortedCars.forEach(car => car.draw(ctx));

            // Draw Airplane Flyover Overlay
            if (flyoverObj && flyoverObj.active) {
                flyoverObj.progress += 1000 / config.fps / 3500; 
                if (flyoverObj.progress > 1) flyoverObj.active = false;
                
                let cx = flyoverObj.startX + (flyoverObj.endX - flyoverObj.startX) * flyoverObj.progress;
                let cy = flyoverObj.startY + (flyoverObj.endY - flyoverObj.startY) * flyoverObj.progress;

                ctx.save();
                ctx.translate(cx, cy);
                
                let dx = flyoverObj.endX - flyoverObj.startX;
                let dy = flyoverObj.endY - flyoverObj.startY;
                let travelAngle = Math.atan2(dy, dx);
                
                ctx.rotate(travelAngle + Math.PI / 2); 
                ctx.scale(4, 4); 
                
                ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
                ctx.shadowColor = 'rgba(0,0,0,0.5)';
                ctx.shadowBlur = 40;

                ctx.beginPath();
                ctx.roundRect(-25, -120, 50, 240, 25);
                ctx.moveTo(-25, -20); ctx.lineTo(-140, 40); ctx.lineTo(-140, 70); ctx.lineTo(-25, 40); 
                ctx.moveTo(25, -20); ctx.lineTo(140, 40); ctx.lineTo(140, 70); ctx.lineTo(25, 40);     
                ctx.moveTo(-10, 90); ctx.lineTo(-50, 130); ctx.lineTo(50, 130); ctx.lineTo(10, 90);    
                ctx.fill();

                ctx.restore();
            }

            // --- SPECIAL FOREGROUND SCENERY (Terminal Bridge for Map 7) ---
            if (currentMapIndex === 7) {
                ctx.save();
                ctx.fillStyle = '#444';
                ctx.shadowColor = 'rgba(0,0,0,0.8)';
                ctx.shadowBlur = 50;
                
                ctx.fillRect(2300, 700, 500, 600);
                ctx.shadowBlur = 0;
                
                ctx.fillStyle = '#fbc531';
                ctx.fillRect(2300, 720, 500, 10);
                ctx.fillRect(2300, 1270, 500, 10);
                
                ctx.fillStyle = '#222';
                ctx.fillRect(2320, 740, 460, 520); 
                
                ctx.fillStyle = '#fff';
                ctx.setLineDash([20, 20]);
                ctx.beginPath();
                ctx.moveTo(2550, 740);
                ctx.lineTo(2550, 1260);
                ctx.lineWidth = 4;
                ctx.stroke();
                
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 32px "Orbitron"';
                ctx.textAlign = 'center';
                ctx.fillText("SKY HARBOR TERMINAL BRIDGE", 2550, 1000);
                
                ctx.restore();
            }

            ctx.restore();

            // Screen-space overlay for Nitro Edge Blur
            if (player && player.nitroActive && gameState === 'PLAYING') {
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                let cx = canvas.width / 2;
                let cy = canvas.height / 2;
                let maxRadius = Math.max(cx, cy) * 1.5;
                let gradient = ctx.createRadialGradient(cx, cy, maxRadius * 0.4, cx, cy, maxRadius);
                gradient.addColorStop(0, 'rgba(0, 243, 255, 0)');
                gradient.addColorStop(1, 'rgba(0, 243, 255, 0.25)');
                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.restore();
            }
        }

        function drawMinimap() {
            if (!showMinimap) return;
            if (gameState === 'MENU' || gameState === 'MAP_SELECT' || gameState === 'CAR_SELECT' || gameState === 'RACE_SETUP') return;
            
            // Open world minimap — colour-coded regions, highways, labels
            if (gameState === 'OPEN_WORLD') {
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);

                const mmSize = 190;
                const mmPad  = 16;
                const mmX = canvas.width  - mmSize - mmPad;
                const mmY = mmPad; // TOP-right, away from speedometer at bottom-right

                // Clip to rounded map area
                ctx.beginPath();
                ctx.roundRect(mmX, mmY, mmSize, mmSize, 10);
                ctx.clip();

                // Background
                ctx.fillStyle = 'rgba(8,10,16,0.88)';
                ctx.fillRect(mmX, mmY, mmSize, mmSize);

                // Calculate world bounds
                let allPoints = [];
                openWorldData.regions.forEach(r => allPoints.push(r.position));
                openWorldData.highways.forEach(h => h.waypoints.forEach(wp => allPoints.push(wp)));
                const rawMinX = Math.min(...allPoints.map(p => p.x));
                const rawMaxX = Math.max(...allPoints.map(p => p.x));
                const rawMinY = Math.min(...allPoints.map(p => p.y));
                const rawMaxY = Math.max(...allPoints.map(p => p.y));
                const wPad = 12000;
                const worldW = rawMaxX - rawMinX + wPad * 2;
                const worldH = rawMaxY - rawMinY + wPad * 2;
                const mmScale = (mmSize - 8) / Math.max(worldW, worldH);
                const wCX = rawMinX - wPad + worldW / 2;
                const wCY = rawMinY - wPad + worldH / 2;

                const toMM = (wx, wy) => ({
                    x: mmX + mmSize / 2 + (wx - wCX) * mmScale,
                    y: mmY + mmSize / 2 + (wy - wCY) * mmScale
                });

                // Draw region blobs (colour coded)
                openWorldData.regions.forEach(r => {
                    const {x, y} = toMM(r.position.x, r.position.y);
                    const isCurrent = openWorldMode.currentRegion === r.id;
                    const blobR = 12 * mmScale * 18000; // 18000 world units
                    const gradR = ctx.createRadialGradient(x, y, 0, x, y, blobR);
                    gradR.addColorStop(0, hexToRgba(r.mmColor || '#888888', isCurrent ? 0.7 : 0.35));
                    gradR.addColorStop(1, hexToRgba(r.mmColor || '#888888', 0));
                    ctx.fillStyle = gradR;
                    ctx.beginPath();
                    ctx.arc(x, y, blobR, 0, Math.PI * 2);
                    ctx.fill();
                });

                // Draw highways
                openWorldData.highways.forEach(h => {
                    ctx.strokeStyle = hexToRgba(h.lineColor || '#aaaaaa', 0.6);
                    ctx.lineWidth = 1.5;
                    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
                    ctx.beginPath();
                    h.waypoints.forEach((wp, i) => {
                        const {x, y} = toMM(wp.x, wp.y);
                        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                    });
                    ctx.stroke();
                });

                // Draw region dots + labels
                openWorldData.regions.forEach(r => {
                    const {x, y} = toMM(r.position.x, r.position.y);
                    const isCurrent = openWorldMode.currentRegion === r.id;
                    // Dot
                    ctx.fillStyle = r.mmColor || '#ffffff';
                    ctx.beginPath();
                    ctx.arc(x, y, isCurrent ? 5 : 3, 0, Math.PI * 2);
                    ctx.fill();
                    if (isCurrent) {
                        ctx.strokeStyle = '#ffffff';
                        ctx.lineWidth = 1.5;
                        ctx.stroke();
                    }
                    // Label
                    ctx.font = `${isCurrent ? 'bold ' : ''}7px Orbitron, monospace`;
                    ctx.fillStyle = isCurrent ? '#ffffff' : hexToRgba(r.mmColor || '#fff', 0.65);
                    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
                    ctx.fillText(r.biomeLabel || r.name.split(' ')[0].toUpperCase(), x, y + 6);
                });

                // Player dot
                if (player) {
                    const {x: px, y: py} = toMM(player.x, player.y);
                    // Pulsing ring
                    const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.006);
                    ctx.strokeStyle = `rgba(255,255,80,${0.5 * pulse})`;
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(px, py, 7 + pulse * 3, 0, Math.PI * 2);
                    ctx.stroke();
                    // Player arrow
                    ctx.save();
                    ctx.translate(px, py);
                    ctx.rotate(player.angle + Math.PI / 2);
                    ctx.fillStyle = '#ffff50';
                    ctx.beginPath();
                    ctx.moveTo(0, -6); ctx.lineTo(4, 4); ctx.lineTo(0, 2); ctx.lineTo(-4, 4);
                    ctx.closePath(); ctx.fill();
                    ctx.restore();
                }

                // Border ring
                ctx.restore();
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.strokeStyle = 'rgba(255,255,255,0.25)';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.roundRect(mmX, mmY, mmSize, mmSize, 10);
                ctx.stroke();
                // Title
                ctx.font = 'bold 8px Orbitron, monospace';
                ctx.fillStyle = 'rgba(255,255,255,0.4)';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'bottom';
                ctx.fillText('WORLD MAP', mmX + mmSize - 5, mmY + mmSize - 3);

                ctx.restore();
                return;
            }
            
            // Regular race minimap
            let map = mapsData[currentMapIndex];
            let cache = ensureMinimapCache();

            if (!map || !cache) return;

            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            
            ctx.fillStyle = map.theme.bgOuter;
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.roundRect(cache.xOffset, cache.yOffset, cache.size, cache.size, 8);
            ctx.fill(); ctx.stroke();

            ctx.strokeStyle = map.theme.track; ctx.lineWidth = 4; ctx.stroke(cache.path);

            cars.forEach(car => {
                let p = {
                    x: cache.xOffset + cache.size / 2 + (car.x - cache.centerX) * cache.scale,
                    y: cache.yOffset + cache.size / 2 + (car.y - cache.centerY) * cache.scale
                };
                ctx.fillStyle = car.color;
                ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
            });
            ctx.restore();
        }

        function drawWeatherOverlay() {
            let rainStrength = 0;
            if (config.weather === 'Rain') rainStrength = 0.7;
            else if (config.weather === 'Storm') rainStrength = 0.95;
            else if (config.weather === 'Hurricane') rainStrength = 1.15;

            if (rainStrength <= 0 && lightningFlash <= 0) return;

            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);

            if (rainStrength > 0) {
                let time = Date.now() * 0.001;
                let streakCount = Math.min(180, Math.ceil((canvas.width + canvas.height) * 0.05 * rainStrength));
                let dropLen = 18 + rainStrength * 14;
                let slantX = -(dropLen * (0.45 + rainStrength * 0.12));
                let fallSpeed = 620 + rainStrength * 420;
                let driftSpeed = (slantX / Math.max(dropLen, 1)) * fallSpeed;
                let spanX = canvas.width + Math.abs(slantX) + 180;
                let spanY = canvas.height + dropLen + 220;
                let offsetX = Math.abs(slantX) + 90;
                let offsetY = dropLen + 110;
                ctx.strokeStyle = `rgba(190, 220, 255, ${0.2 + rainStrength * 0.14})`;
                ctx.lineWidth = 1 + rainStrength;
                ctx.lineCap = 'round';

                for (let i = 0; i < streakCount; i++) {
                    let seed = i * 97.531;
                    let speedScale = 0.82 + ((i % 7) / 6) * 0.36;
                    let baseX = seed * 53.17 + (i % 5) * 31.7;
                    let baseY = seed * 29.61 + (i % 9) * 19.4;
                    let x = ((((baseX + time * driftSpeed * speedScale) % spanX) + spanX) % spanX) - offsetX;
                    let y = ((((baseY + time * fallSpeed * speedScale) % spanY) + spanY) % spanY) - offsetY;
                    ctx.beginPath();
                    ctx.moveTo(x, y);
                    ctx.lineTo(x + slantX, y + dropLen);
                    ctx.stroke();
                }

                ctx.fillStyle = `rgba(120, 150, 190, ${0.025 + rainStrength * 0.03})`;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }

            if (lightningFlash > 0) {
                ctx.fillStyle = `rgba(255, 255, 255, ${lightningFlash * 0.22})`;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                lightningFlash *= 0.88;
                if (lightningFlash < 0.02) lightningFlash = 0;
            }

            ctx.restore();
        }

        
        function updateItems() {
            coins.forEach(c => {
                c.update();
                cars.forEach(car => {
                    if (c.active && !car.isRemote && dist2(car, c) < 900) {
                        c.active = false;
                        if (car.isPlayer && ((car === player && raceCoins < 10) || (car === player2 && raceCoins2 < 10))) {
                            if (car === player) { raceCoins++; playerCoins++; }
                            else { raceCoins2++; playerCoins++; }
                            localStorage.setItem('webRacers_coins', playerCoins);
                            let coinEl = document.getElementById('coin-val');
                            if(coinEl) coinEl.innerText = raceCoins;
                            audio.playSynth('piano', 84, Tone.now(), 0.1, 0.4);
                            audio.playSynth('piano', 88, Tone.now()+0.1, 0.2, 0.4);
                        }
                    }
                });
            });
            
                if (config.weather === 'Storm' && Math.random() < 0.005) {
                    let wp = activeWaypoints[Math.floor(Math.random() * activeWaypoints.length)];
                    lightningStrikes.push(new LightningStrike(wp.x + (Math.random()-0.5)*400, wp.y + (Math.random()-0.5)*400));
                    lightningFlash = 1;
                    audio.playThunder();
                }
                lightningStrikes.forEach(l => l.update());
                lightningStrikes = lightningStrikes.filter(l => l.life > 0);
                movingHazards.forEach(h => h.update()); zoneHazards.forEach(z => z.update());
            itemBoxes.forEach(b => b.update());
            projectiles.forEach(p => p.update());
            projectiles = projectiles.filter(p => p.life > 0);
            traps.forEach(t => t.update());
            traps = traps.filter(t => t.life > 0);

            cars.forEach(car => {
                if (car.itemRouletteTimer > 0) {
                    car.itemRouletteTimer--;
                    if (car.itemRouletteTimer <= 0) {
                        let pos = racePositions.indexOf(car) + 1;
                        let pool = ['Missile', 'Laser', 'Mine', 'Shield'];
                        if (pos === 1) pool = ['Mine', 'Mine', 'Mine', 'Shield', 'Laser']; 
                        else if (pos >= 2 && pos <= 4) pool = ['Missile', 'Laser', 'Mine', 'Shield'];
                        else if (pos > 4) pool = ['Missile', 'Missile', 'Laser', 'Laser', 'Shield'];
                        car.item = pool[Math.floor(Math.random() * pool.length)];
                        if (car.isPlayer) audio.beep();
                    }
                }
                if (car.shieldTimer > 0) car.shieldTimer--;

                if (!car.item && car.itemRouletteTimer <= 0) {
                    itemBoxes.forEach(b => {
                        if (b.active && dist2(car, b) < 2500) {
                            b.active = false; b.respawnTimer = 300; car.itemRouletteTimer = 60;
                            if (car.isPlayer) audio.playSynth('trumpet', 80, Tone.now(), 0.1, 0.4);
                        }
                    });
                }
            });
        }
        function updateHUD() {
            if ((gameState === 'PLAYING' || gameState === 'FINISHED') && player) {
                let displaySpeed = Math.abs(Math.round(player.speed * 12)); 
                if (hudRenderCache.speed !== displaySpeed) {
                    speedVal.textContent = displaySpeed;
                    hudRenderCache.speed = displaySpeed;
                }

                if (gameState === 'PLAYING') elapsedTime = Date.now() - startTime;
                let timeText = formatTime(elapsedTime);
                if (hudRenderCache.time !== timeText) {
                    timeVal.textContent = timeText;
                    hudRenderCache.time = timeText;
                }

                let displayLap = Math.min(player.lap + 1, config.totalLaps);
                let lapText = `${displayLap} / ${config.totalLaps}`;
                if (hudRenderCache.lap !== lapText) {
                    lapVal.textContent = lapText;
                    hudRenderCache.lap = lapText;
                }

                racePositions = [...cars].sort((a, b) => {
                    let aFinish = finishOrder.indexOf(a);
                    let bFinish = finishOrder.indexOf(b);
                    if (aFinish !== -1 && bFinish !== -1) return aFinish - bFinish;
                    if (aFinish !== -1) return -1;
                    if (bFinish !== -1) return 1;
                    if (a.lap !== b.lap) return b.lap - a.lap;
                    return b.distanceDriven - a.distanceDriven;
                });
                
                let playerIndex = racePositions.findIndex(c => c.isPlayer);
                let suffixes = ["1st", "2nd", "3rd"];
                let posText = suffixes[playerIndex] || (playerIndex + 1) + "th";
                let posColor = playerIndex === 0 ? "var(--accent-yellow)" : "var(--text-dark)";
                if (hudRenderCache.posText !== posText) {
                    posVal.textContent = posText;
                    hudRenderCache.posText = posText;
                }
                if (hudRenderCache.posColor !== posColor) {
                    posVal.style.color = posColor;
                    hudRenderCache.posColor = posColor;
                }
                
                let posListEl = document.getElementById('position-list');
                let positionSignature = racePositions.map(c => `${c.isPlayer ? 'YOU' : c.id}:${finishOrder.indexOf(c) !== -1 ? 1 : 0}:${spectateTarget !== -1 && cars[spectateTarget] === c ? 1 : 0}`).join('|');
                if (hudRenderCache.positionSignature !== positionSignature) {
                    posListEl.innerHTML = racePositions.map((c, i) => {
                        let pClass = c.isPlayer ? 'pos-you' : (c.tier && c.tier.name === 'RIVAL' ? 'pos-rival' : 'pos-normal');
                        let name = c.isPlayer ? 'YOU' : c.id;
                        if (spectateTarget !== -1 && cars[spectateTarget] === c) name += ' (SPECTATING)';
                        let flag = (finishOrder.indexOf(c) !== -1) ? ' 🏁' : '';
                        return `<div class="pos-item ${pClass}">${i+1}. ${name}${flag}</div>`;
                    }).join('');
                    hudRenderCache.positionSignature = positionSignature;
                }

                const offroadWarning = document.getElementById('offroad-warning');
                if (hudRenderCache.offroad !== player.isOffRoad) {
                    offroadWarning.classList.toggle('hidden', !player.isOffRoad);
                    hudRenderCache.offroad = player.isOffRoad;
                }

                const timerDiv = document.getElementById('race-end-timer');
                let timerVisible = !!(raceEndTime && gameState === 'PLAYING');
                if (hudRenderCache.raceEndVisible !== timerVisible) {
                    timerDiv.classList.toggle('hidden', !timerVisible);
                    hudRenderCache.raceEndVisible = timerVisible;
                }
                if (timerVisible) {
                    let timeLeft = Math.max(0, Math.ceil((raceEndTime - Date.now()) / 1000));
                    if (hudRenderCache.raceEndSeconds !== timeLeft) {
                        document.getElementById('race-end-time-val').textContent = timeLeft;
                        hudRenderCache.raceEndSeconds = timeLeft;
                    }
                } else {
                    hudRenderCache.raceEndSeconds = null;
                }

                // Update Nitro UI
                const nitroFill = document.getElementById('nitro-bar-fill');
                let nitroWidth = player.nitro + '%';
                let nitroClass = player.nitroActive ? 'active-glow' : (player.nitro < 25 ? 'low' : '');
                if (hudRenderCache.nitroWidth !== nitroWidth) {
                    nitroFill.style.width = nitroWidth;
                    hudRenderCache.nitroWidth = nitroWidth;
                }
                if (hudRenderCache.nitroClass !== nitroClass) {
                    nitroFill.className = nitroClass;
                    hudRenderCache.nitroClass = nitroClass;
                }
            }
        }

        function buildPodium() {
            const container = document.getElementById('podium-container');
            container.innerHTML = '';
            const visualOrder = [1, 0, 2]; 
            visualOrder.forEach(pos => {
                if(!racePositions[pos]) return;
                const car = racePositions[pos];
                const step = document.createElement('div');
                step.className = `podium-step podium-${pos+1}`;
                step.innerHTML = `${pos+1}<div class="car-name" style="color:${car.color}">${car.id}</div>`;
                container.appendChild(step);
            });
        }
        
        function showEliminationScreen(advanced, eliminated, playerAdvanced, finalPos) {
            gameState = 'ELIMINATION';
            showScreen('elimination-screen');
            
            document.getElementById('elim-title').innerText = cupState.round === 4 ? "CUP RESULTS" : `ROUND ${cupState.round} RESULTS`;
            
            let advHtml = advanced.map((c, i) => `<div class="elim-item ${c.isPlayer ? 'pos-you' : 'pos-adv'}">${i+1}. ${c.isPlayer ? 'YOU' : c.id}</div>`).join('');
            let elimHtml = eliminated.map((c, i) => `<div class="elim-item ${c.isPlayer ? 'pos-you' : 'pos-elim'}">${i+1+advanced.length}. ${c.isPlayer ? 'YOU' : c.id} ❌</div>`).join('');
            
            document.getElementById('elim-advanced-list').innerHTML = advHtml;
            document.getElementById('elim-eliminated-list').innerHTML = elimHtml;
            
            let msgBox = document.getElementById('elim-message');
            let nextBtn = document.getElementById('elim-next-btn');
            nextBtn.classList.add('hidden');
            
            if (cupState.round === 4) {
                if (playerAdvanced) {
                    msgBox.innerHTML = "<span style='color: var(--neon-green); font-size: 32px;'>🏆 CUP CHAMPION! 🏆</span>";
                    nextBtn.innerText = "Claim Trophy";
                    nextBtn.setAttribute('data-onclick', 'claimTrophy()');
                    nextBtn.classList.remove('hidden');
                } else {
                    msgBox.innerHTML = `<span style='color: var(--neon-pink);'>ELIMINATED - FINISHED ${finalPos+1}</span>`;
                    nextBtn.innerText = "Main Menu";
                    nextBtn.setAttribute('data-onclick', 'quitToMenu()');
                    nextBtn.classList.remove('hidden');
                }
            } else {
                if (playerAdvanced) {
                    msgBox.innerHTML = "<span style='color: var(--neon-green);'>QUALIFIED! ADVANCING TO NEXT ROUND...</span>";
                    setTimeout(() => {
                        if (gameState === 'ELIMINATION') {
                            cupState.round++;
                            opponents = advanced.filter(c => !c.isPlayer).map(c => ({
                                name: c.id,
                                tierIdx: AI_TIERS.findIndex(t => t.name === c.tier.name),
                                color: c.color
                            }));
                            startLoadingScreen(cupState.tracks[cupState.round - 1]);
                        }
                    }, 4000); 
                } else {
                    msgBox.innerHTML = `<span style='color: var(--neon-pink);'>ELIMINATED - FINISHED ${finalPos+1}</span>`;
                    nextBtn.innerText = "Main Menu";
                    nextBtn.setAttribute('data-onclick', 'quitToMenu()');
                    nextBtn.classList.remove('hidden');
                }
            }
        }

        function checkGameEnd() {
            if (gameMode === 'DEMO_MODE') {
                // Loop demo race instead of showing results
                setTimeout(() => {
                    if (attractMode.isActive) {
                        startDemoRace();
                    }
                }, 5000);
                return;
            }
            
            gameState = 'FINISHED';
            audio.updateEngine(0, false);
            audio.setScreech(false);
            audio.stopRain();
            
            racePositions = [...cars].sort((a, b) => {
                let aFinish = finishOrder.indexOf(a);
                let bFinish = finishOrder.indexOf(b);
                if (aFinish !== -1 && bFinish !== -1) return aFinish - bFinish;
                if (aFinish !== -1) return -1;
                if (bFinish !== -1) return 1;
                if (a.lap !== b.lap) return b.lap - a.lap;
                return b.distanceDriven - a.distanceDriven;
            });
            let finalPos = racePositions.findIndex(c => c.isPlayer);
            
            if (finalPos === 0) {
                if (gameMode === 'QUICK_RACE' || (gameMode === 'KNOCKOUT_CUP' && cupState.round === 4)) {
                    audio.playYouWin();
                } else {
                    audio.victory();
                }
            } else {
                audio.victory(); // Or game over sound
            }

            const primaryBtn = document.getElementById('result-primary-btn');
            const secondaryBtn = document.getElementById('result-secondary-btn');
            const podium = document.getElementById('podium-container');
            
            if (gameMode === 'QUICK_RACE' || gameMode === 'TIME_TRIAL') {
                let suffixes = ["1st", "2nd", "3rd"];
                let posText = suffixes[finalPos] || (finalPos + 1) + "th";
                
                if (gameMode === 'TIME_TRIAL') {
                    if (podium) podium.innerHTML = '';
                    if (primaryBtn) {
                        primaryBtn.textContent = 'Retry Time Trial';
                        primaryBtn.setAttribute('data-onclick', 'startTimeTrial(currentMapIndex)');
                    }
                    if (secondaryBtn) {
                        secondaryBtn.textContent = 'Back to Maps';
                        secondaryBtn.setAttribute('data-onclick', 'openMapsMenu()');
                    }
                } else {
                    buildPodium();
                    if (primaryBtn) {
                        primaryBtn.textContent = 'Race Again';
                        primaryBtn.setAttribute('data-onclick', 'startLoadingScreen(currentMapIndex)');
                    }
                    if (secondaryBtn) {
                        secondaryBtn.textContent = 'Main Menu';
                        secondaryBtn.setAttribute('data-onclick', 'quitToMenu()');
                    }
                }

                setTimeout(() => {
                    screens.classList.remove('hidden');
                    screens.classList.remove('drone-overlay-mode');
                    document.querySelectorAll('.screen-panel').forEach(p => p.classList.add('hidden'));
                    document.getElementById('game-over-screen').classList.remove('hidden');
                    uiLayer.classList.add('hidden');
                    
                    const title = document.getElementById('result-title');
                    title.textContent = gameMode === 'TIME_TRIAL' ? 'TIME TRIAL COMPLETE' : (finalPos === 0 ? "VICTORY!" : "RACE OVER");
                    title.style.color = gameMode === 'TIME_TRIAL' ? "var(--neon-green)" : (finalPos === 0 ? "var(--neon-yellow)" : "var(--neon-pink)");
                    title.style.textShadow = `0 0 20px ${title.style.color}`;
                    
                    if (gameMode === 'TIME_TRIAL') {
                        document.getElementById('result-stats').innerHTML = `
                            Track: <strong style="color:var(--neon-blue)">${mapsData[currentMapIndex].name}</strong><br>
                            Total Time: <strong style="color:var(--neon-green)">${timeVal.textContent}</strong><br>
                            Best Lap: <strong style="color:var(--neon-yellow)">${document.getElementById('best-lap-val').textContent}</strong>
                        `;
                    } else {
                        document.getElementById('result-stats').innerHTML = `
                            Finished: <strong style="color:var(--neon-blue)">${posText} Place</strong><br>
                            Total Time: <strong style="color:var(--neon-green)">${timeVal.textContent}</strong>
                        `;
                    }
                }, 2000);
            } else if (gameMode === 'GRAND_PRIX') {
                updateGPStandings();
                setTimeout(() => {
                    showGPStandings();
                }, 2000);
            } else if (gameMode === 'KNOCKOUT_CUP') {
                let cutoff = 10;
                if(cupState.round === 2) cutoff = 7;
                if(cupState.round === 3) cutoff = 3;
                if(cupState.round === 4) cutoff = 1;
                
                let playerAdvanced = finalPos < cutoff;
                let advanced = racePositions.slice(0, cutoff);
                let eliminated = racePositions.slice(cutoff);
                
                setTimeout(() => {
                    showEliminationScreen(advanced, eliminated, playerAdvanced, finalPos);
                }, 2000);
            }
        }

        function gameLoop() {
            if (gameState !== 'PAUSED') {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                if (gameState === 'INTRO_PAN') {
                    let p = (Date.now() - introPanStartTime) / introPanDuration;
                    if (p >= 1) {
                        gameState = 'PRE_RACE_SILENCE';
                        introSilenceStartTime = Date.now();
                        camera.x = panEndX; 
                        camera.y = panEndY;
                    } else {
                        // easeInOutCubic curve for smooth panning
                        let ease = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; 
                        camera.x = panStartX + (panEndX - panStartX) * ease;
                        camera.y = panStartY + (panEndY - panStartY) * ease;
                    }
                } else if (gameState === 'PRE_RACE_SILENCE') {
                    if (Date.now() - introSilenceStartTime >= 3000) {
                        startCountdown();
                    }
                } else if (gameState === 'OPEN_WORLD') {
                    // Open world mode camera and updates
                    if (player) {
                        let targetCamX = player.x - canvas.width / 2;
                        let targetCamY = player.y - canvas.height / 2;
                        camera.x += (targetCamX - camera.x) * 0.1;
                        camera.y += (targetCamY - camera.y) * 0.1;
                        
                        // Update player car (only if not mid-transition)
                        if (openWorldMode.transitionDir === 0) {
                            player.update(keys);
                        }

                        // Update traffic
                        updateTraffic();
                        
                        // Update coins
                        updateWorldCoins();
                        
                        // Update HUD
                        updateOpenWorldHUD();

                        // Update seamless region transition
                        updateOpenWorldTransition();

                        // Detect region transitions
                        const newRegion = detectRegionBoundary();
                        if (newRegion) {
                            handleRegionTransition(newRegion);
                        }
                    }
                } else if (player) {
                    let targetCar = player;
                    if (gameMode === 'LOCAL_MULTIPLAYER' && player2) {
                        // For camera shake logic, just use player 1 as reference
                        targetCar = player;
                    } else {
                        targetCar = spectateTarget !== -1 ? cars[spectateTarget] : player;
                        let weightSum = 3, avgX = targetCar.x * 3, avgY = targetCar.y * 3;
                        cars.forEach(car => {
                            if (car !== targetCar) {
                                if (dist2(targetCar, car) < 640000) { avgX += car.x; avgY += car.y; weightSum += 1; }
                            }
                        });
                        let targetCamX = (avgX / weightSum) - canvas.width / 2;
                        let targetCamY = (avgY / weightSum) - canvas.height / 2;
                        camera.x += (targetCamX - camera.x) * 0.1;
                        camera.y += (targetCamY - camera.y) * 0.1;
                    }
                    
                    // --- CAMERA SHAKE SYSTEM ---
                    if (targetCar && targetCar.nitroActive) cameraShake = Math.max(cameraShake, 3);
                    if (cameraShake > 0) {
                        cameraShakeX = (Math.random() - 0.5) * cameraShake;
                        cameraShakeY = (Math.random() - 0.5) * cameraShake;
                        cameraShake *= 0.9;
                        if (cameraShake < 0.5) cameraShake = 0;
                    } else {
                        cameraShakeX = 0; cameraShakeY = 0;
                    }
                } else if (gameState === 'DRONE_VIEW') {
                    updateDroneControls();
                } else if (gameState === 'TRACK_EDITOR') {
                    updateEditorControls();
                }

                if (gameState === 'PLAYING' || gameState === 'FINISHED') {
                    fx.update();
                    updateItems();
                    cars.forEach(car => car.update(keys));
                    
                    // Disable race sounds during demo mode (menu music only)
                    if (gameMode === 'DEMO_MODE') {
                        audio.updateEngine(0, false);
                        audio.setScreech(false);
                    }
                    
                    if (gameMode === 'MULTIPLAYER' && gameState === 'PLAYING') {
                        syncMultiplayerState();
                    }
                    
                    if (gameState === 'PLAYING' && raceEndTime) {
                        if (Date.now() >= raceEndTime || finishOrder.length === cars.length) {
                            checkGameEnd();
                        }
                    }
                }

                
                if (gameState === 'TRACK_EDITOR') {
                    editorDrawOverlay();
                }

                if (gameState !== 'MENU' && gameState !== 'CAR_SELECT' && gameState !== 'RACE_SETUP' && gameState !== 'MAP_SELECT' && gameState !== 'ASSET_LOADING' && gameState !== 'TRACK_EDITOR') {
                    const renderScene = (p, viewX, viewY, viewW, viewH, options = {}) => {
                        ctx.save();
                        // 1. Clipping and Viewport Setup
                        ctx.beginPath();
                        ctx.rect(viewX, viewY, viewW, viewH);
                        ctx.clip();
                        ctx.translate(viewX, viewY);

                        // 2. Fill Viewport Background
                        if (gameState === 'OPEN_WORLD' || options.isOpenWorldDrone) {
                            // Dark neutral fill — biome gradients paint over this
                            ctx.fillStyle = '#1a1c20';
                            ctx.fillRect(0, 0, viewW, viewH);
                        } else {
                            let map = mapsData[currentMapIndex];
                            if (map) {
                                ctx.fillStyle = (typeof window.mapVariant !== 'undefined' && window.mapVariant === 'NIGHT') ? '#050510' : map.theme.bgOuter;
                                ctx.fillRect(0, 0, viewW, viewH);
                            }
                        }

                        // 3. Camera Calculation
                        let zoom = options.zoom || 1;
                        let camX = 0, camY = 0;
                        if (options.overrideCamera) {
                            camX = options.cameraX;
                            camY = options.cameraY;
                        } else if (gameState === 'INTRO_PAN') {
                            camX = camera.x; camY = camera.y;
                        } else if (p) {
                            let targetCar = p;
                            let weightSum = 3, avgX = targetCar.x * 3, avgY = targetCar.y * 3;
                            cars.forEach(car => {
                                if (car !== targetCar) {
                                    if (dist2(targetCar, car) < 640000) { avgX += car.x; avgY += car.y; weightSum += 1; }
                                }
                            });
                            camX = (avgX / weightSum) - viewW / (2 * zoom);
                            camY = (avgY / weightSum) - viewH / (2 * zoom);
                        }

                        // 4. Apply Camera Shake
                        let sx = 0, sy = 0;
                        if (!options.disableShake && p && (p.nitroActive || p.miniTurboTimer > 0)) {
                            let shake = 3;
                            sx = (Math.random() - 0.5) * shake;
                            sy = (Math.random() - 0.5) * shake;
                        }

                        let useHeadingFollow = !options.overrideCamera && gameMode !== 'LOCAL_MULTIPLAYER' && gameState !== 'INTRO_PAN' && !!p;
                        let targetRotation = useHeadingFollow ? getHeadingFollowCameraRotation(p) : 0;
                        camera.rotation += normalizeAngle(targetRotation - (camera.rotation || 0)) * (useHeadingFollow ? 0.12 : 0.08);
                        if (Math.abs(camera.rotation) < 0.0005) camera.rotation = 0;

                        // 5. Draw Track (temporarily override global camera)
                        let oldCam = {x: camera.x, y: camera.y, viewWidth: camera.viewWidth, viewHeight: camera.viewHeight, zoom: camera.zoom};
                        camera.x = camX + sx; camera.y = camY + sy;
                        camera.viewWidth = viewW / zoom;
                        camera.viewHeight = viewH / zoom;
                        camera.zoom = zoom;
                        ctx.translate(viewW / 2, viewH / 2);
                        if (camera.rotation) ctx.rotate(camera.rotation);
                        ctx.scale(zoom, zoom);
                        ctx.translate(-viewW / (2 * zoom), -viewH / (2 * zoom));
                        
                        // For open world gameplay and world drone view: draw biome terrain + highways before track
                        if (gameState === 'OPEN_WORLD' || options.isOpenWorldDrone) {
                            drawOpenWorldBackground(camera.x, camera.y);
                            // In drone view also draw each region's track circuit at its world position
                            if (options.isOpenWorldDrone) {
                                openWorldData.regions.forEach(region => {
                                    if (region.mapIndex < 0 || !mapsData[region.mapIndex]) return;
                                    const map = mapsData[region.mapIndex];
                                    const wps = map.waypoints;
                                    const rx = region.position.x - camera.x;
                                    const ry = region.position.y - camera.y;
                                    // Biome circle glow behind track
                                    const grad = ctx.createRadialGradient(rx, ry, 0, rx, ry, 14000);
                                    grad.addColorStop(0, hexToRgba(region.biomeColor, 0.45));
                                    grad.addColorStop(1, hexToRgba(region.biomeColor, 0));
                                    ctx.fillStyle = grad;
                                    ctx.beginPath(); ctx.arc(rx, ry, 14000, 0, Math.PI * 2); ctx.fill();
                                    // Track circuit
                                    ctx.save();
                                    ctx.translate(region.position.x - camera.x, region.position.y - camera.y);
                                    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
                                    ctx.lineWidth = 900;
                                    ctx.strokeStyle = hexToRgba(map.theme.border || '#ffffff', 0.5);
                                    ctx.beginPath();
                                    ctx.moveTo(wps[0].x, wps[0].y);
                                    for (let i = 1; i < wps.length; i++) ctx.lineTo(wps[i].x, wps[i].y);
                                    ctx.closePath(); ctx.stroke();
                                    ctx.lineWidth = 600;
                                    ctx.strokeStyle = map.theme.track || '#222222';
                                    ctx.stroke();
                                    ctx.restore();
                                    // Region name label
                                    ctx.save();
                                    ctx.font = 'bold 1800px Orbitron, monospace';
                                    ctx.fillStyle = hexToRgba(region.mmColor || '#ffffff', 0.9);
                                    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                                    ctx.shadowColor = region.mmColor || '#ffffff'; ctx.shadowBlur = 600;
                                    ctx.fillText(region.name.toUpperCase(), region.position.x - camera.x, region.position.y - camera.y - 9000);
                                    ctx.shadowBlur = 0;
                                    ctx.restore();
                                });
                            }
                        }
                        if (!options.isOpenWorldDrone) drawTrack();
                        
                        camera.x = oldCam.x; camera.y = oldCam.y;
                        camera.viewWidth = oldCam.viewWidth;
                        camera.viewHeight = oldCam.viewHeight;
                        camera.zoom = oldCam.zoom;
                        ctx.restore();
                    };

                    if (gameMode === 'LOCAL_MULTIPLAYER' && player2) {
                        renderScene(player, 0, 0, canvas.width, canvas.height / 2);
                        renderScene(player2, 0, canvas.height / 2, canvas.width, canvas.height / 2);
                        // Draw separator line
                        ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
                        ctx.beginPath(); ctx.moveTo(0, canvas.height / 2); ctx.lineTo(canvas.width, canvas.height / 2); ctx.stroke();
                    } else if (gameState === 'DRONE_VIEW') {
                        renderScene(null, 0, 0, canvas.width, canvas.height, {
                            overrideCamera: true,
                            cameraX: droneView.centerX - canvas.width / (2 * droneView.zoom),
                            cameraY: droneView.centerY - canvas.height / (2 * droneView.zoom),
                            zoom: droneView.zoom,
                            disableShake: true,
                            isOpenWorldDrone: isOpenWorldDroneView
                        });
                    } else {
                        renderScene(player, 0, 0, canvas.width, canvas.height);
                    }

                    drawWeatherOverlay();

                    if(gameState === 'PLAYING' || gameState === 'FINISHED' || gameState === 'COUNTDOWN') drawMinimap();

                    // Open world overlays: minimap + seamless transition fade
                    if (gameState === 'OPEN_WORLD') {
                        drawMinimap();
                        drawOpenWorldTransitionOverlay();
                    }
                    
                    const drawItemHUD = (p, x, y) => {
                        ctx.save(); ctx.setTransform(1,0,0,1,0,0);
                        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
                        ctx.beginPath(); ctx.roundRect(x - 40, y - 40, 80, 80, 10); ctx.fill(); ctx.stroke();
                        if (p.itemRouletteTimer > 0) {
                            ctx.fillStyle = '#ff00ea'; ctx.font = 'bold 40px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                            let items = ['?', '!', '*', '#'];
                            ctx.fillText(items[Math.floor(Date.now() / 50) % items.length], x, y);
                        } else if (p.item) {
                            ctx.fillStyle = '#00f3ff'; ctx.font = 'bold 16px Orbitron'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                            ctx.fillText(p.item, x, y);
                        }
                        ctx.restore();
                    };

                    if (gameState === 'PLAYING') {
                        drawItemHUD(player, canvas.width - 80, 80);
                        if (gameMode === 'LOCAL_MULTIPLAYER' && player2) {
                            drawItemHUD(player2, canvas.width - 80, canvas.height / 2 + 80);
                        }
                    }
                    updateHUD();

                    if (gameState === 'FINISHED') {
                        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
                        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.fillStyle = '#fbc531'; ctx.font = '900 80px "Orbitron"';
                        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                        ctx.shadowColor = '#fbc531'; ctx.shadowBlur = 30;
                        ctx.fillText('FINISH!', canvas.width / 2, canvas.height / 2 - 30);
                        ctx.restore();
                    }
                }
            }
            requestAnimationFrame(gameLoop);
        }

        // Add Chrome Extension CSP workaround for inline onclicks
        const clickFuncMap = {
            'openLocalMultiplayer': () => openLocalMultiplayer(),
            'openQuickRace': () => openQuickRace(),
            'openMapsMenu': () => openMapsMenu(),
            'openGrandPrix': () => openGrandPrix(),
            'openKnockoutCup': () => openKnockoutCup(),
            'openMultiplayerMenu': () => openMultiplayerMenu(),
            'openMusicPlayer': () => openMusicPlayer(),
            'openUpgradeShop': () => openUpgradeShop(),
            'openSettings': () => openSettings(),
            'loginWithGoogle': () => loginWithGoogle(),
            'hostGame': () => hostGame(),
            'joinGame': () => joinGame(),
            'openMainMenu': () => openMainMenu(),
            'startMultiplayerGame': () => startMultiplayerGame(),
            'leaveLobby': () => leaveLobby(),
            'audio.startMusic': (track) => audio.startMusic(track),
            'audio.stopMusic': () => audio.stopMusic(),
            'buyUpgrade': (type) => buyUpgrade(type),
            'setLaps': (n, btn) => setLaps(n, btn),
            'setDifficulty': (diff, btn) => setDifficulty(diff, btn),
            'setWeather': (w, btn) => setWeather(w, btn),
            'setCarEffect': (effect, btn) => setCarEffect(effect, btn),
            'openCarSelect': () => openCarSelect(),
            'selectCar': (index) => selectCar(index),
            'handleCarSelectNext': () => handleCarSelectNext(),
            'changeOpponents': (delta) => changeOpponents(delta),
            'openMapSelect': () => openMapSelect(),
            'openRaceSetup': () => openRaceSetup(),
            'gpNextRace': () => gpNextRace(),
            'quitToMenu': () => quitToMenu(),
            'togglePause': () => togglePause(),
            'startLoadingScreen': (mapIndex) => startLoadingScreen(mapIndex),
            'startTimeTrial': (mapIndex) => startTimeTrial(mapIndex),
            'startDroneView': (mapIndex) => startDroneView(mapIndex),
            'exitDroneView': () => exitDroneView(),
            'fitDroneView': () => fitDroneView(),
            'adjustDroneZoom': (multiplier) => adjustDroneZoom(multiplier),
            'handleStartLoading': () => handleStartLoading(),
            'editorEditCustomTrack': (index) => editorEditCustomTrack(index),
            'openOpenWorld': () => openOpenWorld(),
            'openOpenWorldDroneView': () => openOpenWorldDroneView()
        };

        function getEventTargetElement(target) {
            if (target instanceof Element) return target;
            if (target && target.parentElement instanceof Element) return target.parentElement;
            return null;
        }

        function handleDelegatedDataClick(e) {
            const targetEl = getEventTargetElement(e.target);
            if (!targetEl) return;
            let btn = targetEl.closest('[data-onclick]');
            if (!btn) return;
            
            let clickStr = btn.getAttribute('data-onclick');
            if (!clickStr) return;
            let match = clickStr.match(/^([a-zA-Z0-9_.]+)\((.*)\)$/);
            if (match) {
                let funcName = match[1];
                let rawArgs = match[2] ? match[2].split(',').map(s => s.trim()) : [];
                let args = rawArgs.map(arg => {
                    if (!arg) return undefined;
                    if (arg === 'this') return btn;
                    if (arg === 'currentMapIndex') return typeof currentMapIndex !== 'undefined' ? currentMapIndex : 0;
                    if (arg.startsWith("'") && arg.endsWith("'")) return arg.slice(1, -1);
                    if (!isNaN(arg) && arg !== '') return Number(arg);
                    return arg;
                }).filter(a => a !== undefined);
                
                if (clickFuncMap[funcName]) {
                    clickFuncMap[funcName].apply(null, args);
                } else {
                    console.error('Function not found for data-onclick:', funcName);
                }
            }
        }

        function handleDelegatedDataChange(e) {
            const targetEl = getEventTargetElement(e.target);
            if (!targetEl) return;
            let el = targetEl.closest('[data-onchange]');
            if (!el) return;
            let changeStr = el.getAttribute('data-onchange');
            if (changeStr === 'updateCustomColor(this.value)') {
                if (typeof updateCustomColor === 'function') updateCustomColor(el.value);
            }
        }

        document.addEventListener('click', handleDelegatedDataClick);
        document.addEventListener('change', handleDelegatedDataChange);

        try {
            injectCustomTracksIntoMapsData();
        } catch (error) {
            console.error('Custom track injection failed:', error);
        }

        try {
            generateCarSelection();
        } catch (error) {
            console.error('Initial car selection generation failed:', error);
        }

        try {
            generateMapThumbnails();
        } catch (error) {
            console.error('Initial map thumbnail generation failed:', error);
        }

        bindStartLoadingButton();
        bindGlobalStartupCapture();

        requestAnimationFrame(gameLoop);
