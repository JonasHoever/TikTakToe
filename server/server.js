const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const wss = new WebSocket.Server({ noServer: true });

const games = new Map(); // Speichert aktive Spiele: {gameId: {players: [], board: [], turn: '', status: '', type: 'custom'|'matchmaking', creatorId: '', rematchOffers: {}, lastActivity: Date}}
let gameCounter = 0;     // Einfacher Zähler für Spiel-IDs

const matchmakingQueue = []; // Spieler, die auf ein Matchmaking-Spiel warten: [{ws: WebSocket, id: string}]

// --- Hilfsfunktionen für den Server ---

// Sendet eine Nachricht an alle Spieler in einem spezifischen Spiel
function broadcastToGame(gameId, message) {
    const game = games.get(gameId);
    if (game) {
        game.players.forEach(player => {
            if (player.ws && player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(JSON.stringify(message));
            }
        });
    }
}

// Sendet eine Nachricht an alle verbundenen Clients (für Lobby-Updates)
function broadcastToAll(message) {
    wss.clients.forEach(clientWs => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify(message));
        }
    });
}

// Gibt eine Liste der verfügbaren Custom Games zurück
function getAvailableCustomGames() {
    const availableGames = [];
    const now = Date.now();
    games.forEach((game, gameId) => {
        const fiveMinutes = 5 * 60 * 1000;
        // Nur Custom Games, die auf einen zweiten Spieler warten
        if (game.type === 'custom' && game.status === 'waiting' && game.players.length === 1 && (now - game.lastActivity) < fiveMinutes) {
            availableGames.push({
                gameId: gameId,
                creatorId: game.players[0].id,
                playerCount: game.players.length
            });
        }
    });
    return availableGames;
}

// Sendet die aktuelle Lobby-Liste an einen spezifischen Client
function sendLobbyToClient(clientWs) {
    if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'lobbyUpdate', games: getAvailableCustomGames() }));
    }
}

// Aktualisiert die Lobby für alle Clients
function updateLobby() {
    broadcastToAll({ type: 'lobbyUpdate', games: getAvailableCustomGames() });
}

// Überprüft, ob ein Spieler gewonnen hat
function checkWinner(board) {
    const winConditions = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8], // Reihen
        [0, 3, 6], [1, 4, 7], [2, 5, 8], // Spalten
        [0, 4, 8], [2, 4, 6]             // Diagonalen
    ];

    for (let i = 0; i < winConditions.length; i++) {
        const [a, b, c] = winConditions[i];
        if (board[a] && board[a] === board[b] && board[a] === board[c]) {
            return board[a];
        }
    }
    return null;
}

// --- Matchmaking-Logik ---
function processMatchmakingQueue() {
    // Filtere disconnected Spieler aus der Warteschlange
    for (let i = matchmakingQueue.length - 1; i >= 0; i--) {
        if (matchmakingQueue[i].ws.readyState !== WebSocket.OPEN) {
            console.log(`Disconnected player ${matchmakingQueue[i].id} removed from queue.`);
            matchmakingQueue.splice(i, 1);
        }
    }

    if (matchmakingQueue.length >= 2) {
        // Nehme die ersten beiden Spieler aus der Warteschlange
        const player1Entry = matchmakingQueue.shift();
        const player2Entry = matchmakingQueue.shift();

        // Überprüfe erneut, ob Spieler noch verbunden sind (falls sie kurz nach dem Hinzufügen disconnected sind)
        if (player1Entry.ws.readyState !== WebSocket.OPEN || player2Entry.ws.readyState !== WebSocket.OPEN) {
            console.log("One or both matchmaking players disconnected during match finding. Attempting to re-queue valid players.");
            if (player1Entry.ws.readyState === WebSocket.OPEN) {
                // Wenn player1 noch verbunden ist, aber player2 nicht, sende player1 zurück in die Queue
                matchmakingQueue.unshift(player1Entry); // Ganz vorne rein, damit er schnell einen neuen Partner findet
                player1Entry.ws.send(JSON.stringify({ type: 'matchmakingQueued', message: 'Dein potenzieller Gegner hat die Verbindung verloren. Warte weiterhin auf einen Gegner...' }));
            }
            if (player2Entry.ws.readyState === WebSocket.OPEN) {
                 // Wenn player2 noch verbunden ist, aber player1 nicht
                 matchmakingQueue.unshift(player2Entry);
                 player2Entry.ws.send(JSON.stringify({ type: 'matchmakingQueued', message: 'Dein potenzieller Gegner hat die Verbindung verloren. Warte weiterhin auf einen Gegner...' }));
            }
            return; // Versuche es im nächsten Intervall erneut
        }

        const gameId = `game_${gameCounter++}`;
        const startingPlayerSymbol = (Math.random() < 0.5) ? 'X' : 'O';

        // Spieler-Symbole zuweisen
        const playerX = startingPlayerSymbol === 'X' ? player1Entry : player2Entry;
        const playerO = startingPlayerSymbol === 'O' ? player1Entry : player2Entry;

        const game = {
            players: [
                { ws: playerX.ws, id: playerX.id, symbol: 'X', isConnected: true },
                { ws: playerO.ws, id: playerO.id, symbol: 'O', isConnected: true }
            ],
            board: Array(9).fill(null),
            turn: 'X', // Der erste Zug ist immer 'X'
            status: 'playing',
            type: 'matchmaking',
            creatorId: playerX.id, // Der Spieler, der 'X' ist
            rematchOffers: {},
            lastActivity: Date.now()
        };
        games.set(gameId, game);

        // Weise den WebSocket-Objekten die Spiel- und Spieler-ID zu
        playerX.ws.gameId = gameId;
        playerX.ws.playerId = playerX.id;
        playerO.ws.gameId = gameId;
        playerO.ws.playerId = playerO.id;

        // Informiere beide Spieler, dass sie ein Match gefunden haben
        playerX.ws.send(JSON.stringify({ type: 'matchFound', gameId: gameId, symbol: 'X', board: game.board, turn: game.turn }));
        playerO.ws.send(JSON.stringify({ type: 'matchFound', gameId: gameId, symbol: 'O', board: game.board, turn: game.turn }));

        console.log(`Matchmaking game ${gameId} started between ${playerX.id} (X) and ${playerO.id} (O).`);
        // updateLobby() ist hier nicht nötig, da Matchmaking-Spiele nicht in der Lobby erscheinen
    }
}

// Führe Matchmaking regelmäßig aus
setInterval(processMatchmakingQueue, 2000); // Alle 2 Sekunden prüfen

// --- WebSocket-Verwaltung ---

wss.on('connection', ws => {
    // Jedem neuen WebSocket eine temporäre ID zuweisen.
    ws.id = Math.random().toString(36).substring(2, 15);
    console.log(`Client connected with temporary ID: ${ws.id}`);

    ws.on('message', message => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Invalid JSON received:', message);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format.' }));
            return;
        }

        console.log('Received:', data);

        const clientPlayerId = data.playerId;
        const clientGameId = data.gameId;

        // Sicherstellen, dass die WebSocket-Instanz die aktuelle Spieler- und Spiel-ID kennt
        if (clientPlayerId) {
            ws.playerId = clientPlayerId;
        }
        if (clientGameId) {
            ws.gameId = clientGameId;
        }

        switch (data.type) {
            case 'createGame': // Erstellt eine private Lobby (Custom Game)
                const newPlayerId_create = clientPlayerId || 'player_' + Math.random().toString(36).substring(2, 10);
                const gameId_create = `game_${gameCounter++}`;

                // Spieler-Info im WebSocket speichern
                ws.playerId = newPlayerId_create;
                ws.gameId = gameId_create;

                games.set(gameId_create, {
                    players: [{ ws: ws, id: newPlayerId_create, symbol: 'X', isConnected: true }],
                    board: Array(9).fill(null),
                    turn: 'X', // Ersteller ist immer 'X' und beginnt
                    status: 'waiting',
                    type: 'custom',
                    creatorId: newPlayerId_create,
                    rematchOffers: {},
                    lastActivity: Date.now()
                });

                ws.send(JSON.stringify({ type: 'gameCreated', gameId: gameId_create, symbol: 'X', playerId: newPlayerId_create }));
                console.log(`Custom Game ${gameId_create} created by ${newPlayerId_create}`);
                updateLobby();
                break;

            case 'joinGame': // Beitritt zu einem Custom Game oder Reconnect
                if (!clientGameId || !clientPlayerId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Missing game ID or player ID to join.' }));
                    return;
                }

                const gameToJoin = games.get(clientGameId);

                if (!gameToJoin || gameToJoin.type !== 'custom') { // Nur Custom Games beitreten
                    ws.send(JSON.stringify({ type: 'error', message: 'Custom Game not found or is a matchmaking game.' }));
                    return;
                }

                // Spieler-Info im WebSocket speichern
                ws.playerId = clientPlayerId;
                ws.gameId = clientGameId;

                const existingPlayer_join = gameToJoin.players.find(p => p.id === clientPlayerId);

                if (existingPlayer_join) {
                    // Reconnect: WebSocket-Objekt aktualisieren
                    existingPlayer_join.ws = ws;
                    existingPlayer_join.isConnected = true;
                    gameToJoin.lastActivity = Date.now();

                    ws.send(JSON.stringify({
                        type: 'reconnected',
                        gameId: clientGameId,
                        symbol: existingPlayer_join.symbol, // Wichtig: eigenes Symbol mitsenden!
                        board: gameToJoin.board,
                        turn: gameToJoin.turn,
                        status: gameToJoin.status
                    }));
                    console.log(`Player ${clientPlayerId} reconnected to game ${clientGameId}.`);
                    const opponent = gameToJoin.players.find(p => p.id !== clientPlayerId);
                    if (opponent && opponent.ws && opponent.ws.readyState === WebSocket.OPEN) {
                         opponent.ws.send(JSON.stringify({ type: 'opponentReconnected', playerSymbol: existingPlayer_join.symbol }));
                    }
                    return;
                }

                // Normaler Beitreten-Vorgang für einen neuen Spieler (nur wenn 1 Spieler wartet)
                if (gameToJoin.players.length === 1 && gameToJoin.status === 'waiting') {
                    gameToJoin.players.push({ ws: ws, id: clientPlayerId, symbol: 'O', isConnected: true });
                    gameToJoin.status = 'playing';
                    gameToJoin.lastActivity = Date.now();

                    // Sende dem *beitretenden* Spieler sein Symbol und den Spielzustand
                    ws.send(JSON.stringify({ type: 'gameJoined', gameId: clientGameId, symbol: 'O', board: gameToJoin.board, turn: gameToJoin.turn, status: gameToJoin.status }));
                    // Sende dem *ersten* Spieler den aktualisierten Spielzustand (inkl. Gegnerinfo)
                    const player1 = gameToJoin.players.find(p => p.symbol === 'X');
                    if (player1 && player1.ws && player1.ws.readyState === WebSocket.OPEN) {
                        player1.ws.send(JSON.stringify({ type: 'opponentJoined', gameId: clientGameId, board: gameToJoin.board, turn: gameToJoin.turn, status: gameToJoin.status }));
                    }

                    console.log(`Player ${clientPlayerId} joined Custom Game ${clientGameId}`);
                    updateLobby();
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Custom Game is full or not in waiting state.' }));
                }
                break;

            case 'requestMatchmaking': // Spieler will Matchmaking starten
                if (!clientPlayerId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Missing player ID for matchmaking.' }));
                    return;
                }

                // Prüfen, ob Spieler bereits in einem Spiel ist oder in der Warteschlange
                let inActiveGameOrQueue = false;
                games.forEach(g => {
                    if (g.players.some(p => p.id === clientPlayerId) && g.status !== 'finished') {
                        inActiveGameOrQueue = true;
                    }
                });
                const alreadyInQueue = matchmakingQueue.some(p => p.id === clientPlayerId);

                if (inActiveGameOrQueue || alreadyInQueue) {
                    ws.send(JSON.stringify({ type: 'error', message: 'You are already in an active game or in the matchmaking queue. Please finish/leave or cancel first.' }));
                    return;
                }

                // Spieler zur Warteschlange hinzufügen
                matchmakingQueue.push({ ws: ws, id: clientPlayerId });
                ws.playerId = clientPlayerId; // Setze playerId für diesen WS
                ws.send(JSON.stringify({ type: 'matchmakingQueued', message: 'Du wurdest zur Matchmaking-Warteschlange hinzugefügt. Warte auf einen Gegner...' }));
                console.log(`Player ${clientPlayerId} joined matchmaking queue. Queue size: ${matchmakingQueue.length}`);
                processMatchmakingQueue(); // Versuche sofort, ein Match zu finden
                break;

            case 'cancelMatchmaking': // Spieler will Matchmaking abbrechen
                const indexInQueue = matchmakingQueue.findIndex(p => p.id === clientPlayerId);
                if (indexInQueue !== -1) {
                    matchmakingQueue.splice(indexInQueue, 1);
                    ws.send(JSON.stringify({ type: 'matchmakingCancelled', message: 'Matchmaking abgebrochen.' }));
                    console.log(`Player ${clientPlayerId} cancelled matchmaking. Queue size: ${matchmakingQueue.length}`);
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Not in matchmaking queue.' }));
                }
                break;

            case 'makeMove':
                if (!ws.gameId || !ws.playerId || typeof data.index !== 'number' || data.index < 0 || data.index > 8) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid move data.' }));
                    return;
                }

                const gameMove = games.get(ws.gameId);
                if (!gameMove) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Game not found for move.' }));
                    return;
                }

                const currentPlayer = gameMove.players.find(p => p.id === ws.playerId);
                if (!currentPlayer || !currentPlayer.isConnected) {
                    ws.send(JSON.stringify({ type: 'error', message: 'You are not an active player in this game.' }));
                    return;
                }

                if (gameMove.status !== 'playing' || gameMove.turn !== currentPlayer.symbol) {
                    ws.send(JSON.stringify({ type: 'error', message: 'It is not your turn or game is not active.' }));
                    return;
                }

                const index = data.index;
                if (gameMove.board[index] !== null) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Cell already taken.' }));
                    return;
                }

                gameMove.board[index] = currentPlayer.symbol;
                gameMove.turn = (currentPlayer.symbol === 'X') ? 'O' : 'X';
                gameMove.lastActivity = Date.now();

                const winner = checkWinner(gameMove.board);
                if (winner) {
                    gameMove.status = 'finished';
                    broadcastToGame(ws.gameId, { type: 'gameOver', winner: winner, board: gameMove.board });
                    console.log(`Game ${ws.gameId} finished. Winner: ${winner}`);
                    if (gameMove.type === 'custom') updateLobby();
                } else if (gameMove.board.every(cell => cell !== null)) {
                    gameMove.status = 'finished';
                    broadcastToGame(ws.gameId, { type: 'gameOver', winner: 'draw', board: gameMove.board });
                    console.log(`Game ${ws.gameId} finished. Draw.`);
                    if (gameMove.type === 'custom') updateLobby();
                } else {
                    broadcastToGame(ws.gameId, { type: 'gameState', board: gameMove.board, turn: gameMove.turn, status: gameMove.status });
                }
                break;

            case 'requestLobby':
                sendLobbyToClient(ws);
                break;

            case 'leaveGame':
                if (!ws.gameId || !ws.playerId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Not in a game to leave.' }));
                    return;
                }
                const gameToLeave = games.get(ws.gameId);
                if (gameToLeave) {
                    // Spieler entfernen
                    gameToLeave.players = gameToLeave.players.filter(p => p.id !== ws.playerId);
                    console.log(`Player ${ws.playerId} left game ${ws.gameId}.`);

                    // Wenn es ein Custom Game ist und nur noch 1 Spieler übrig ist
                    if (gameToLeave.type === 'custom' && gameToLeave.players.length === 1) {
                        gameToLeave.status = 'waiting'; // Spiel geht in Wartezustand zurück
                        gameToLeave.lastActivity = Date.now();
                        broadcastToGame(ws.gameId, { type: 'opponentLeft', message: 'Dein Gegner hat das Spiel verlassen. Warte auf einen neuen Spieler.' });
                        updateLobby(); // Aktualisiert die Lobby, da das Spiel wieder verfügbar ist
                    } else if (gameToLeave.players.length === 0 || gameToLeave.type === 'matchmaking') {
                        // Wenn keine Spieler mehr da sind oder es ein Matchmaking-Spiel war, löschen
                        games.delete(ws.gameId);
                        console.log(`Game ${ws.gameId} deleted as all players left or it was a matchmaking game.`);
                        if (gameToLeave.type === 'custom') updateLobby();
                    }
                }
                ws.gameId = null;
                ws.playerId = null; // Wichtig: PlayerId zurücksetzen, damit der Client nicht versucht zu reconnecten
                ws.send(JSON.stringify({ type: 'gameLeft', message: 'Du hast das Spiel verlassen.' }));
                break;

            case 'rematchRequest':
                if (!ws.gameId || !ws.playerId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Not in a game to request rematch.' }));
                    return;
                }
                const gameForRematch = games.get(ws.gameId);
                if (gameForRematch && gameForRematch.status === 'finished') {
                    gameForRematch.rematchOffers[ws.playerId] = true;
                    console.log(`Rematch request from ${ws.playerId} in game ${ws.gameId}`);

                    const opponent = gameForRematch.players.find(p => p.id !== ws.playerId);
                    if (opponent && opponent.ws && opponent.ws.readyState === WebSocket.OPEN) {
                        opponent.ws.send(JSON.stringify({ type: 'rematchOffered', fromPlayerId: ws.playerId }));
                    }

                    const allPlayersOfferedRematch = gameForRematch.players.every(p => gameForRematch.rematchOffers[p.id]);

                    if (allPlayersOfferedRematch) {
                        const newGameId = `game_${gameCounter++}`;
                        const newBoard = Array(9).fill(null);
                        const newTurn = (Math.random() < 0.5) ? 'X' : 'O'; // Zufälliger Startspieler

                        // Spielerrollen für die Revanche tauschen (X wird O, O wird X)
                        // Finde die aktuellen Spieler und weise ihnen neue Symbole zu
                        const player1Current = gameForRematch.players.find(p => p.id === gameForRematch.players[0].id);
                        const player2Current = gameForRematch.players.find(p => p.id === gameForRematch.players[1].id);

                        // Symbole tauschen für Revanche
                        const newPlayers = [
                            { ws: player1Current.ws, id: player1Current.id, symbol: newTurn, isConnected: true },
                            { ws: player2Current.ws, id: player2Current.id, symbol: newTurn === 'X' ? 'O' : 'X', isConnected: true }
                        ];

                        // Sortiere die Spieler nach Symbol, damit 'X' immer an erster Stelle steht
                        newPlayers.sort((a, b) => (a.symbol === 'X' ? -1 : 1));

                        games.set(newGameId, {
                            players: newPlayers,
                            board: newBoard,
                            turn: newTurn,
                            status: 'playing',
                            type: gameForRematch.type, // Behalte den Spieltyp bei (custom/matchmaking)
                            creatorId: newPlayers[0].id, // Der erste Spieler (X) ist der "Ersteller"
                            rematchOffers: {},
                            lastActivity: Date.now()
                        });

                        // Aktualisiere gameId und playerId in den WebSocket-Objekten der Spieler
                        newPlayers.forEach(p => {
                            p.ws.gameId = newGameId;
                            p.ws.playerId = p.id; // Dies sollte bereits korrekt sein
                        });

                        // Informiere beide Spieler über das neue Rematch-Spiel
                        newPlayers.forEach(p => {
                            p.ws.send(JSON.stringify({
                                type: 'rematchAccepted',
                                gameId: newGameId,
                                board: newBoard,
                                turn: newTurn,
                                symbol: p.symbol // Sende jedem Spieler sein neues Symbol
                            }));
                        });

                        console.log(`Rematch accepted for game ${gameForRematch.gameId}. New game: ${newGameId}`);
                        games.delete(gameForRematch.gameId); // Altes Spiel löschen
                        if (gameForRematch.type === 'custom') updateLobby(); // Aktualisiert nur Custom Games
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Rematch not possible for this game.' }));
                }
                break;
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected (Player ID: ${ws.playerId || 'unknown'}, Game ID: ${ws.gameId || 'unknown'})`);

        // Entferne Spieler aus der Matchmaking-Warteschlange, falls vorhanden
        const queueIndex = matchmakingQueue.findIndex(p => p.id === ws.playerId);
        if (queueIndex !== -1) {
            matchmakingQueue.splice(queueIndex, 1);
            console.log(`Player ${ws.playerId} removed from matchmaking queue on disconnect.`);
        }

        if (ws.gameId && ws.playerId) {
            const game = games.get(ws.gameId);
            if (game) {
                const playerEntry = game.players.find(p => p.id === ws.playerId);
                if (playerEntry) {
                    playerEntry.isConnected = false;
                    playerEntry.ws = null; // Referenz auf geschlossenes WebSocket löschen
                    console.log(`Player ${ws.playerId} in game ${ws.gameId} marked as disconnected.`);

                    const opponent = game.players.find(p => p.id !== ws.playerId);
                    if (opponent && opponent.isConnected && opponent.ws && opponent.ws.readyState === WebSocket.OPEN) {
                        opponent.ws.send(JSON.stringify({ type: 'opponentDisconnected', playerSymbol: playerEntry.symbol }));
                    }

                    // Wenn es ein Matchmaking-Spiel war und ein Spieler disconnectet, lösche das Spiel sofort
                    if (game.type === 'matchmaking' && game.status === 'playing') {
                        games.delete(ws.gameId);
                        console.log(`Matchmaking game ${ws.gameId} deleted due to player disconnect.`);
                    }
                }
            }
        }
        updateLobby(); // Aktualisiert nur Custom Games
    });
});

// --- HTTP-Server für statische Dateien ---

const server = http.createServer((req, res) => {
    let filePath = path.join(__dirname, '../public', req.url);

    if (req.url === '/') {
        filePath = path.join(__dirname, '../public', 'index.html');
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
            return;
        }

        let contentType = 'text/html';
        if (filePath.endsWith('.js')) {
            contentType = 'application/javascript';
        } else if (filePath.endsWith('.css')) {
            contentType = 'text/css';
        } else if (filePath.endsWith('.json')) {
            contentType = 'application/json';
        } else if (filePath.endsWith('.png')) {
            contentType = 'image/png';
        } else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
            contentType = 'image/jpeg';
        }

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log(`WebSocket server listening on ws://localhost:${PORT}`);
});

// Regelmäßige Bereinigung alter, ungenutzter Spiele
setInterval(() => {
    const now = Date.now();
    const tenMinutes = 10 * 60 * 1000; // Spiele, die seit 10 Minuten inaktiv sind

    games.forEach((game, gameId) => {
        const allDisconnected = game.players.every(p => !p.isConnected);
        const inactiveTooLong = (now - game.lastActivity) > tenMinutes;

        // Lösche Custom Games, wenn alle Spieler disconnected sind UND/ODER zu lange inaktiv
        if (game.type === 'custom' && (allDisconnected || inactiveTooLong)) {
            games.delete(gameId);
            console.log(`Custom Game ${gameId} cleaned up due to inactivity or all players disconnected.`);
            updateLobby();
        } else if (game.type === 'matchmaking' && game.status === 'finished' && inactiveTooLong) {
            // Beendete Matchmaking-Spiele auch nach einer Weile löschen
             games.delete(gameId);
             console.log(`Finished Matchmaking Game ${gameId} cleaned up due to inactivity.`);
        }
    });
}, 60 * 1000); // Alle 1 Minute überprüfen